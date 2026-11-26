import { afterEach, describe, expect, it } from 'vitest';

import { HealthServer } from '../src/observability/health-server.js';
import type { CoreRuntimeStatus } from '../src/runtime/core-runtime.js';

const servers: HealthServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map(async (server) => server.stop()));
  servers.length = 0;
});

function status(overrides: Partial<CoreRuntimeStatus> = {}): CoreRuntimeStatus {
  return {
    clientState: 'open',
    accountId: 10001,
    sessionId: 's1',
    pendingEvents: 0,
    replayableEvents: 0,
    health: {
      state: 'ONLINE',
      loginState: 'LOGGED_IN',
    },
    ...overrides,
  };
}

describe('HealthServer', () => {
  it('reports liveness, readiness and metrics', async () => {
    let current = status();
    const server = new HealthServer({ getStatus: () => current, host: '127.0.0.1', port: 0 });
    servers.push(server);
    await server.start();

    const health = await fetch(`${server.url}/healthz`);
    expect(health.status).toBe(200);

    const ready = await fetch(`${server.url}/readyz`);
    expect(ready.status).toBe(200);

    current = status({ health: { state: 'OFFLINE', loginState: 'LOGGED_IN' } });
    const offline = await fetch(`${server.url}/readyz`);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({
      status: 'not_ready',
      state: { health: 'OFFLINE' },
    });

    const metrics = await fetch(`${server.url}/metrics`);
    const text = await metrics.text();
    expect(metrics.status).toBe(200);
    expect(text).toContain('polaris_health_state{state="OFFLINE"} 1');
    expect(text).toContain('polaris_ready 0');
  });

  it('keeps healthz 200 on auth_failed while readyz is 503', async () => {
    const current = status({
      clientState: 'auth_failed',
      health: { state: 'OFFLINE', loginState: 'UNKNOWN' },
    });
    const server = new HealthServer({ getStatus: () => current, host: '127.0.0.1', port: 0 });
    servers.push(server);
    await server.start();

    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(503);
  });
});
