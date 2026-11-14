import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

import type { MockAdapter } from './mock-adapter.js';

export interface MockControlServerOptions {
  host?: string;
  port?: number;
  token?: string;
}

const BODY_LIMIT = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * HTTP control plane for MOCK-07..14 scripts. Binds localhost by default; an
 * optional bearer token protects it if exposed beyond loopback.
 */
export class MockControlServer {
  private readonly adapter: MockAdapter;
  private readonly host: string;
  private readonly token: string | undefined;
  private server: Server | null = null;
  private boundPort = 0;

  constructor(adapter: MockAdapter, options: MockControlServerOptions = {}) {
    this.adapter = adapter;
    this.host = options.host ?? '127.0.0.1';
    this.token = options.token;
    this.requestedPort = options.port ?? 0;
  }

  private readonly requestedPort: number;

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        this.sendJson(response, statusCode, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.token) {
      const auth = request.headers.authorization ?? '';
      if (auth !== `Bearer ${this.token}`) {
        this.sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
    }

    const url = new URL(request.url ?? '/', this.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/health') {
      this.sendJson(response, 200, await this.adapter.health());
      return;
    }

    if (request.method === 'GET' && path === '/status') {
      this.sendJson(response, 200, {
        health: await this.adapter.health(),
        sentMessages: this.adapter.sentMessages,
      });
      return;
    }

    if (request.method !== 'POST') {
      this.sendJson(response, 404, { error: 'not found' });
      return;
    }

    const body = await readJson(request);

    switch (path) {
      case '/emit': {
        if (typeof body.text !== 'string' || body.text.trim().length === 0) {
          this.sendJson(response, 400, { error: 'text is required' });
          return;
        }
        const text = body.text;
        const groupId = typeof body.groupId === 'number' ? body.groupId : undefined;
        const sourceEventId =
          typeof body.sourceEventId === 'string' ? body.sourceEventId : undefined;
        const result = await this.adapter.emitText(text, {
          ...(groupId === undefined ? {} : { groupId }),
          ...(sourceEventId === undefined ? {} : { sourceEventId }),
        });
        this.sendJson(response, 200, { result });
        return;
      }
      case '/emit-meta': {
        const type = body.metaEventType === 'lifecycle' ? 'lifecycle' : 'heartbeat';
        this.sendJson(response, 200, { result: await this.adapter.emitMeta(type) });
        return;
      }
      case '/freeze':
        this.adapter.freeze();
        this.sendJson(response, 200, { ok: true });
        return;
      case '/freeze-events':
        this.adapter.freezeEvents();
        this.sendJson(response, 200, { ok: true });
        return;
      case '/resume':
        this.adapter.resumeData();
        this.sendJson(response, 200, { ok: true });
        return;
      case '/crash':
        this.adapter.crash();
        this.sendJson(response, 200, { ok: true });
        return;
      case '/auth-fail':
        this.adapter.authFail();
        this.sendJson(response, 200, { ok: true });
        return;
      case '/canary': {
        const nonce = typeof body.nonce === 'string' ? body.nonce : 'canary';
        this.adapter.canary(nonce);
        this.sendJson(response, 200, { ok: true });
        return;
      }
      case '/slow-action': {
        const ms = typeof body.ms === 'number' ? body.ms : 0;
        this.adapter.slowAction(ms);
        this.sendJson(response, 200, { ok: true });
        return;
      }
      case '/version': {
        const qqBuild = typeof body.qqBuild === 'string' ? body.qqBuild : 'mock-1';
        this.adapter.setVersion(qqBuild);
        this.sendJson(response, 200, { ok: true });
        return;
      }
      case '/action': {
        const action = typeof body.action === 'string' ? body.action : '';
        if (action.length === 0) {
          this.sendJson(response, 400, { error: 'action is required' });
          return;
        }
        const params =
          typeof body.params === 'object' && body.params !== null
            ? (body.params as Record<string, unknown>)
            : {};
        const result = await this.adapter.execute(action, params, {
          action,
          selfId: this.adapter.accountId,
          echo: null,
        });
        this.sendJson(response, 200, result);
        return;
      }
      default:
        this.sendJson(response, 404, { error: 'not found' });
    }
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;

    if (size > BODY_LIMIT) {
      throw new HttpError(413, 'request body too large');
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, 'invalid JSON body');
  }
}
