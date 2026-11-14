import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MockAdapter, MockControlServer } from '@lodestar/adapter-mock';
import { nullLogger } from '../src/logger.js';
import { CoreRuntime } from '../src/runtime/core-runtime.js';
import { createTestServer, isRecord, sleep, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function post(url: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('CoreRuntime ↔ MockAdapter (E2E)', () => {
  it('emits through control plane -> Core -> AstrBot, and survives freeze/resume', async () => {
    const server = await createTestServer();
    cleanups.push(async () => {
      await server.close();
    });

    const adapter = new MockAdapter({ accountId: 10001 });
    const control = new MockControlServer(adapter);
    await control.start();
    cleanups.push(async () => {
      await control.stop();
    });

    const tempDir = mkdtempSync(join(tmpdir(), 'polaris-e2e-'));
    tempDirs.push(tempDir);

    const runtime = new CoreRuntime({
      adapter,
      client: {
        url: server.url,
        reconnect: { enabled: false },
        heartbeat: { enabled: false },
      },
      databasePath: ':memory:',
      sendGuard: {
        stopFile: join(tempDir, 'STOP'),
        quietHours: null,
      },
      logger: nullLogger,
    });
    await runtime.start();
    cleanups.push(async () => {
      await runtime.stop();
    });

    await server.waitForConnection();
    await waitFor(() => runtime.clientInstance?.isOpen === true);

    expect((await post(control.url, '/emit', { text: 'hello' })).status).toBe(200);

    const first = await server.waitForMessage(
      (message) =>
        isRecord(message) && message.post_type === 'message' && message.raw_message === 'hello',
    );
    expect(first).toMatchObject({ post_type: 'message', raw_message: 'hello' });

    // Freeze blocks events; the control health endpoint reflects it.
    expect((await post(control.url, '/freeze')).status).toBe(200);
    const beforeFreeze = server.messages.length;
    expect((await post(control.url, '/emit', { text: 'frozen' })).status).toBe(200);
    await sleep(100);
    expect(server.messages.length).toBe(beforeFreeze);

    const frozenHealth = (await (await fetch(`${control.url}/health`)).json()) as {
      dataPlane: string;
    };
    expect(frozenHealth.dataPlane).toBe('silent');

    // Resume and emit again.
    expect((await post(control.url, '/resume')).status).toBe(200);
    expect((await post(control.url, '/emit', { text: 'after' })).status).toBe(200);

    await server.waitForMessage(
      (message) =>
        isRecord(message) && message.post_type === 'message' && message.raw_message === 'after',
    );

    expect(runtime.status()).toMatchObject({
      accountId: 10001,
      clientState: 'open',
    });
  });
});
