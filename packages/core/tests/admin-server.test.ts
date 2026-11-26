import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { AdminServer } from '../src/admin/admin-server.js';
import type { AdminRuntimeView } from '../src/admin/admin-server.js';
import type { CoreRuntimeStatus } from '../src/runtime/core-runtime.js';
import { AdminAuditStore } from '../src/storage/admin-audit-store.js';
import { openSqliteDatabase } from '../src/storage/database.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';

const TOKEN = 'test-admin-token';
const SELF_ID = 123456;
const NOW = 1_000_000;

const servers: AdminServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map(async (server) => server.stop()));
  servers.length = 0;
});

function createRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'polaris-admin-'));
  const db = openSqliteDatabase(join(dir, 'admin.db'));
  db.exec(SCHEMA_SQL);
  const store = new AdminAuditStore(db);

  const runtime: AdminRuntimeView = {
    status: (): CoreRuntimeStatus => ({
      clientState: 'open',
      accountId: SELF_ID,
      sessionId: 'session-1',
      pendingEvents: 0,
      replayableEvents: 0,
      health: {
        state: 'ONLINE',
        loginState: 'LOGGED_IN',
      },
    }),
    adapter: {
      health: () =>
        Promise.resolve({
          process: 'ready',
          loginState: 'LOGGED_IN',
          dataPlane: 'healthy',
          qqBuild: '9.9.33-52230',
        }),
    },
    adminAuditStore: store,
  };

  return {
    dir,
    db,
    store,
    runtime,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startServer(
  runtime: AdminRuntimeView,
  dir: string,
  options: { shutdown?: () => void | Promise<void>; demo?: boolean } = {},
): Promise<AdminServer> {
  const server = new AdminServer({
    runtime,
    token: TOKEN,
    port: 0,
    protocolConfigPath: join(dir, 'upstream.json'),
    webRoot: join(dir, 'web'),
    now: () => NOW,
    ...(options.shutdown ? { shutdown: options.shutdown } : {}),
    ...(options.demo ? { demo: true } : {}),
  });
  await server.start();
  servers.push(server);
  return server;
}

async function request(
  server: AdminServer,
  path: string,
  init: RequestInit = {},
  token = TOKEN,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  return fetch(`${server.url}${path}`, { ...init, headers });
}

describe('AdminServer', () => {
  it('rejects non-loopback admin hosts by default', () => {
    const runtime = createRuntime();
    try {
      expect(
        () =>
          new AdminServer({
            runtime: runtime.runtime,
            token: TOKEN,
            port: 0,
            host: '0.0.0.0',
            webRoot: join(runtime.dir, 'web'),
          }),
      ).toThrow(/loopback/);
    } finally {
      runtime.cleanup();
    }
  });

  it('requires a token and returns masked status', async () => {
    const runtime = createRuntime();
    try {
      const server = await startServer(runtime.runtime, runtime.dir);

      const unauthorized = await request(server, '/api/status', {}, '');
      expect(unauthorized.status).toBe(401);

      const response = await request(server, '/api/status');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        demo?: boolean;
        account: { idHash: string };
        loader: { dataPlane: string };
        onebot: { clientState: string };
        health: { state: string };
      };
      expect(body.demo).toBe(false);
      expect(body.loader.dataPlane).toBe('healthy');
      expect(body.onebot.clientState).toBe('open');
      expect(body.health.state).toBe('ONLINE');
      expect(body.account.idHash).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(body)).not.toContain(String(SELF_ID));
    } finally {
      runtime.cleanup();
    }
  });

  it('flags demo mode so the panel does not present mock data as live', async () => {
    const runtime = createRuntime();
    try {
      const server = await startServer(runtime.runtime, runtime.dir, { demo: true });
      const body = (await (await request(server, '/api/status')).json()) as { demo?: boolean };
      expect(body.demo).toBe(true);
    } finally {
      runtime.cleanup();
    }
  });

  it('serves runtime metrics and admin audit', async () => {
    const runtime = createRuntime();
    try {
      const server = await startServer(runtime.runtime, runtime.dir);
      runtime.runtime.restart = () => Promise.resolve({ restartedAt: new Date(NOW).toISOString() });
      await request(server, '/api/restart', { method: 'POST' });

      const metrics = await request(server, '/api/metrics');
      expect(metrics.status).toBe(200);
      const text = await metrics.text();
      expect(text).toContain('polaris_health_state{state="ONLINE"} 1');
      expect(text).toContain('polaris_ready 1');
      expect(text).not.toContain('polaris_send_guard');

      const adminAudit = await request(server, '/api/admin-audit');
      expect(adminAudit.status).toBe(200);
      const body = (await adminAudit.json()) as { items: Array<{ action: string }> };
      expect(body.items[0]?.action).toBe('core.restart');
    } finally {
      runtime.cleanup();
    }
  });

  it('restarts the runtime and returns a fresh status snapshot', async () => {
    const runtime = createRuntime();
    let restarts = 0;
    runtime.runtime.restart = () => {
      restarts += 1;
      return Promise.resolve({ restartedAt: new Date(NOW).toISOString() });
    };
    try {
      const server = await startServer(runtime.runtime, runtime.dir);
      const response = await request(server, '/api/restart', { method: 'POST' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        restartedAt: string;
        status: { onebot: { clientState: string } };
      };
      expect(body.ok).toBe(true);
      expect(body.restartedAt).toBe(new Date(NOW).toISOString());
      expect(body.status.onebot.clientState).toBe('open');
      expect(restarts).toBe(1);
      expect(runtime.store.recentAdminAudit(1)[0]?.action).toBe('core.restart');
    } finally {
      runtime.cleanup();
    }
  });

  it('changes the admin password and persists it', async () => {
    const runtime = createRuntime();
    try {
      const server = await startServer(runtime.runtime, runtime.dir);
      const changed = await request(server, '/api/admin/password', {
        method: 'PUT',
        body: JSON.stringify({
          newPassword: 'new-local-password',
          confirm: 'CHANGE',
        }),
      });
      expect(changed.status).toBe(200);
      expect(((await changed.json()) as { ok: boolean }).ok).toBe(true);

      expect((await request(server, '/api/status', {}, TOKEN)).status).toBe(401);
      expect((await request(server, '/api/status', {}, 'new-local-password')).status).toBe(200);

      const persisted = JSON.parse(readFileSync(join(runtime.dir, 'upstream.json'), 'utf8')) as {
        admin: { token: string };
      };
      expect(persisted.admin.token).toBe('new-local-password');
      expect(runtime.store.recentAdminAudit(1)[0]?.action).toBe('admin.password');
    } finally {
      runtime.cleanup();
    }
  });

  it('terminates the core only after explicit confirmation', async () => {
    const runtime = createRuntime();
    let shutdownCalled = false;
    try {
      const server = await startServer(runtime.runtime, runtime.dir, {
        shutdown: () => {
          shutdownCalled = true;
        },
      });

      const refused = await request(server, '/api/shutdown', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'nope' }),
      });
      expect(refused.status).toBe(400);
      expect(shutdownCalled).toBe(false);

      const accepted = await request(server, '/api/shutdown', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'TERMINATE' }),
      });
      expect(accepted.status).toBe(202);
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 250);
      });
      expect(shutdownCalled).toBe(true);
      expect(runtime.store.recentAdminAudit(1)[0]?.action).toBe('admin.shutdown');
    } finally {
      runtime.cleanup();
    }
  });

  it('reads and updates protocol config without exposing tokens', async () => {
    const runtime = createRuntime();
    try {
      writeFileSync(
        join(runtime.dir, 'upstream.json'),
        JSON.stringify({
          selfId: SELF_ID,
          astrbot: { url: 'ws://127.0.0.1:6199/ws', token: '' },
          upstream: { url: 'ws://127.0.0.1:3001/', token: '' },
          keepMe: 'yes',
        }),
      );
      const server = await startServer(runtime.runtime, runtime.dir);

      const before = (await (await request(server, '/api/protocol')).json()) as {
        onebot: { port: number; tokenConfigured: boolean };
        reverse: { url: string; tokenConfigured: boolean };
      };
      expect(before.onebot).toMatchObject({ port: 3001, tokenConfigured: false });
      expect(before.reverse).toMatchObject({
        url: 'ws://127.0.0.1:6199/ws',
        tokenConfigured: false,
      });

      const updated = await request(server, '/api/protocol', {
        method: 'PUT',
        body: JSON.stringify({
          panelPort: 18082,
          onebotPort: 3002,
          onebotToken: 'onebot-secret',
          reverseUrl: 'ws://127.0.0.1:6200/ws',
          reverseToken: 'reverse-secret',
        }),
      });
      expect(updated.status).toBe(200);
      const updatedBody = (await updated.json()) as {
        restartRequired: boolean;
        protocol: { onebot: { port: number }; reverse: { url: string } };
      };
      expect(updatedBody.restartRequired).toBe(true);
      expect(updatedBody.protocol.onebot.port).toBe(3002);
      expect(updatedBody.protocol.reverse.url).toBe('ws://127.0.0.1:6200/ws');

      const persisted = JSON.parse(readFileSync(join(runtime.dir, 'upstream.json'), 'utf8')) as {
        selfId: number;
        keepMe: string;
        upstream: { token: string; url: string };
        astrbot: { token: string };
      };
      expect(persisted.selfId).toBe(SELF_ID);
      expect(persisted.keepMe).toBe('yes');
      expect(persisted.upstream.token).toBe('onebot-secret');
      expect(persisted.upstream.url).toContain(':3002/');
      expect(persisted.astrbot.token).toBe('reverse-secret');

      const after = (await (await request(server, '/api/protocol')).json()) as {
        onebot: { tokenConfigured: boolean };
        reverse: { tokenConfigured: boolean };
      };
      expect(after.onebot.tokenConfigured).toBe(true);
      expect(after.reverse.tokenConfigured).toBe(true);
      expect(JSON.stringify(after)).not.toContain('onebot-secret');
      expect(JSON.stringify(after)).not.toContain('reverse-secret');
    } finally {
      runtime.cleanup();
    }
  });

  it('tests reverse WebSocket reachability', async () => {
    const runtime = createRuntime();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    try {
      await once(wss, 'listening');
      const port = (wss.address() as AddressInfo).port;
      const server = await startServer(runtime.runtime, runtime.dir);
      const response = await request(server, '/api/protocol/test', {
        method: 'POST',
        body: JSON.stringify({ target: 'reverse', url: `ws://127.0.0.1:${port}/` }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; status?: number };
      expect(body.ok).toBe(true);
      expect(body.status).toBe(101);
    } finally {
      await new Promise<void>((resolvePromise) => {
        wss.close(() => resolvePromise());
      });
      runtime.cleanup();
    }
  });
});
