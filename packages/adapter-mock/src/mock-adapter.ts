import { randomUUID } from 'node:crypto';

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

export interface MockAdapterOptions {
  accountId: number;
  now?: () => number;
  /** Prefix for generated sourceEventIds; defaults to a per-process UUID. */
  sourcePrefix?: string;
}

export class MockAdapter implements AdapterInterface {
  readonly accountId: number;

  private readonly now: () => number;
  private readonly sourcePrefix: string;
  private sink: EventSink | null = null;
  private session: AdapterSession | null = null;
  private replayManifest: string[] = [];

  private processState: AdapterHealth['process'] = 'starting';
  private loginState: AdapterLoginState = 'UNKNOWN';
  private dataPlane: AdapterHealth['dataPlane'] = 'unknown';
  private inboundCursor = 0;
  private lastInboundAt = 0;
  private inboundNonceSeen: string | undefined;
  private eventSeq = 0;
  private lastEventAt = 0;
  private qqBuild = 'mock-1';

  private frozenAll = false;
  private frozenEvents = false;
  private authFailed = false;
  private slowActionMs = 0;
  private sourceCounter = 0;
  private messageCounter = 0;
  private readonly sent: Array<{ action: string; params: Record<string, unknown> }> = [];

  constructor(options: MockAdapterOptions) {
    this.accountId = options.accountId;
    this.now = options.now ?? Date.now;
    this.sourcePrefix = options.sourcePrefix ?? randomUUID();
  }

  start(sink: EventSink, session: AdapterSession, replayManifest: string[] = []): Promise<void> {
    this.sink = sink;
    this.session = session;
    this.replayManifest = [...replayManifest];
    this.processState = 'ready';
    this.loginState = 'LOGGED_IN';
    this.dataPlane = 'healthy';
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.processState = 'stopped';
    this.dataPlane = 'dead';
    this.sink = null;
    return Promise.resolve();
  }

  async execute(
    action: string,
    params: Record<string, unknown>,
    context: ActionContext,
  ): Promise<{ ok: boolean; data?: unknown; retcode?: number; message?: string }> {
    void context;
    if (this.processState !== 'ready' || this.frozenAll) {
      return { ok: false, retcode: 1502, message: 'adapter unavailable' };
    }

    if (this.slowActionMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, this.slowActionMs);
      });
    }

    if (this.authFailed && action === 'get_login_info') {
      return { ok: false, retcode: 1506, message: 'unauthorized' };
    }

    if (action === 'get_login_info') {
      return {
        ok: true,
        data: { user_id: this.accountId, nickname: 'Lodestar Mock' },
      };
    }

    if (action === 'send_group_msg' || action === 'send_private_msg') {
      this.sent.push({ action, params });
      this.messageCounter += 1;
      return { ok: true, data: { message_id: this.messageCounter } };
    }

    return { ok: false, retcode: 1404, message: `action not found: ${action}` };
  }

  health(): Promise<AdapterHealth> {
    return Promise.resolve({
      process: this.processState,
      loginState: this.loginState,
      dataPlane: this.dataPlane,
      inboundCursor: this.inboundCursor,
      lastInboundAt: this.lastInboundAt,
      ...(this.inboundNonceSeen === undefined ? {} : { inboundNonceSeen: this.inboundNonceSeen }),
      eventSeq: this.eventSeq,
      lastEventAt: this.lastEventAt,
      qqBuild: this.qqBuild,
      detail: this.frozenAll ? 'frozen-all' : this.frozenEvents ? 'frozen-events' : 'ok',
    });
  }

  capabilities(): AdapterCapabilities {
    return {
      protocol: 'onebot11',
      actions: ['get_login_info', 'send_group_msg', 'send_private_msg'],
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
        adapter: 'mock-1',
        qqBuild: this.qqBuild,
      },
    };
  }

  async emitText(
    text: string,
    options: { groupId?: number; sourceEventId?: string } = {},
  ): Promise<ReturnType<EventSink['publish']> | null> {
    const payload: OneBotEvent = {
      time: Math.floor(this.now() / 1_000),
      self_id: this.accountId,
      post_type: 'message',
      message_type: options.groupId === undefined ? 'private' : 'group',
      ...(options.groupId === undefined ? {} : { group_id: options.groupId }),
      raw_message: text,
      message: text,
    };

    return this.emitPayload(payload, options.sourceEventId);
  }

  async emitMeta(
    metaEventType: 'heartbeat' | 'lifecycle',
  ): Promise<ReturnType<EventSink['publish']> | null> {
    const payload: OneBotEvent = {
      time: Math.floor(this.now() / 1_000),
      self_id: this.accountId,
      post_type: 'meta_event',
      meta_event_type: metaEventType,
    };

    return this.emitPayload(payload);
  }

  /** Simulates a raw inbound canary before any Core whitelist/filtering. */
  canary(nonce: string): void {
    if (this.processState !== 'ready' || this.frozenAll) {
      return;
    }

    this.inboundCursor += 1;
    this.lastInboundAt = this.now();
    this.inboundNonceSeen = nonce;
  }

  freeze(): void {
    this.frozenAll = true;
    this.dataPlane = 'silent';
  }

  freezeEvents(): void {
    this.frozenEvents = true;
    this.dataPlane = 'silent';
  }

  resumeData(): void {
    this.frozenAll = false;
    this.frozenEvents = false;
    this.dataPlane = 'healthy';
  }

  crash(): void {
    this.processState = 'stopped';
    this.dataPlane = 'dead';
  }

  slowAction(ms: number): void {
    this.slowActionMs = ms;
  }

  authFail(): void {
    this.authFailed = true;
    this.loginState = 'LOGGED_OUT';
    this.dataPlane = 'dead';
  }

  setVersion(qqBuild: string): void {
    this.qqBuild = qqBuild;
  }

  get sentMessages(): ReadonlyArray<{ action: string; params: Record<string, unknown> }> {
    return this.sent;
  }

  get receivedReplayManifest(): ReadonlyArray<string> {
    return this.replayManifest;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  private async emitPayload(
    payload: OneBotEvent,
    sourceEventId?: string,
  ): Promise<ReturnType<EventSink['publish']> | null> {
    if (
      this.sink === null ||
      this.processState !== 'ready' ||
      this.frozenAll ||
      this.frozenEvents
    ) {
      return null;
    }

    this.sourceCounter += 1;
    const event: AdapterEvent = {
      accountId: this.accountId,
      occurredAt: this.now(),
      sourceEventId: sourceEventId ?? `mock-${this.sourcePrefix}-${this.sourceCounter}`,
      nativeMessageId: `mock-native-${this.sourcePrefix}-${this.sourceCounter}`,
      payload,
    };

    this.inboundCursor += 1;
    this.lastInboundAt = this.now();
    this.eventSeq += 1;
    this.lastEventAt = this.lastInboundAt;

    return this.sink.publish(event);
  }
}
