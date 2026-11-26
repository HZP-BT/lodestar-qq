import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { nullLogger } from '../src/logger.js';
import { classifyHandshakeStatus, ReverseWsClient } from '../src/onebot/reverse-ws-client.js';
import type { AuthFailureInfo, ReverseWsClientOptions } from '../src/onebot/reverse-ws-client.js';
import { createRejectingServer, createTestServer, isRecord, sleep, waitFor } from './helpers.js';
import type { RejectingServer, TestServer } from './helpers.js';

const clients: ReverseWsClient[] = [];
const servers: TestServer[] = [];
const rejectingServers: RejectingServer[] = [];

afterEach(async () => {
  await Promise.all(clients.map(async (client) => client.stop()));
  clients.length = 0;

  await Promise.all(servers.map(async (server) => server.close()));
  servers.length = 0;

  await Promise.all(rejectingServers.map(async (server) => server.close()));
  rejectingServers.length = 0;
});

function makeClient(
  server: { url: string },
  overrides: Partial<ReverseWsClientOptions> = {},
): ReverseWsClient {
  const client = new ReverseWsClient({
    url: server.url,
    selfId: 10001,
    accessToken: 'test-token',
    logger: nullLogger,
    reconnect: { enabled: false },
    heartbeat: { enabled: false },
    loginProvider: () => 'LOGGED_IN',
    ...overrides,
  });

  clients.push(client);
  return client;
}

function isLifecycleConnect(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.post_type === 'meta_event' &&
    message.meta_event_type === 'lifecycle' &&
    message.sub_type === 'connect'
  );
}

describe('ReverseWsClient', () => {
  it('connects with the headers aiocqhttp requires', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    const headers = server.connections[0]!.headers;
    expect(headers.authorization).toBe('Bearer test-token');
    expect(headers['x-self-id']).toBe('10001');
    expect(headers['x-client-role']).toBe('Universal');
    expect(headers['user-agent']).toMatch(/^lodestar-qq\//);
  });

  it('sends a lifecycle connect event after opening', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.start();

    await server.waitForMessage(isLifecycleConnect);
  });

  it('dispatches an action and preserves the echo object exactly', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.registerAction('get_login_info', () => ({
      user_id: 10001,
      nickname: 'Lodestar',
    }));
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    server.send({
      action: 'get_login_info',
      params: {},
      echo: { seq: 7 },
    });

    const response = await server.waitForMessage(
      (message) => isRecord(message) && isRecord(message.echo) && message.echo.seq === 7,
    );

    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { user_id: 10001, nickname: 'Lodestar' },
      echo: { seq: 7 },
    });
  });

  it('returns 1404 for an action that is not registered', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    server.send({ action: 'set_group_ban', params: {}, echo: 'missing-1' });

    const response = await server.waitForMessage(
      (message) => isRecord(message) && message.echo === 'missing-1',
    );

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1404,
      data: null,
      echo: 'missing-1',
    });
    expect(client.state).toBe('open');
  });

  it('returns 1500 with the error message when a handler throws', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.registerAction('explode', () => {
      throw new Error('handler exploded');
    });
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    server.send({ action: 'explode', params: {}, echo: 'boom-1' });

    const response = await server.waitForMessage(
      (message) => isRecord(message) && message.echo === 'boom-1',
    );

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1500,
      message: 'handler exploded',
      echo: 'boom-1',
    });
  });

  it('returns 100 for non-object params', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.registerAction('get_login_info', () => ({ user_id: 10001 }));
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    server.send({ action: 'get_login_info', params: 'nope', echo: 'bad-1' });

    const response = await server.waitForMessage(
      (message) => isRecord(message) && message.echo === 'bad-1',
    );

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 100,
      echo: 'bad-1',
    });
  });

  it('sends OneBot events to the server', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    client.sendEvent({
      time: 1,
      self_id: 10001,
      post_type: 'message',
      message_type: 'private',
      raw_message: 'hello',
    });

    const received = await server.waitForMessage(
      (message) =>
        isRecord(message) && message.post_type === 'message' && message.raw_message === 'hello',
    );

    expect(received).toMatchObject({
      time: 1,
      self_id: 10001,
      post_type: 'message',
      message_type: 'private',
      raw_message: 'hello',
    });
  });

  it('reconnects after the server closes the socket', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server, {
      reconnect: {
        enabled: true,
        baseMs: 10,
        maxMs: 50,
        jitter: 0,
        resetAfterMs: 0,
      },
    });
    client.start();

    await server.waitForConnection(1);
    await waitFor(() => client.isOpen);

    server.connections[0]!.socket.terminate();

    await server.waitForConnection(2, 2_000);
    await waitFor(() => client.isOpen);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
  });

  it('sends heartbeat meta events when enabled', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server, {
      heartbeat: { enabled: true, intervalMs: 100, requirePong: true },
    });
    client.start();

    const heartbeat = await server.waitForMessage(
      (message) => isRecord(message) && message.meta_event_type === 'heartbeat',
      2_000,
    );

    expect(heartbeat).toMatchObject({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      self_id: 10001,
      interval: 100,
      status: { online: true, good: true },
    });
    expect(isRecord(heartbeat) && Object.hasOwn(heartbeat, 'polaris_state')).toBe(false);
  });

  it('keeps heartbeat online/good false when no providers are wired', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = new ReverseWsClient({
      url: server.url,
      selfId: 10001,
      logger: nullLogger,
      reconnect: { enabled: false },
      heartbeat: { enabled: true, intervalMs: 50, requirePong: false },
    });
    clients.push(client);
    client.start();

    const heartbeat = await server.waitForMessage(
      (message) => isRecord(message) && message.meta_event_type === 'heartbeat',
      2_000,
    );

    expect(heartbeat).toMatchObject({
      status: { online: false, good: false },
    });
  });

  it('follows the adapter-confirmed login state for heartbeat online/good', async () => {
    const server = await createTestServer();
    servers.push(server);

    let login: 'LOGGED_IN' | 'LOGGED_OUT' = 'LOGGED_IN';
    const client = makeClient(server, {
      heartbeat: { enabled: true, intervalMs: 50, requirePong: false },
      loginProvider: () => login,
    });
    client.start();

    await waitFor(
      () =>
        server.messages.some(
          (message) =>
            isRecord(message) &&
            isRecord(message.status) &&
            message.status.online === true &&
            message.status.good === true,
        ),
      2_000,
    );

    const beforeLogout = server.messages.length;
    login = 'LOGGED_OUT';
    await waitFor(
      () =>
        server.messages
          .slice(beforeLogout)
          .some(
            (message) =>
              isRecord(message) &&
              isRecord(message.status) &&
              message.status.online === false &&
              message.status.good === false,
          ),
      2_000,
    );
  });

  it('returns 1501 when an action handler exceeds actionTimeoutMs', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server, { actionTimeoutMs: 50 });
    client.registerAction('slow', () => new Promise<never>(() => void 0));
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    server.send({ action: 'slow', params: {}, echo: 'slow-1' });

    const response = await server.waitForMessage(
      (message) => isRecord(message) && message.echo === 'slow-1',
    );

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1501,
      echo: 'slow-1',
    });
  });

  it('enters auth_failed on 401 and does not retry until resume()', async () => {
    const server = await createRejectingServer(401);
    rejectingServers.push(server);

    const failures: AuthFailureInfo[] = [];
    const client = makeClient(server, {
      accessToken: 'wrong-token',
      reconnect: { enabled: true, baseMs: 10, maxMs: 20, jitter: 0, resetAfterMs: 0 },
    });
    client.onAuthFailure((info) => {
      failures.push(info);
    });
    client.start();

    await waitFor(() => client.state === 'auth_failed');
    await waitFor(() => failures.length === 1);

    expect(failures[0]).toMatchObject({
      kind: 'auth_failed',
      statusCode: 401,
      tokenConfigured: true,
    });
    expect(failures[0]?.url).not.toContain('access_token');
    expect(server.attempts).toBe(1);

    await sleep(300);
    expect(server.attempts).toBe(1);

    const resumeStartedAt = Date.now();
    await client.resume();
    expect(Date.now() - resumeStartedAt).toBeLessThan(500);
    await waitFor(() => server.attempts === 2);
    await waitFor(() => client.state === 'auth_failed');
    await sleep(100);
    expect(server.attempts).toBe(2);
  });

  it('enters handshake_failed on 404 and does not retry', async () => {
    const server = await createRejectingServer(404);
    rejectingServers.push(server);

    const client = makeClient(server, {
      reconnect: { enabled: true, baseMs: 10, maxMs: 20, jitter: 0, resetAfterMs: 0 },
    });
    client.start();

    await waitFor(() => client.state === 'handshake_failed');
    expect(server.attempts).toBe(1);

    await sleep(200);
    expect(server.attempts).toBe(1);
  });

  it('rejects resume() outside auth_failed/handshake_failed', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    await expect(client.resume()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(client.isOpen).toBe(true);
  });

  it('closes the socket on stop()', async () => {
    const server = await createTestServer();
    servers.push(server);

    const client = makeClient(server);
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.isOpen);

    const socket = server.connections[0]!.socket;
    await client.stop();

    await waitFor(() => socket.readyState === WebSocket.CLOSED);
    expect(client.state).toBe('closed');
  });

  it('rejects an invalid token and does not send events', async () => {
    const server = await createTestServer({ expectedToken: 'correct-token' });
    servers.push(server);

    const client = makeClient(server, { accessToken: 'wrong-token' });
    client.start();

    await server.waitForConnection();
    await waitFor(() => client.state === 'closed');

    expect(server.messages).toHaveLength(0);
  });
});

describe('classifyHandshakeStatus', () => {
  it('separates auth, config and transient failures', () => {
    expect(classifyHandshakeStatus(401)).toBe('auth_failed');
    expect(classifyHandshakeStatus(403)).toBe('auth_failed');
    expect(classifyHandshakeStatus(404)).toBe('handshake_failed');
    expect(classifyHandshakeStatus(426)).toBe('handshake_failed');
    expect(classifyHandshakeStatus(408)).toBe('transient');
    expect(classifyHandshakeStatus(429)).toBe('transient');
    expect(classifyHandshakeStatus(500)).toBe('transient');
  });
});
