import WebSocket from 'ws';
import type { ClientOptions, RawData } from 'ws';

import type {
  ActionContext,
  AdapterCapabilities,
  AdapterEvent,
  AdapterHealth,
  AdapterInterface,
  AdapterLoginState,
  AdapterSession,
  EventSink,
  OneBotEvent,
} from './protocol.js';

export interface UpstreamLogger {
  debug(obj: Record<string, unknown>, message?: string): void;
  info(obj: Record<string, unknown>, message?: string): void;
  warn(obj: Record<string, unknown>, message?: string): void;
  error(obj: Record<string, unknown>, message?: string): void;
}

const nullLogger: UpstreamLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface UpstreamReconnectOptions {
  enabled: boolean;
  baseMs: number;
  maxMs: number;
  jitter: number;
}

export interface OneBotUpstreamOptions {
  /** OneBot v11 WebSocket server exposed by NapCat/SnowLuma/LLOneBot. */
  url: string;
  selfId: number;
  accessToken?: string;
  reconnect?: Partial<UpstreamReconnectOptions>;
  actionTimeoutMs?: number;
  logger?: UpstreamLogger;
  now?: () => number;
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

type ConnectionState = 'idle' | 'connecting' | 'open' | 'waiting' | 'closed' | 'auth_failed';

interface PendingAction {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * OneBot v11 upstream adapter: connects to an existing protocol-side backend
 * (NapCat/SnowLuma/LLOneBot) as a WebSocket client, forwards events into
 * Core's EventSink, and proxies actions with echo correlation.
 */
export class OneBotUpstreamAdapter implements AdapterInterface {
  readonly accountId: number;

  private readonly url: string;
  private accessToken: string | undefined;
  private readonly reconnect: UpstreamReconnectOptions;
  private readonly actionTimeoutMs: number;
  private readonly logger: UpstreamLogger;
  private readonly now: () => number;
  private readonly webSocketFactory: (url: string, options: ClientOptions) => WebSocket;

  private sink: EventSink | null = null;
  private replayManifest: string[] = [];
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private stopped = false;
  private authFailed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private resetTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  private loginState: AdapterLoginState = 'UNKNOWN';
  private inboundCursor = 0;
  private lastInboundAt = 0;
  private eventSeq = 0;
  private lastEventAt = 0;
  private qqBuild: string | undefined;
  private lastError: string | undefined;

  private echoCounter = 0;
  private readonly pending = new Map<string, PendingAction>();

  constructor(options: OneBotUpstreamOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('upstream url must use ws:// or wss://');
    }
    if (!Number.isInteger(options.selfId) || options.selfId < 0) {
      throw new Error('selfId must be a non-negative integer');
    }

    this.url = options.url;
    this.accountId = options.selfId;
    this.accessToken = options.accessToken;
    this.reconnect = {
      enabled: options.reconnect?.enabled ?? true,
      baseMs: options.reconnect?.baseMs ?? 1_000,
      maxMs: options.reconnect?.maxMs ?? 30_000,
      jitter: options.reconnect?.jitter ?? 0.2,
    };
    this.actionTimeoutMs = options.actionTimeoutMs ?? 15_000;
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? Date.now;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.state === 'open' && this.socket?.readyState === WebSocket.OPEN;
  }

  get receivedReplayManifest(): ReadonlyArray<string> {
    return this.replayManifest;
  }

  setAccessToken(token: string | undefined): void {
    // Effective on the next resume()/reconnect; the running socket is unchanged.
    this.accessToken = token;
  }

  async start(
    sink: EventSink,
    session: AdapterSession,
    replayManifest: string[] = [],
  ): Promise<void> {
    void session;
    this.sink = sink;
    this.replayManifest = [...replayManifest];
    this.stopped = false;
    this.connect();
    await this.waitForOpen(5_000);
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearResetTimer();

    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new Error('adapter stopped'));

    if (socket) {
      try {
        socket.close(1000, 'polaris adapter stopped');
      } catch {
        socket.terminate();
      }
    }

    this.state = 'closed';
    return Promise.resolve();
  }

  async execute(
    action: string,
    params: Record<string, unknown>,
    context: ActionContext,
  ): Promise<{
    ok: boolean;
    data?: unknown;
    retcode?: number;
    message?: string;
    latencyMs?: number;
  }> {
    void context;
    if (!this.isOpen || !this.socket) {
      return { ok: false, retcode: 1502, message: 'upstream is not connected' };
    }

    const echo = `polaris-${++this.echoCounter}`;
    const startedAt = this.now();

    try {
      const payload = await this.request(action, params, echo);
      const retcode = typeof payload.retcode === 'number' ? payload.retcode : 0;
      const ok = payload.status === 'ok' || payload.status === 'async';

      if (action === 'get_login_info' && ok) {
        this.updateLoginFromPayload(payload.data);
      }
      if (action === 'get_version_info' && ok && isRecord(payload.data)) {
        const appVersion = payload.data.app_version;
        const protocolVersion = payload.data.protocol_version;
        if (typeof appVersion === 'string') {
          this.qqBuild =
            typeof protocolVersion === 'string' ? `${appVersion}/${protocolVersion}` : appVersion;
        }
      }

      return {
        ok,
        ...(payload.data === undefined ? {} : { data: payload.data }),
        retcode,
        ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
        latencyMs: this.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = message.includes('timed out');
      this.logger.warn({ action, message }, 'upstream action failed');
      return {
        ok: false,
        retcode: timedOut ? 1501 : 1502,
        message,
        latencyMs: this.now() - startedAt,
      };
    }
  }

  health(): Promise<AdapterHealth> {
    return Promise.resolve({
      process: this.stopped ? 'stopped' : 'ready',
      loginState: this.loginState,
      dataPlane: this.isOpen ? 'healthy' : this.authFailed ? 'dead' : 'silent',
      inboundCursor: this.inboundCursor,
      lastInboundAt: this.lastInboundAt,
      eventSeq: this.eventSeq,
      lastEventAt: this.lastEventAt,
      ...(this.qqBuild === undefined ? {} : { qqBuild: this.qqBuild }),
      detail: this.lastError ?? this.state,
    });
  }

  capabilities(): AdapterCapabilities {
    return {
      protocol: 'onebot11',
      actions: [
        'get_login_info',
        'get_version_info',
        'get_status',
        'send_private_msg',
        'send_group_msg',
        'send_msg',
        'delete_msg',
        'get_msg',
        'get_forward_msg',
        'get_friend_list',
        'get_group_list',
        'get_group_info',
        'get_group_member_info',
        'get_group_member_list',
        'get_stranger_info',
        'set_group_ban',
        'set_group_kick',
        'set_group_card',
        'set_group_name',
        'set_group_admin',
        'set_group_leave',
        'set_group_whole_ban',
        'upload_group_file',
        'get_group_file_url',
        'get_group_root_files',
        'get_group_files_by_folder',
      ],
      events: ['message', 'notice', 'request'],
      media: {
        image: true,
        voice: true,
        video: true,
        file: true,
        forward: true,
      },
      multiAccount: false,
      version: {
        adapter: 'onebot-upstream/0.1.0',
        ...(this.qqBuild === undefined ? {} : { qqBuild: this.qqBuild }),
      },
    };
  }

  resume(): void {
    if (!this.authFailed) {
      return;
    }
    this.authFailed = false;
    this.state = 'closed';
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.authFailed) {
      return;
    }
    if (this.state === 'connecting' || this.state === 'open') {
      return;
    }

    this.clearReconnectTimer();
    this.state = 'connecting';

    const headers: Record<string, string> = {
      'User-Agent': 'lodestar-qq/onebot-upstream',
      'X-Self-ID': String(this.accountId),
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(this.url, {
        headers,
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, 'failed to create upstream websocket');
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.on('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.state = 'open';
      this.lastError = undefined;
      this.reconnectAttempt = 0;
      this.logger.info({ url: this.url, selfId: this.accountId }, 'upstream connected');
      this.scheduleReset();
      void this.refreshLogin();
    });

    socket.on('message', (data: RawData) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleMessage(data);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.state = this.authFailed ? 'auth_failed' : 'closed';
      this.rejectPending(new Error(`upstream closed: ${code} ${reason.toString()}`));
      this.logger.warn({ code, reason: reason.toString() }, 'upstream closed');
      if (!this.stopped && !this.authFailed) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (error: Error) => {
      if (this.socket !== socket) {
        return;
      }
      this.lastError = error.message;
      this.logger.error({ err: error }, 'upstream websocket error');
    });

    socket.on('unexpected-response', (request, response) => {
      const statusCode = response.statusCode ?? 0;
      this.lastError = `handshake rejected: ${statusCode}`;
      if (statusCode === 401 || statusCode === 403) {
        this.authFailed = true;
        this.state = 'auth_failed';
        this.rejectPending(new Error('upstream authentication failed'));
        this.logger.error(
          { statusCode, url: this.url },
          'upstream authentication failed; automatic reconnect disabled',
        );
      }
      response.resume();
      request.destroy();
    });
  }

  private handleMessage(data: RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(rawDataToString(data));
    } catch {
      this.logger.warn({}, 'upstream sent invalid JSON');
      return;
    }

    if (!isRecord(payload)) {
      return;
    }

    if (typeof payload.post_type === 'string') {
      this.handleEvent(payload);
      return;
    }

    const echo = payload.echo;
    if (typeof echo === 'string') {
      const pending = this.pending.get(echo);
      if (pending) {
        this.pending.delete(echo);
        clearTimeout(pending.timer);
        pending.resolve(payload);
        return;
      }
    }

    this.logger.debug({ payload }, 'upstream payload ignored');
  }

  private handleEvent(payload: Record<string, unknown>): void {
    const postType = payload.post_type;
    if (typeof postType !== 'string') {
      return;
    }

    if (postType === 'meta_event') {
      return;
    }

    if (postType !== 'message' && postType !== 'notice' && postType !== 'request') {
      this.logger.debug({ postType }, 'upstream event ignored');
      return;
    }

    this.inboundCursor += 1;
    this.eventSeq += 1;
    this.lastInboundAt = this.now();
    this.lastEventAt = this.lastInboundAt;

    if (!this.sink) {
      return;
    }

    const messageId = payload.message_id;
    const nativeMessageId =
      typeof messageId === 'string' || typeof messageId === 'number' ? messageId : undefined;

    const event: AdapterEvent = {
      accountId: this.accountId,
      occurredAt: typeof payload.time === 'number' ? Math.round(payload.time * 1_000) : this.now(),
      ...(postType === 'message' && nativeMessageId !== undefined
        ? { sourceEventId: String(nativeMessageId) }
        : {}),
      ...(nativeMessageId === undefined ? {} : { nativeMessageId }),
      payload: payload as OneBotEvent,
      priority: 'normal',
    };

    void this.publishEvent(event);
  }

  private async publishEvent(event: AdapterEvent): Promise<void> {
    if (!this.sink) {
      return;
    }

    try {
      const result = await this.sink.publish(event);
      if (!result.accepted && result.reason === 'backpressure') {
        this.logger.warn(
          { retryAfterMs: result.retryAfterMs },
          'upstream backpressure; pausing socket briefly',
        );
        this.socket?.pause();
        const timer = setTimeout(() => {
          this.socket?.resume();
        }, result.retryAfterMs ?? 1_000);
        timer.unref?.();
      }
    } catch (error) {
      this.logger.error({ err: error }, 'failed to publish upstream event');
    }
  }

  private request(
    action: string,
    params: Record<string, unknown>,
    echo: string,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('upstream is not connected'));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`upstream action ${action} timed out after ${this.actionTimeoutMs}ms`));
      }, this.actionTimeoutMs);
      timer.unref?.();

      this.pending.set(echo, { resolve, reject, timer });

      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async refreshLogin(): Promise<void> {
    const result = await this.execute(
      'get_login_info',
      {},
      { action: 'get_login_info', selfId: this.accountId, echo: null },
    );
    if (result.ok) {
      this.updateLoginFromPayload(result.data);
    } else {
      this.loginState = 'UNKNOWN';
    }
  }

  private updateLoginFromPayload(data: unknown): void {
    if (isRecord(data) && typeof data.user_id === 'number') {
      this.loginState = data.user_id > 0 ? 'LOGGED_IN' : 'LOGGED_OUT';
    } else {
      this.loginState = 'UNKNOWN';
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.authFailed || !this.reconnect.enabled || this.reconnectTimer) {
      return;
    }

    const exponent = Math.min(this.reconnectAttempt, 20);
    const nominal = Math.min(this.reconnect.maxMs, this.reconnect.baseMs * 2 ** exponent);
    this.reconnectAttempt += 1;
    const jitter = nominal * this.reconnect.jitter * (Math.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(nominal + jitter));

    this.state = 'waiting';
    this.logger.info({ attempt: this.reconnectAttempt, delayMs }, 'scheduling upstream reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.state = 'closed';
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private scheduleReset(): void {
    this.clearResetTimer();
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      if (this.isOpen) {
        this.reconnectAttempt = 0;
      }
    }, 10_000);
    this.resetTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearResetTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private async waitForOpen(timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (this.isOpen || this.authFailed || this.stopped) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
