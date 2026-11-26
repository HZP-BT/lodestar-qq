import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CoreRuntimeStatus } from '../runtime/core-runtime.js';

export interface HealthServerOptions {
  getStatus: () => CoreRuntimeStatus;
  host?: string;
  port?: number;
}

export class HealthServer {
  private readonly getStatus: () => CoreRuntimeStatus;
  private readonly host: string;
  private readonly requestedPort: number;
  private server: Server | null = null;
  private boundPort = 0;

  constructor(options: HealthServerOptions) {
    this.getStatus = options.getStatus;
    this.host = options.host ?? '0.0.0.0';
    this.requestedPort = options.port ?? 8080;
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      this.handle(request, response);
    });
    this.server = server;
    server.listen(this.requestedPort, this.host);
    await once(server, 'listening');
    this.boundPort = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', this.url);

    if (url.pathname === '/healthz') {
      this.sendJson(response, 200, this.statusBody('ok'));
      return;
    }

    if (url.pathname === '/readyz') {
      const ready = this.isReady();
      this.sendJson(response, ready ? 200 : 503, this.statusBody(ready ? 'ready' : 'not_ready'));
      return;
    }

    if (url.pathname === '/metrics') {
      this.sendMetrics(response);
      return;
    }

    this.sendJson(response, 404, { error: 'not found' });
  }

  private statusBody(status: 'ok' | 'ready' | 'not_ready'): Record<string, unknown> {
    const current = this.getStatus();
    return {
      status,
      state: {
        client: current.clientState,
        login: current.health.loginState,
        health: current.health.state,
      },
      accountId: current.accountId,
      sessionId: current.sessionId,
      pendingEvents: current.pendingEvents,
      replayableEvents: current.replayableEvents,
      timestamp: new Date().toISOString(),
    };
  }

  private isReady(): boolean {
    return isReadyStatus(this.getStatus());
  }

  private sendMetrics(response: ServerResponse): void {
    const body = renderMetrics(this.getStatus());
    response.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

export function isReadyStatus(current: CoreRuntimeStatus): boolean {
  return (
    current.clientState === 'open' &&
    current.health.loginState === 'LOGGED_IN' &&
    current.health.state === 'ONLINE'
  );
}

export function renderMetrics(current: CoreRuntimeStatus): string {
  const states = ['UNKNOWN', 'ONLINE', 'OFFLINE'] as const;
  const lines = [
    '# HELP polaris_health_state Current runtime health state (1 for the active state).',
    '# TYPE polaris_health_state gauge',
    ...states.map(
      (state) => `polaris_health_state{state="${state}"} ${current.health.state === state ? 1 : 0}`,
    ),
    '# HELP polaris_ready Whether readyz would return 200.',
    '# TYPE polaris_ready gauge',
    `polaris_ready ${isReadyStatus(current) ? 1 : 0}`,
    '# HELP polaris_client_up Whether the OneBot reverse WebSocket is open.',
    '# TYPE polaris_client_up gauge',
    `polaris_client_up ${current.clientState === 'open' ? 1 : 0}`,
    '# HELP polaris_pending_events Pending outbox events for this account.',
    '# TYPE polaris_pending_events gauge',
    `polaris_pending_events ${current.pendingEvents}`,
    '# HELP polaris_replayable_events Replayable (pending/sending) outbox events.',
    '# TYPE polaris_replayable_events gauge',
    `polaris_replayable_events ${current.replayableEvents}`,
    '# HELP polaris_send_guard_circuit SendGuard circuit state (1 for the active state).',
    '# TYPE polaris_send_guard_circuit gauge',
    `polaris_send_guard_circuit{state="CLOSED"} ${current.sendGuard.circuit === 'CLOSED' ? 1 : 0}`,
    `polaris_send_guard_circuit{state="OPEN"} ${current.sendGuard.circuit === 'OPEN' ? 1 : 0}`,
    '# HELP polaris_send_disabled Whether the STOP sentinel is active.',
    '# TYPE polaris_send_disabled gauge',
    `polaris_send_disabled ${current.sendGuard.stopDisabled ? 1 : 0}`,
    '# HELP polaris_send_guard_allowed_total Send actions allowed by SendGuard.',
    '# TYPE polaris_send_guard_allowed_total counter',
    `polaris_send_guard_allowed_total ${current.sendGuard.allowed}`,
    '# HELP polaris_send_guard_audit_total SendGuard audit records attempted.',
    '# TYPE polaris_send_guard_audit_total counter',
    `polaris_send_guard_audit_total ${current.sendGuard.auditTotal}`,
    '# HELP polaris_send_guard_denied_total Send actions denied by reason.',
    '# TYPE polaris_send_guard_denied_total counter',
    ...Object.entries(current.sendGuard.blocked).map(
      ([reason, count]) => `polaris_send_guard_denied_total{reason="${reason}"} ${count}`,
    ),
    '',
  ];
  return lines.join('\n');
}
