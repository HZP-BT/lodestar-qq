import type { OneBotEvent } from '../onebot/types.js';
import type { ActionContext } from '../onebot/action-router.js';

export type EventPriority = 'critical' | 'normal' | 'low';

export type AdapterLoginState = 'UNKNOWN' | 'LOGGED_IN' | 'LOGGED_OUT';

export interface AdapterHealth {
  process: 'starting' | 'ready' | 'stopped';
  loginState: AdapterLoginState;
  dataPlane: 'unknown' | 'healthy' | 'silent' | 'dead';
  inboundCursor?: number;
  lastInboundAt?: number;
  inboundNonceSeen?: string;
  eventSeq?: number;
  lastEventAt?: number;
  qqBuild?: string;
  detail?: string;
}

export interface AdapterActionResult {
  ok: boolean;
  data?: unknown;
  retcode?: number;
  message?: string;
  retryable?: boolean;
  latencyMs?: number;
}

export interface AdapterCapabilities {
  protocol: 'onebot11';
  actions: string[];
  events: string[];
  media: {
    image: boolean;
    voice: boolean;
    video: boolean;
    file: boolean;
    forward: boolean;
  };
  multiAccount: boolean;
  version: {
    adapter: string;
    qqBuild?: string;
    hook?: string;
  };
}

export interface AdapterEvent {
  accountId: number;
  occurredAt: number;
  sourceEventId?: string;
  nativeMessageId?: string | number;
  payload: OneBotEvent;
  priority?: EventPriority;
}

export interface AdapterSession {
  sessionId: string;
  accountId: number;
}

export interface AdapterInterface {
  readonly accountId: number;
  start(sink: EventSink, session: AdapterSession, replayManifest?: string[]): Promise<void>;
  stop(): Promise<void>;
  execute(
    action: string,
    params: Record<string, unknown>,
    context: ActionContext,
  ): Promise<AdapterActionResult>;
  health(): Promise<AdapterHealth>;
  capabilities(): AdapterCapabilities;
}

export type PublishFailureReason =
  'duplicate' | 'backpressure' | 'not_connected' | 'shutting_down' | 'forbidden_event_source';

export type PublishResult =
  | {
      accepted: true;
      eventKey: string;
      deliverSeq: number;
      mode: 'delivered' | 'queued';
    }
  | {
      accepted: false;
      reason: PublishFailureReason;
      eventKey?: string;
      retcode?: 1503;
      retryAfterMs?: number;
    };

export interface EventSink {
  publish(event: AdapterEvent): Promise<PublishResult>;
}
