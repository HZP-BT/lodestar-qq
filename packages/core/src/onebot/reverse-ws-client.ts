import WebSocket from 'ws';
import type { ClientOptions, RawData } from 'ws';

import { nullLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import { VERSION } from '../version.js';
import { ActionRouter, RETCODE } from './action-router.js';
import type { ActionHandler, SendGuardLike } from './action-router.js';
import { buildAuthHeaders, withQueryToken } from './auth.js';
import type { TokenPlacement, TokenScheme } from './auth.js';
import { ExponentialBackoff } from './backoff.js';
import { NotConnectedError, ProtocolError, InvalidStateError, errorMessage } from './errors.js';
import { Semaphore } from './semaphore.js';
import type { OneBotActionRequest, OneBotActionResponse, OneBotEvent } from './types.js';
import { isRecord } from './types.js';

export type ConnectionState =
  'idle' | 'connecting' | 'open' | 'waiting' | 'closed' | 'auth_failed' | 'handshake_failed';

export type HandshakeFailureKind = 'auth_failed' | 'handshake_failed';

/** Account login state, confirmed by the adapter; never inferred from the socket. */
export type LoginState = 'UNKNOWN' | 'LOGGED_IN' | 'LOGGED_OUT';

export interface HeartbeatStatus {
  loginState: LoginState;
  online: boolean;
  good: boolean;
}

export interface AuthFailureInfo {
  kind: HandshakeFailureKind;
  statusCode: number;
  url: string;
  tokenConfigured: boolean;
  hint: string;
}

export interface ReconnectOptions {
  enabled: boolean;
  baseMs: number;
  maxMs: number;
  jitter: number;
  /** Reset the backoff only after the connection stayed open this long. */
  resetAfterMs: number;
}

export interface HeartbeatOptions {
  enabled: boolean;
  intervalMs: number;
  /** Terminate the socket if no pong arrives within 2.5 intervals. */
  requirePong: boolean;
}

export interface ReverseWsClientOptions {
  /** AstrBot's reverse WebSocket endpoint, for example ws://127.0.0.1:6199/ws. */
  url: string;
  /** QQ account id, sent as X-Self-ID. */
  selfId: number;
  accessToken?: string;
  tokenScheme?: TokenScheme;
  tokenPlacement?: TokenPlacement;
  clientRole?: 'Universal' | 'Event' | 'Api';
  reconnect?: Partial<ReconnectOptions>;
  heartbeat?: Partial<HeartbeatOptions>;
  maxConcurrentActions?: number;
  actionTimeoutMs?: number;
  /** Core-owned send guard; applies to all adapters/backends. */
  sendGuard?: SendGuardLike;
  /** Adapter-confirmed login state. Defaults to UNKNOWN (online=false). */
  loginProvider?: () => LoginState;
  logger?: Logger;
  /** Injectable for tests or alternate WebSocket implementations. */
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

export interface OpenInfo {
  selfId: number;
  url: string;
}

export interface CloseInfo {
  code: number;
  reason: string;
  willReconnect: boolean;
}

export interface ReconnectingInfo {
  attempt: number;
  delayMs: number;
}

const DEFAULT_RECONNECT: ReconnectOptions = {
  enabled: true,
  baseMs: 1_000,
  maxMs: 30_000,
  jitter: 0.2,
  resetAfterMs: 10_000,
};

const DEFAULT_HEARTBEAT: HeartbeatOptions = {
  enabled: true,
  intervalMs: 30_000,
  requirePong: true,
};

class ListenerSet<TArgs extends unknown[]> {
  private readonly listeners = new Set<(...args: TArgs) => void>();

  constructor(
    private readonly logger: Logger,
    private readonly label: string,
  ) {}

  add(listener: (...args: TArgs) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: TArgs): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(...args);
      } catch (error) {
        this.logger.error({ err: error, listener: this.label }, 'listener threw');
      }
    }
  }
}

/**
 * OneBot v11 reverse WebSocket client.
 *
 * AstrBot is the WebSocket server. This client connects as a client, sends
 * events, receives action requests, and echoes AstrBot's `echo` object exactly
 * (aiocqhttp matches action results by echo.seq).
 */
export class ReverseWsClient {
  private readonly url: string;
  private readonly selfIdValue: number;
  private accessToken: string | undefined;
  private readonly tokenScheme: TokenScheme;
  private readonly tokenPlacement: TokenPlacement;
  private readonly clientRole: 'Universal' | 'Event' | 'Api';
  private readonly reconnect: ReconnectOptions;
  private readonly heartbeat: HeartbeatOptions;
  private readonly maxConcurrentActions: number;
  private readonly actionTimeoutMs: number;
  private loginProvider: () => LoginState;
  private readonly logger: Logger;
  private readonly webSocketFactory: (url: string, options: ClientOptions) => WebSocket;
  private readonly router: ActionRouter;
  private readonly backoff: ExponentialBackoff;
  private readonly semaphore: Semaphore;

  private readonly openListeners: ListenerSet<[OpenInfo]>;
  private readonly closeListeners: ListenerSet<[CloseInfo]>;
  private readonly errorListeners: ListenerSet<[Error]>;
  private readonly reconnectingListeners: ListenerSet<[ReconnectingInfo]>;
  private readonly eventListeners: ListenerSet<[OneBotEvent]>;
  private readonly authFailureListeners: ListenerSet<[AuthFailureInfo]>;

  private connectionState: ConnectionState = 'idle';
  private socket: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private fatalHandshake: HandshakeFailureKind | null = null;

  constructor(options: ReverseWsClientOptions) {
    const parsedUrl = new URL(options.url);

    if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
      throw new Error('url must use ws:// or wss://');
    }

    if (!Number.isInteger(options.selfId) || options.selfId < 0) {
      throw new Error('selfId must be a non-negative integer');
    }

    this.url = options.url;
    this.selfIdValue = options.selfId;
    this.accessToken = options.accessToken;
    this.tokenScheme = options.tokenScheme ?? 'Bearer';
    this.tokenPlacement = options.tokenPlacement ?? 'header';
    this.clientRole = options.clientRole ?? 'Universal';
    this.reconnect = {
      enabled: options.reconnect?.enabled ?? DEFAULT_RECONNECT.enabled,
      baseMs: options.reconnect?.baseMs ?? DEFAULT_RECONNECT.baseMs,
      maxMs: options.reconnect?.maxMs ?? DEFAULT_RECONNECT.maxMs,
      jitter: options.reconnect?.jitter ?? DEFAULT_RECONNECT.jitter,
      resetAfterMs: options.reconnect?.resetAfterMs ?? DEFAULT_RECONNECT.resetAfterMs,
    };
    this.heartbeat = {
      enabled: options.heartbeat?.enabled ?? DEFAULT_HEARTBEAT.enabled,
      intervalMs: options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT.intervalMs,
      requirePong: options.heartbeat?.requirePong ?? DEFAULT_HEARTBEAT.requirePong,
    };
    this.maxConcurrentActions = options.maxConcurrentActions ?? 8;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 30_000;
    this.loginProvider = options.loginProvider ?? (() => 'UNKNOWN');
    this.logger = options.logger ?? nullLogger;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));

    this.backoff = new ExponentialBackoff({
      baseMs: this.reconnect.baseMs,
      maxMs: this.reconnect.maxMs,
      jitter: this.reconnect.jitter,
    });
    this.semaphore = new Semaphore(this.maxConcurrentActions);
    this.router = new ActionRouter(options.sendGuard);

    this.openListeners = new ListenerSet(this.logger, 'open');
    this.closeListeners = new ListenerSet(this.logger, 'close');
    this.errorListeners = new ListenerSet(this.logger, 'error');
    this.reconnectingListeners = new ListenerSet(this.logger, 'reconnecting');
    this.eventListeners = new ListenerSet(this.logger, 'event');
    this.authFailureListeners = new ListenerSet(this.logger, 'auth-failure');
  }

  get selfId(): number {
    return this.selfIdValue;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get isOpen(): boolean {
    return this.connectionState === 'open' && this.socket?.readyState === WebSocket.OPEN;
  }

  get actionNames(): string[] {
    return this.router.list();
  }

  get heartbeatStatus(): HeartbeatStatus {
    return this.deriveHeartbeatStatus();
  }

  /** Wire the adapter's confirmed login state into heartbeat output. */
  setLoginProvider(provider: () => LoginState): void {
    this.loginProvider = provider;
  }

  registerAction(action: string, handler: ActionHandler): this {
    this.router.register(action, handler);
    return this;
  }

  registerFallbackAction(handler: ActionHandler): this {
    this.router.setFallback(handler);
    return this;
  }

  onOpen(listener: (info: OpenInfo) => void): () => void {
    return this.openListeners.add(listener);
  }

  onClose(listener: (info: CloseInfo) => void): () => void {
    return this.closeListeners.add(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return this.errorListeners.add(listener);
  }

  onReconnecting(listener: (info: ReconnectingInfo) => void): () => void {
    return this.reconnectingListeners.add(listener);
  }

  onEvent(listener: (event: OneBotEvent) => void): () => void {
    return this.eventListeners.add(listener);
  }

  onAuthFailure(listener: (info: AuthFailureInfo) => void): () => void {
    return this.authFailureListeners.add(listener);
  }

  /** Replace the token before calling resume() after an auth_failed state. */
  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
  }

  /**
   * Leave auth_failed / handshake_failed after the operator fixed the config.
   * This closes any stale socket first, then performs exactly one new attempt;
   * a deterministic failure returns to the failed state instead of a retry storm.
   */
  async resume(): Promise<void> {
    if (!this.running) {
      throw new InvalidStateError('Cannot resume: the client is stopped');
    }

    if (this.connectionState !== 'auth_failed' && this.connectionState !== 'handshake_failed') {
      throw new InvalidStateError(`Cannot resume from connection state ${this.connectionState}`);
    }

    const ws = this.socket;
    this.socket = null;
    this.fatalHandshake = null;
    this.stopHeartbeat();
    this.clearStableReset();

    if (ws) {
      await this.closeSocket(ws, 'polaris resume');
    }

    this.setState('closed');
    this.connect();
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.connect();
  }

  async stop(): Promise<void> {
    if (!this.running && this.socket === null) {
      this.setState('closed');
      return;
    }

    this.running = false;
    this.clearReconnectTimer();
    this.clearStableReset();
    this.stopHeartbeat();

    const ws = this.socket;
    this.socket = null;

    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.setState('closed');
      this.closeListeners.emit({ code: 1000, reason: 'client stopped', willReconnect: false });
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        ws.terminate();
        finish();
      }, 3_000);
      timer.unref?.();

      ws.once('close', finish);

      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'polaris stopped');
        } else {
          ws.terminate();
          finish();
        }
      } catch {
        ws.terminate();
        finish();
      }
    });

    this.setState('closed');
  }

  sendEvent(event: OneBotEvent): void {
    if (!this.sendRaw(event)) {
      throw new NotConnectedError('Cannot send OneBot event: reverse WS is not open');
    }
  }

  private connect(): void {
    if (!this.running || this.connectionState === 'connecting' || this.connectionState === 'open') {
      return;
    }

    // Defensive: never allow two live sockets. A stale socket can only exist
    // after a failed handshake; close it before creating a replacement.
    if (this.socket) {
      this.socket.terminate();
      this.socket = null;
    }

    this.clearReconnectTimer();
    this.fatalHandshake = null;
    this.setState('connecting');

    const url = withQueryToken(this.url, this.accessToken, this.tokenPlacement);
    let ws: WebSocket;

    try {
      ws = this.webSocketFactory(url, {
        headers: this.buildHeaders(),
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
      });
    } catch (error) {
      this.handleConnectError(error);
      return;
    }

    this.socket = ws;

    ws.on('open', () => {
      this.handleOpen(ws);
    });
    ws.on('message', (data: RawData) => {
      this.handleMessage(ws, data);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(ws, code, reason.toString());
    });
    ws.on('error', (error: Error) => {
      this.handleError(ws, error);
    });
    ws.on('unexpected-response', (request, response) => {
      const statusCode = response.statusCode ?? 0;
      this.handleUnexpectedResponse(ws, statusCode);
      response.resume();
      request.destroy();
    });
    ws.on('pong', () => {
      if (this.socket === ws) {
        this.lastPongAt = Date.now();
      }
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      'X-Self-ID': String(this.selfIdValue),
      'X-Client-Role': this.clientRole,
      'User-Agent': `lodestar-qq/${VERSION}`,
      ...buildAuthHeaders(this.accessToken, this.tokenScheme),
    };
  }

  private handleOpen(ws: WebSocket): void {
    if (this.socket !== ws) {
      return;
    }

    this.setState('open');
    this.lastPongAt = Date.now();
    this.logger.info(
      { url: this.url, selfId: this.selfIdValue, role: this.clientRole },
      'OneBot reverse WS connected',
    );
    this.openListeners.emit({ selfId: this.selfIdValue, url: this.url });

    this.startHeartbeat();
    this.sendLifecycle('connect');
    this.scheduleStableReset();
  }

  private handleMessage(ws: WebSocket, data: RawData): void {
    if (this.socket !== ws) {
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(rawDataToString(data));
    } catch (error) {
      this.logger.warn({ err: error }, 'received invalid JSON from reverse WS');
      return;
    }

    if (!isRecord(payload)) {
      this.logger.warn({ payload }, 'received non-object payload from reverse WS');
      return;
    }

    if (typeof payload.post_type === 'string') {
      this.eventListeners.emit(payload as unknown as OneBotEvent);
      return;
    }

    if (typeof payload.action === 'string') {
      const request: OneBotActionRequest = {
        action: payload.action,
        ...(Object.hasOwn(payload, 'params') ? { params: payload.params } : {}),
        ...(Object.hasOwn(payload, 'echo') ? { echo: payload.echo } : {}),
      };

      void this.dispatchAction(request);
      return;
    }

    this.logger.debug({ payload }, 'ignoring unknown OneBot payload');
  }

  private async dispatchAction(request: OneBotActionRequest): Promise<void> {
    const release = await this.semaphore.acquire();

    try {
      const response = await withTimeout(
        this.router.dispatch(request, this.selfIdValue),
        this.actionTimeoutMs,
        `Action ${request.action} timed out after ${this.actionTimeoutMs}ms`,
      );

      if (!this.sendRaw(response)) {
        this.logger.warn(
          { action: request.action },
          'dropping action response because the socket is not open',
        );
      }
    } catch (error) {
      const retcode =
        error instanceof ProtocolError && error.code === 'ACTION_TIMEOUT'
          ? RETCODE.ACTION_TIMEOUT
          : RETCODE.INTERNAL_ERROR;

      const failure: OneBotActionResponse = {
        status: 'failed',
        retcode,
        data: null,
        message: errorMessage(error),
        ...(request.echo === undefined ? {} : { echo: request.echo }),
      };

      this.sendRaw(failure);
      this.logger.error({ err: error, action: request.action }, 'action dispatch failed');
    } finally {
      release();
    }
  }

  private sendRaw(payload: unknown): boolean {
    const ws = this.socket;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, 'failed to send reverse WS payload');
      return false;
    }
  }

  private sendLifecycle(subType: 'connect' | 'disconnect'): void {
    try {
      this.sendEvent({
        time: nowSeconds(),
        self_id: this.selfIdValue,
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: subType,
      });
    } catch (error) {
      this.logger.warn({ err: error, subType }, 'failed to send lifecycle event');
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    if (!this.heartbeat.enabled) {
      return;
    }

    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.socket;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();

      if (this.heartbeat.requirePong && now - this.lastPongAt > this.heartbeat.intervalMs * 2.5) {
        this.logger.warn(
          { lastPongAgeMs: now - this.lastPongAt },
          'heartbeat pong timed out; terminating socket',
        );
        ws.terminate();
        return;
      }

      try {
        ws.ping();
      } catch (error) {
        this.logger.warn({ err: error }, 'failed to send WebSocket ping');
      }

      this.sendHeartbeatEvent();
    }, this.heartbeat.intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeatEvent(): void {
    const health = this.deriveHeartbeatStatus();

    // Only standard OneBot fields by default. online and good both require an
    // adapter-confirmed login on an open socket. No state extension is sent.
    const event: OneBotEvent = {
      time: nowSeconds(),
      self_id: this.selfIdValue,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: health.online, good: health.good },
      interval: this.heartbeat.intervalMs,
    };

    this.sendRaw(event);
  }

  private deriveHeartbeatStatus(): HeartbeatStatus {
    const loginState = this.loginProvider();
    const usable = this.isOpen && loginState === 'LOGGED_IN';

    return {
      loginState,
      online: usable,
      good: usable,
    };
  }

  private async closeSocket(ws: WebSocket, reason: string, timeoutMs = 1_000): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        ws.terminate();
        finish();
      }, timeoutMs);
      timer.unref?.();

      ws.once('close', finish);

      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, reason);
        } else {
          ws.terminate();
          finish();
        }
      } catch {
        ws.terminate();
        finish();
      }
    });
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (this.socket !== ws) {
      return;
    }

    this.socket = null;
    this.stopHeartbeat();
    this.clearStableReset();

    if (this.fatalHandshake) {
      const kind = this.fatalHandshake;
      this.fatalHandshake = null;
      this.setState(kind);
      this.logger.warn(
        { code, reason, kind },
        'OneBot reverse WS closed after a deterministic handshake failure',
      );
      this.closeListeners.emit({ code, reason, willReconnect: false });
      return;
    }

    const willReconnect = this.running && this.reconnect.enabled;
    this.setState(willReconnect ? 'waiting' : 'closed');
    this.logger.warn({ code, reason, willReconnect }, 'OneBot reverse WS closed');
    this.closeListeners.emit({ code, reason, willReconnect });

    if (willReconnect) {
      this.scheduleReconnect();
    }
  }

  private handleUnexpectedResponse(ws: WebSocket, statusCode: number): void {
    if (this.socket !== ws) {
      return;
    }

    const kind = classifyHandshakeStatus(statusCode);

    if (kind === 'transient') {
      this.logger.warn(
        { statusCode, url: redactUrl(this.url) },
        'transient WebSocket handshake rejection; reconnect backoff will be used',
      );
      return;
    }

    this.fatalHandshake = kind;
    this.setState(kind);

    const info: AuthFailureInfo = {
      kind,
      statusCode,
      url: redactUrl(this.url),
      tokenConfigured: Boolean(this.accessToken),
      hint:
        kind === 'auth_failed'
          ? 'Check the AstrBot OneBot v11 token; Lodestar sends Authorization: Bearer <token>.'
          : 'Check the reverse WebSocket path and port; aiocqhttp expects /ws.',
    };

    this.logger.error(
      { ...info },
      kind === 'auth_failed'
        ? 'OneBot reverse WS authentication failed; automatic reconnect disabled'
        : 'OneBot reverse WS handshake rejected; automatic reconnect disabled',
    );
    this.authFailureListeners.emit(info);
  }

  private handleError(ws: WebSocket, error: Error): void {
    if (this.socket !== ws) {
      return;
    }

    this.logger.error({ err: error }, 'OneBot reverse WS error');
    this.errorListeners.emit(error);
  }

  private handleConnectError(error: unknown): void {
    this.logger.error({ err: error }, 'failed to create reverse WS connection');
    this.errorListeners.emit(toError(error));
    this.socket = null;
    this.setState('closed');

    if (this.running && this.reconnect.enabled) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || !this.reconnect.enabled || this.reconnectTimer) {
      return;
    }

    const attempt = this.backoff.attempt + 1;
    const delayMs = this.backoff.next();
    this.setState('waiting');
    this.logger.info({ attempt, delayMs }, 'scheduling OneBot reverse WS reconnect');
    this.reconnectingListeners.emit({ attempt, delayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleStableReset(): void {
    this.clearStableReset();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;

      if (this.isOpen) {
        this.backoff.reset();
        this.logger.debug('connection stable; reconnect backoff reset');
      }
    }, this.reconnect.resetAfterMs);
    this.stableTimer.unref?.();
  }

  private clearStableReset(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.connectionState === next) {
      return;
    }

    this.logger.debug({ from: this.connectionState, to: next }, 'OneBot reverse WS state changed');
    this.connectionState = next;
  }
}

export function classifyHandshakeStatus(statusCode: number): HandshakeFailureKind | 'transient' {
  if (statusCode === 401 || statusCode === 403) {
    return 'auth_failed';
  }

  if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
    return 'handshake_failed';
  }

  return 'transient';
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.searchParams.delete('access_token');
    return parsed.toString();
  } catch {
    return url;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProtocolError(message, 'ACTION_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toError(error));
      },
    );
  });
}
