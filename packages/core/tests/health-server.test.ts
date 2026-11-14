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
    probe: {
      state: 'IDLE',
      loginState: 'LOGGED_IN',
      actionFailures: 0,
      lastActionOkAt: 1,
      lastInboundAt: 0,
      inboundCursor: 0,
      lastCursorChangeAt: 0,
      lastNonce: null,
    },
    sendGuard: {
      circuit: 'CLOSED',
      circuitReason: null,
      stopDisabled: false,
      allowed: 0,
      blocked: {},
      auditTotal: 0,
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

    current = status({ probe: { ...status().probe, state: 'DEGRADED' } });
    const degraded = await fetch(`${server.url}/readyz`);
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toMatchObject({
      status: 'not_ready',
      state: { health: 'DEGRADED' },
    });

    const metrics = await fetch(`${server.url}/metrics`);
    const text = await metrics.text();
    expect(metrics.status).toBe(200);
    expect(text).toContain('polaris_health_state{state="DEGRADED"} 1');
    expect(text).toContain('polaris_ready 0');
    expect(text).toContain('polaris_send_guard_circuit{state="CLOSED"} 1');
  });

  it('keeps healthz 200 on auth_failed while readyz is 503', async () => {
    const current = status({
      clientState: 'auth_failed',
      probe: { ...status().probe, state: 'OFFLINE', loginState: 'UNKNOWN' },
    });
    const server = new HealthServer({ getStatus: () => current, host: '127.0.0.1', port: 0 });
    servers.push(server);
    await server.start();

    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(503);
  });
});
