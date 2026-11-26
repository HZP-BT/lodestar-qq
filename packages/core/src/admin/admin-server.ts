import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, resolve, sep } from 'node:path';
import WebSocket from 'ws';

import { z } from 'zod';

import type { AdapterHealth } from '../adapter/types.js';
import type { Logger } from '../logger.js';
import { nullLogger } from '../logger.js';
import { renderMetrics } from '../observability/health-server.js';
import type { CoreRuntimeStatus } from '../runtime/core-runtime.js';
import type { SendGuard, SendGuardConfig } from '../send-guard.js';
import type { AuditQuery, SendGuardStore } from '../storage/send-guard-store.js';

export interface AdminRuntimeView {
  status(): CoreRuntimeStatus;
  adapter: { health(): Promise<AdapterHealth> };
  guard: SendGuard;
  sendGuardStoreInstance: SendGuardStore | null;
  restart?(): Promise<{ restartedAt: string; detail?: string }>;
}

export interface AdminServerOptions {
  runtime: AdminRuntimeView;
  token?: string;
  host?: string;
  port?: number;
  /**
   * Container-only escape hatch: bind 0.0.0.0 inside a container while the
   * host publishes the port on 127.0.0.1. Never enable this for a host-bound
   * admin server; it is ignored unless host is non-loopback.
   */
  allowNonLoopback?: boolean;
  configPath?: string;
  protocolConfigPath?: string;
  tokenFile?: string;
  shutdown?: () => void | Promise<void>;
  /** True when the runtime is backed by the mock adapter (demo mode). */
  demo?: boolean;
  webRoot?: string;
  logger?: Logger;
  now?: () => number;
}

const guardConfigSchema = z
  .object({
    groupWhitelist: z.array(z.number().int().positive()).max(200),
    privateEnabled: z.boolean(),
    privateWhitelist: z.array(z.number().int().positive()).max(200),
    atOnly: z.boolean().optional(),
    dailyQuota: z.number().int().min(0).max(10_000),
    perGroupDailyQuota: z.number().int().min(0).max(10_000).nullable(),
    minIntervalMs: z.number().int().min(0).max(3_600_000),
    randomDelayMs: z.number().int().min(0).max(60_000),
    quietHours: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
      })
      .nullable(),
    duplicateWindowMs: z.number().int().min(0).max(86_400_000),
    sendFailureThreshold: z.number().int().min(1).max(100),
    auditRetentionDays: z.number().int().min(1).max(3_650),
  })
  .strict();

const guardPatchSchema = guardConfigSchema.partial();

const confirmSchema = z.object({
  confirm: z.string(),
});

const protocolPatchSchema = z
  .object({
    panelPort: z.number().int().min(1024).max(65_535).optional(),
    onebotPort: z.number().int().min(1).max(65_535).optional(),
    onebotToken: z.string().max(512).optional(),
    reverseUrl: z
      .string()
      .refine((value) => isWsUrl(value), {
        message: 'reverseUrl must be ws:// or wss://',
      })
      .optional(),
    reverseToken: z.string().max(512).optional(),
  })
  .strict();

const protocolTestSchema = z
  .object({
    target: z.enum(['reverse', 'onebot']).optional(),
    url: z
      .string()
      .refine((value) => isWsUrl(value), {
        message: 'url must be ws:// or wss://',
      })
      .optional(),
    token: z.string().max(512).optional(),
  })
  .strict();

const passwordSchema = z
  .object({
    newPassword: z.string().min(12).max(512),
    confirm: z.literal('CHANGE'),
  })
  .strict();

const shutdownSchema = z.object({ confirm: z.literal('TERMINATE') }).strict();

type GuardConfigFile = z.infer<typeof guardConfigSchema>;

/**
 * Local-only admin HTTP server for the SendGuard control panel.
 *
 * Security boundary:
 * - binds loopback by default (127.0.0.1 / ::1 / localhost);
 * - the container demo may opt into a non-loopback bind with an explicit
 *   allowNonLoopback flag, while the host must publish the port on loopback;
 * - every /api request needs a bearer/X-Admin-Token token;
 * - audit responses hash targets and never return message bodies or plain UIDs;
 * - no public deployment, no multi-user login, no CORS.
 */
export class AdminServer {
  private readonly runtime: AdminRuntimeView;
  private token: string;
  private readonly generatedToken: boolean;
  private readonly tokenFromEnv: boolean;
  private readonly tokenFile: string | null;
  private readonly shutdown: (() => void | Promise<void>) | undefined;
  private readonly demo: boolean;
  private readonly host: string;
  private readonly allowNonLoopback: boolean;
  private readonly requestedPort: number;
  private readonly configPath: string;
  private readonly protocolConfigPath: string;
  private readonly webRoot: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private server: Server | null = null;
  private boundPort = 0;

  constructor(options: AdminServerOptions) {
    this.runtime = options.runtime;
    this.host = options.host ?? '127.0.0.1';
    this.allowNonLoopback =
      options.allowNonLoopback ??
      (process.env.LODESTAR_ADMIN_ALLOW_NON_LOOPBACK ??
        process.env.POLARIS_ADMIN_ALLOW_NON_LOOPBACK) === '1';
    if (!isLoopback(this.host) && !this.allowNonLoopback) {
      throw new Error('AdminServer must bind to a loopback address');
    }
    this.requestedPort = options.port ?? 18_081;
    this.configPath = options.configPath ?? 'config/send-guard.json';
    this.protocolConfigPath = options.protocolConfigPath ?? 'config/upstream.json';
    this.webRoot = resolve(options.webRoot ?? 'packages/web/dist');
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? Date.now;
    this.tokenFile = options.tokenFile ? resolve(options.tokenFile) : null;
    this.shutdown = options.shutdown;
    this.demo = options.demo ?? false;

    const envToken = process.env.LODESTAR_ADMIN_TOKEN ?? process.env.POLARIS_ADMIN_TOKEN ?? '';
    const configuredToken = options.token ?? envToken;
    this.tokenFromEnv = options.token === undefined && envToken.length > 0;
    this.generatedToken = configuredToken.length === 0;
    this.token = this.generatedToken ? randomBytes(24).toString('hex') : configuredToken;
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.loadConfigFile();

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    server.listen(this.requestedPort, this.host);
    await once(server, 'listening');
    this.boundPort = (server.address() as AddressInfo).port;

    if (this.generatedToken) {
      this.logger.warn(
        { adminToken: this.token },
        'admin token was not configured; generated an ephemeral token (set LODESTAR_ADMIN_TOKEN or POLARIS_ADMIN_TOKEN to persist)',
      );
    }
    if (!isLoopback(this.host)) {
      this.logger.warn(
        { host: this.host },
        'admin panel is bound to a non-loopback host; publish it on host loopback only and keep the token enabled',
      );
    }
    this.logger.info(
      { url: this.url, configPath: this.configPath },
      isLoopback(this.host)
        ? 'SendGuard admin panel listening on loopback'
        : 'SendGuard admin panel listening (container/opt-in non-loopback)',
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url);

    if (!url.pathname.startsWith('/api/')) {
      this.serveStatic(url.pathname, response);
      return;
    }

    if (!this.isAuthorized(request)) {
      this.sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      await this.route(request, response, url);
    } catch (error) {
      this.logger.error({ err: error, path: url.pathname }, 'admin request failed');
      this.sendJson(response, 500, { error: 'internal error' });
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/status') {
      this.sendJson(response, 200, await this.statusPayload());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/sendguard') {
      this.sendJson(response, 200, this.sendGuardPayload());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/protocol') {
      this.sendJson(response, 200, this.protocolPayload());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/restart') {
      await this.restartCore(request, response);
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/admin/password') {
      const body = await this.readJsonOr400(request, response);
      if (body === null) return;
      this.updatePassword(body, request, response);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/shutdown') {
      const body = await this.readJsonOr400(request, response);
      if (body === null) return;
      this.terminateCore(body, request, response);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/protocol/test') {
      const body = await this.readJsonOr400(request, response);
      if (body === null) return;
      void this.testProtocol(body, request, response);
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/protocol') {
      const body = await this.readJsonOr400(request, response);
      if (body === null) return;
      this.updateProtocol(body, request, response);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/audit') {
      this.sendJson(response, 200, this.auditPayload(url));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin-audit') {
      const store = this.runtime.sendGuardStoreInstance;
      this.sendJson(response, 200, { items: store?.recentAdminAudit(50) ?? [] });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/metrics') {
      const body = renderMetrics(this.runtime.status());
      response.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
      return;
    }

    if (method === 'POST' && url.pathname.startsWith('/api/sendguard/')) {
      const body = await this.readJsonOr400(request, response);
      if (body === null) return;
      this.handleAction(url.pathname, body, request, response);
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/sendguard/config') {
      const body = await this.readJsonOr400(request, response);
      if (body === null) return;
      this.updateConfig(body, request, response);
      return;
    }

    this.sendJson(response, 404, { error: 'not found' });
  }

  private async restartCore(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.runtime.restart) {
      this.sendJson(response, 501, {
        ok: false,
        error: 'smooth restart is not available in this runtime',
      });
      return;
    }

    try {
      const result = await this.runtime.restart();
      this.audit('core.restart', request, { ok: true });
      this.sendJson(response, 200, {
        ok: true,
        ...result,
        status: await this.statusPayload(),
      });
    } catch (error) {
      this.logger.error({ err: error }, 'core restart failed');
      this.audit('core.restart', request, { ok: false });
      this.sendJson(response, 500, { ok: false, error: 'core restart failed' });
    }
  }

  private updatePassword(
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(response, 400, {
        error: 'invalid password',
        detail: 'newPassword must be 12-512 chars and confirm must be CHANGE',
      });
      return;
    }
    if (parsed.data.newPassword === this.token) {
      this.sendJson(response, 400, { error: 'new password must differ from current token' });
      return;
    }

    this.token = parsed.data.newPassword;
    if (this.tokenFile) {
      mkdirSync(dirname(this.tokenFile), { recursive: true });
      writeFileSync(this.tokenFile, `${this.token}\n`, { mode: 0o600 });
    }
    const config = this.readProtocolFile();
    const admin = ensureRecord(config, 'admin');
    admin.token = this.token;
    this.writeProtocolFile(config);

    this.audit('admin.password', request, {
      changed: true,
      tokenFile: this.tokenFile !== null,
      envOverride: this.tokenFromEnv,
    });
    this.sendJson(response, 200, {
      ok: true,
      envOverride: this.tokenFromEnv,
      tokenFile: this.tokenFile !== null,
    });
  }

  private terminateCore(
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const parsed = shutdownSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(response, 400, { error: 'confirm must be TERMINATE' });
      return;
    }
    if (!this.shutdown) {
      this.sendJson(response, 501, { error: 'shutdown is not available in this runtime' });
      return;
    }

    this.audit('admin.shutdown', request, {});
    this.sendJson(response, 202, { ok: true, message: 'shutting down' });
    setTimeout(() => {
      void Promise.resolve(this.shutdown?.()).catch((error: unknown) => {
        this.logger.error({ err: error }, 'admin shutdown callback failed');
      });
    }, 150);
  }

  private async statusPayload(): Promise<Record<string, unknown>> {
    const status = this.runtime.status();
    const health = await this.runtime.adapter.health();
    return {
      ok: true,
      demo: this.demo,
      account: {
        idHash: hashId(status.accountId),
        sessionHash: hashId(status.sessionId),
      },
      loader: {
        process: health.process,
        loginState: health.loginState,
        dataPlane: health.dataPlane,
        qqBuild: health.qqBuild ?? null,
        detail: health.detail ?? null,
      },
      onebot: { clientState: status.clientState },
      health: status.health,
      sendGuard: status.sendGuard,
      pendingEvents: status.pendingEvents,
      replayableEvents: status.replayableEvents,
      serverTime: new Date(this.now()).toISOString(),
    };
  }

  private sendGuardPayload(): Record<string, unknown> {
    const status = this.runtime.status();
    const config = this.runtime.guard.configSnapshot();
    const quota = this.runtime.guard.quotaSnapshot(status.accountId);
    return {
      ok: true,
      circuit: {
        state: status.sendGuard.circuit,
        reason: status.sendGuard.circuitReason,
      },
      stopDisabled: status.sendGuard.stopDisabled,
      quota,
      config,
    };
  }

  private protocolPayload(): Record<string, unknown> {
    const config = this.readProtocolFile();
    const admin = isRecord(config.admin) ? config.admin : {};
    const upstream = isRecord(config.upstream) ? config.upstream : {};
    const astrbot = isRecord(config.astrbot) ? config.astrbot : {};
    const upstreamUrl = typeof upstream.url === 'string' ? upstream.url : 'ws://127.0.0.1:3001/';
    const reverseUrl = typeof astrbot.url === 'string' ? astrbot.url : 'ws://127.0.0.1:6199/ws';

    return {
      panel: {
        host: this.host,
        port: numberOr(admin.port, this.requestedPort),
      },
      onebot: {
        port: portFromUrl(upstreamUrl) ?? 3001,
        url: upstreamUrl,
        tokenConfigured: typeof upstream.token === 'string' && upstream.token.length > 0,
      },
      reverse: {
        url: reverseUrl,
        tokenConfigured: typeof astrbot.token === 'string' && astrbot.token.length > 0,
      },
      selfIdHash: hashId(typeof config.selfId === 'number' ? config.selfId : 0),
    };
  }

  private updateProtocol(
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const parsed = protocolPatchSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(response, 400, {
        error: 'invalid protocol config',
        details: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
      return;
    }
    const patch = definedProtocolPatch(parsed.data);
    if (Object.keys(patch).length === 0) {
      this.sendJson(response, 400, { error: 'empty config' });
      return;
    }

    const config = this.readProtocolFile();
    const admin = ensureRecord(config, 'admin');
    const upstream = ensureRecord(config, 'upstream');
    const astrbot = ensureRecord(config, 'astrbot');

    if (patch.panelPort !== undefined) {
      admin.port = patch.panelPort;
    }
    if (patch.onebotPort !== undefined) {
      upstream.url = replaceWsPort(
        typeof upstream.url === 'string' ? upstream.url : 'ws://127.0.0.1:3001/',
        patch.onebotPort,
      );
    }
    if (patch.onebotToken) {
      upstream.token = patch.onebotToken;
    }
    if (patch.reverseUrl !== undefined) {
      astrbot.url = patch.reverseUrl;
    }
    if (patch.reverseToken) {
      astrbot.token = patch.reverseToken;
    }

    this.writeProtocolFile(config);
    this.audit('protocol.config', request, {
      changed: Object.keys(patch),
      panelPort: admin.port,
      onebotUrl: upstream.url,
      reverseUrl: astrbot.url,
    });
    this.sendJson(response, 200, {
      ok: true,
      restartRequired: true,
      protocol: this.protocolPayload(),
    });
  }

  private async testProtocol(
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const parsed = protocolTestSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(response, 400, { error: 'invalid test request' });
      return;
    }

    const config = this.readProtocolFile();
    const upstream = isRecord(config.upstream) ? config.upstream : {};
    const astrbot = isRecord(config.astrbot) ? config.astrbot : {};
    const target = parsed.data.target ?? 'reverse';
    const url =
      parsed.data.url ??
      (target === 'reverse'
        ? typeof astrbot.url === 'string'
          ? astrbot.url
          : 'ws://127.0.0.1:6199/ws'
        : typeof upstream.url === 'string'
          ? upstream.url
          : 'ws://127.0.0.1:3001/');
    const savedToken =
      target === 'reverse'
        ? typeof astrbot.token === 'string'
          ? astrbot.token
          : ''
        : typeof upstream.token === 'string'
          ? upstream.token
          : '';
    const token = parsed.data.token ? parsed.data.token : savedToken;
    const selfId = typeof config.selfId === 'number' ? config.selfId : 0;

    const result = await checkWebSocket(url, token, selfId);
    this.audit('protocol.test', request, {
      target,
      url,
      result,
    });
    this.sendJson(response, 200, result);
  }

  private readProtocolFile(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(this.protocolConfigPath, 'utf8')) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeProtocolFile(config: Record<string, unknown>): void {
    mkdirSync(dirname(this.protocolConfigPath), { recursive: true });
    writeFileSync(this.protocolConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  private auditPayload(url: URL): Record<string, unknown> {
    const store = this.runtime.sendGuardStoreInstance;
    if (!store) {
      return { items: [], total: 0, limit: 0, offset: 0 };
    }

    const decision = url.searchParams.get('decision');
    const action = url.searchParams.get('action') ?? undefined;
    const query: AuditQuery = {
      limit: numberParam(url.searchParams.get('limit'), 50),
      offset: numberParam(url.searchParams.get('offset'), 0),
      ...(decision === 'allowed' || decision === 'blocked' ? { decision } : {}),
      ...(action ? { action } : {}),
    };
    const page = store.queryAudit(query);
    return {
      ...page,
      items: page.items.map((item) => ({
        id: item.id,
        action: item.action,
        targetType: item.targetType,
        targetHash: hashId(`${item.targetType}:${item.targetId}`),
        decision: item.decision,
        reason: item.reason,
        messageHash: item.messageHash,
        messageLength: item.messageLength,
        retcode: item.retcode,
        createdAt: item.createdAt,
      })),
    };
  }

  private handleAction(
    pathname: string,
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(response, 400, { error: 'invalid body' });
      return;
    }

    if (pathname === '/api/sendguard/stop') {
      if (parsed.data.confirm !== 'STOP') {
        this.sendJson(response, 400, { error: 'type STOP to confirm' });
        return;
      }
      this.runtime.guard.writeStopSentinel();
      this.audit('sendguard.stop', request, { stopFile: true });
      this.sendJson(response, 200, this.sendGuardPayload());
      return;
    }

    if (pathname === '/api/sendguard/resume') {
      if (parsed.data.confirm !== 'RESUME') {
        this.sendJson(response, 400, { error: 'type RESUME to confirm' });
        return;
      }
      this.runtime.guard.clearStopSentinel();
      this.audit('sendguard.resume', request, { stopFile: false });
      this.sendJson(response, 200, this.sendGuardPayload());
      return;
    }

    if (pathname === '/api/sendguard/reset') {
      if (parsed.data.confirm !== 'RESET') {
        this.sendJson(response, 400, { error: 'type RESET to confirm' });
        return;
      }
      this.runtime.guard.resetCircuit();
      this.audit('sendguard.reset', request, { circuit: 'CLOSED' });
      this.sendJson(response, 200, this.sendGuardPayload());
      return;
    }

    this.sendJson(response, 404, { error: 'not found' });
  }

  private updateConfig(
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const parsed = guardPatchSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(response, 400, {
        error: 'invalid config',
        details: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
      return;
    }

    const patch = definedPatch(parsed.data);
    if (Object.keys(patch).length === 0) {
      this.sendJson(response, 400, { error: 'empty config' });
      return;
    }

    this.runtime.guard.updateConfig(patch);
    const config = this.runtime.guard.configSnapshot();
    this.writeConfigFile(config);
    this.audit('sendguard.config', request, {
      changed: Object.keys(patch),
      config: writableConfig(config),
    });
    this.sendJson(response, 200, { ok: true, config });
  }

  private async readJsonOr400(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.readJson(request);
    } catch (error) {
      this.sendJson(response, 400, {
        error: 'invalid JSON body',
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) {
          reject(new Error('body too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(new Error('body must be an object'));
            return;
          }
          resolvePromise(parsed as Record<string, unknown>);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      request.on('error', reject);
    });
  }

  private loadConfigFile(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as unknown;
      const parsed = guardPatchSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(
          { configPath: this.configPath, issues: parsed.error.issues },
          'ignoring invalid send-guard config file',
        );
        return;
      }
      this.runtime.guard.updateConfig(definedPatch(parsed.data));
      this.logger.info({ configPath: this.configPath }, 'loaded send-guard config');
    } catch (error) {
      this.logger.warn(
        { err: error, configPath: this.configPath },
        'cannot read send-guard config',
      );
    }
  }

  private writeConfigFile(config: SendGuardConfig): void {
    const path = this.configPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(writableConfig(config), null, 2)}\n`, 'utf8');
  }

  private audit(action: string, request: IncomingMessage, details: unknown): void {
    this.runtime.sendGuardStoreInstance?.writeAdminAudit({
      actor: 'local-admin',
      action,
      ip: request.socket.remoteAddress ?? 'unknown',
      details,
      createdAt: this.now(),
    });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? '';
    const explicit = request.headers['x-admin-token'];
    const provided =
      header.replace(/^Bearer\s+/i, '').replace(/^Token\s+/i, '') ||
      (Array.isArray(explicit) ? explicit[0] : explicit) ||
      '';
    if (provided.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(this.token));
  }

  private serveStatic(pathname: string, response: ServerResponse): void {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const filePath = resolve(this.webRoot, `.${requested}`);
    if (!filePath.startsWith(`${this.webRoot}${sep}`) && filePath !== this.webRoot) {
      this.sendJson(response, 404, { error: 'not found' });
      return;
    }

    const target =
      existsSync(filePath) && !filePath.endsWith(sep)
        ? filePath
        : resolve(this.webRoot, 'index.html');
    if (!existsSync(target)) {
      this.sendJson(response, 404, { error: 'web assets not built' });
      return;
    }

    try {
      const body = readFileSync(target);
      response.writeHead(200, {
        'Content-Type': mimeType(target),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch {
      this.sendJson(response, 404, { error: 'not found' });
    }
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

function definedPatch(input: z.infer<typeof guardPatchSchema>): Partial<SendGuardConfig> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function definedProtocolPatch(
  input: z.infer<typeof protocolPatchSchema>,
): z.infer<typeof protocolPatchSchema> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

function isWsUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

function portFromUrl(value: string): number | null {
  try {
    const url = new URL(value);
    if (url.port) return Number(url.port);
    return url.protocol === 'wss:' ? 443 : 80;
  } catch {
    return null;
  }
}

function replaceWsPort(value: string, port: number): string {
  try {
    const url = new URL(value);
    url.port = String(port);
    return url.toString();
  } catch {
    return `ws://127.0.0.1:${port}/`;
  }
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function checkWebSocket(
  url: string,
  token: string,
  selfId: number,
): Promise<{ ok: boolean; status?: number; message?: string; latencyMs?: number }> {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let settled = false;
    const timerRef: { value: NodeJS.Timeout | undefined } = { value: undefined };
    const finish = (result: {
      ok: boolean;
      status?: number;
      message?: string;
      latencyMs?: number;
    }): void => {
      if (settled) return;
      settled = true;
      if (timerRef.value) clearTimeout(timerRef.value);
      resolvePromise({ ...result, latencyMs: Date.now() - startedAt });
    };

    const headers: Record<string, string> = {
      'X-Self-ID': String(selfId),
      'X-Client-Role': 'Universal',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { headers, handshakeTimeout: 4_000 });
    } catch (error) {
      resolvePromise({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    timerRef.value = setTimeout(() => {
      finish({ ok: false, message: 'timeout' });
      socket.terminate();
    }, 4_500);
    socket.on('open', () => {
      finish({ ok: true, status: 101 });
      socket.close();
    });
    socket.on('unexpected-response', (_request, response) => {
      finish({
        ok: false,
        ...(response.statusCode === undefined ? {} : { status: response.statusCode }),
        message: `handshake rejected: ${response.statusCode ?? 'unknown'}`,
      });
      socket.terminate();
    });
    socket.on('error', (error) => {
      finish({ ok: false, message: error.message });
    });
    socket.on('close', () => {
      finish({ ok: false, message: 'closed before open' });
    });
  });
}

function writableConfig(config: SendGuardConfig): GuardConfigFile {
  return {
    groupWhitelist: config.groupWhitelist,
    privateEnabled: config.privateEnabled,
    privateWhitelist: config.privateWhitelist,
    atOnly: config.atOnly,
    dailyQuota: config.dailyQuota,
    perGroupDailyQuota: config.perGroupDailyQuota,
    minIntervalMs: config.minIntervalMs,
    randomDelayMs: config.randomDelayMs,
    quietHours: config.quietHours,
    duplicateWindowMs: config.duplicateWindowMs,
    sendFailureThreshold: config.sendFailureThreshold,
    auditRetentionDays: config.auditRetentionDays,
  };
}

function hashId(value: number | string): string {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function numberParam(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
