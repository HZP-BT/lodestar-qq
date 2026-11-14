import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import { OneBotUpstreamAdapter } from '../src/upstream-adapter.js';
import type { AdapterEvent, EventSink } from '../src/protocol.js';

function fakeSink() {
  const events: AdapterEvent[] = [];
  const sink: EventSink = {
    publish(event) {
      events.push(event);
      return Promise.resolve({
        accepted: true,
        eventKey: `k-${events.length}`,
        deliverSeq: events.length,
        mode: 'queued',
      });
    },
  };
  return { sink, events };
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitForAsync timeout');
}

interface FakeUpstream {
  url: string;
  connections: WebSocket[];
  messages: Array<Record<string, unknown>>;
  close: () => Promise<void>;
  send: (payload: unknown) => void;
  respond: (handler: (payload: Record<string, unknown>, socket: WebSocket) => boolean) => void;
}

async function createUpstream(): Promise<FakeUpstream> {
  const wss = new WebSocketServer({ port: 0, path: '/' });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  const connections: WebSocket[] = [];
  const messages: Array<Record<string, unknown>> = [];
  let responder: ((payload: Record<string, unknown>, socket: WebSocket) => boolean) | null = null;

  wss.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawDataToString(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      messages.push(payload);
      if (responder && responder(payload, socket)) {
        return;
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/`,
    connections,
    messages,
    async close() {
      for (const socket of connections) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    send(payload) {
      const socket = connections.at(-1);
      if (socket) socket.send(JSON.stringify(payload));
    },
    respond(handler) {
      responder = handler;
    },
  };
}

async function createRejectingUpstream(statusCode: number) {
  let attempts = 0;
  const server = createHttpServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (_request, socket) => {
    attempts += 1;
    socket.write(
      `HTTP/1.1 ${statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/`,
    get attempts() {
      return attempts;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('OneBotUpstreamAdapter', () => {
  it('connects, receives message events and preserves message_id identity', async () => {
    const upstream = await createUpstream();
    const { sink, events } = fakeSink();
    const adapter = new OneBotUpstreamAdapter({
      url: upstream.url,
      selfId: 10001,
      reconnect: { enabled: false },
    });

    try {
      await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
      await waitFor(() => upstream.connections.length === 1);

      upstream.send({
        time: 1,
        self_id: 10001,
        post_type: 'message',
        message_type: 'group',
        group_id: 100,
        message_id: 42,
        raw_message: 'hello',
        message: 'hello',
      });

      await waitFor(() => events.length === 1);
      expect(events[0]).toMatchObject({
        accountId: 10001,
        sourceEventId: '42',
        nativeMessageId: 42,
        payload: { post_type: 'message', raw_message: 'hello' },
      });
      expect((await adapter.health()).inboundCursor).toBe(1);
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });

  it('forwards actions with echo correlation and learns login state', async () => {
    const upstream = await createUpstream();
    const { sink } = fakeSink();
    const adapter = new OneBotUpstreamAdapter({ url: upstream.url, selfId: 10001 });

    upstream.respond((payload, socket) => {
      if (payload.action === 'get_login_info') {
        socket.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data: { user_id: 10001, nickname: 'Lodestar' },
            echo: payload.echo,
          }),
        );
        return true;
      }
      return false;
    });

    try {
      await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
      await waitForAsync(async () => (await adapter.health()).loginState === 'LOGGED_IN');

      const result = await adapter.execute(
        'get_login_info',
        {},
        { action: 'get_login_info', selfId: 10001, echo: null },
      );

      expect(result).toMatchObject({ ok: true, retcode: 0 });
      expect(result.data).toMatchObject({ user_id: 10001 });
      expect(upstream.messages.some((message) => message.action === 'get_login_info')).toBe(true);
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });

  it('returns 1501 when an upstream action times out', async () => {
    const upstream = await createUpstream();
    const { sink } = fakeSink();
    const adapter = new OneBotUpstreamAdapter({
      url: upstream.url,
      selfId: 10001,
      actionTimeoutMs: 60,
    });

    try {
      await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
      const result = await adapter.execute(
        'get_login_info',
        {},
        { action: 'get_login_info', selfId: 10001, echo: null },
      );
      expect(result).toMatchObject({ ok: false, retcode: 1501 });
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });

  it('ignores backend meta events instead of publishing them', async () => {
    const upstream = await createUpstream();
    const { sink, events } = fakeSink();
    const adapter = new OneBotUpstreamAdapter({ url: upstream.url, selfId: 10001 });

    try {
      await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
      upstream.send({
        time: 1,
        self_id: 10001,
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toHaveLength(0);
      expect((await adapter.health()).inboundCursor).toBe(0);
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });

  it('reconnects after an upstream close', async () => {
    const upstream = await createUpstream();
    const { sink } = fakeSink();
    const adapter = new OneBotUpstreamAdapter({
      url: upstream.url,
      selfId: 10001,
      reconnect: { enabled: true, baseMs: 10, maxMs: 20, jitter: 0 },
    });

    try {
      await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
      await waitFor(() => upstream.connections.length === 1);
      upstream.connections[0]!.terminate();
      await waitFor(() => upstream.connections.length >= 2);
      await waitFor(() => adapter.isOpen);
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });

  it('enters auth_failed on 401 and does not reconnect', async () => {
    const upstream = await createRejectingUpstream(401);
    const { sink } = fakeSink();
    const adapter = new OneBotUpstreamAdapter({
      url: upstream.url,
      selfId: 10001,
      reconnect: { enabled: true, baseMs: 10, maxMs: 20, jitter: 0 },
    });

    try {
      await adapter.start(sink, { accountId: 10001, sessionId: 's1' });
      await waitFor(() => (adapter as unknown as { state: string }).state === 'auth_failed');
      const health = await adapter.health();
      expect(health.dataPlane).toBe('dead');
      expect(health.detail).toContain('401');

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(upstream.attempts).toBe(1);
    } finally {
      await adapter.stop();
      await upstream.close();
    }
  });
});
