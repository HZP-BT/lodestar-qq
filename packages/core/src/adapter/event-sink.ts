import { isAdapterForbiddenEvent } from './event-policy.js';
import type { AdapterEvent, EventSink, PublishResult } from './types.js';
import type { OneBotEvent } from '../onebot/types.js';
import type { EventStore } from '../storage/event-store.js';

export type EventSender = (event: OneBotEvent) => boolean;

/**
 * The only adapter-facing event entry point.
 *
 * Order is deliberate:
 * 1. Reject Core-owned meta events before touching storage.
 * 2. EventStore dedups (when sourceEventId exists) before allocating deliverSeq,
 *    so duplicates never consume a sequence or create an outbox hole.
 * 3. Persist to outbox, then try the transport.
 */
export class EventSinkImpl implements EventSink {
  constructor(
    private readonly store: EventStore,
    private readonly sender?: EventSender,
  ) {}

  publish(event: AdapterEvent): Promise<PublishResult> {
    return Promise.resolve(this.publishNow(event));
  }

  private publishNow(event: AdapterEvent): PublishResult {
    if (isAdapterForbiddenEvent(event.payload)) {
      return { accepted: false, reason: 'forbidden_event_source' };
    }

    const result = this.store.publish({
      accountId: event.accountId,
      ...(event.sourceEventId === undefined ? {} : { sourceEventId: event.sourceEventId }),
      payload: event.payload,
      priority: event.priority ?? 'normal',
      occurredAt: event.occurredAt,
    });

    if (result.status === 'duplicate') {
      return { accepted: false, reason: 'duplicate', eventKey: result.eventKey };
    }

    if (result.status === 'backpressure') {
      return {
        accepted: false,
        reason: 'backpressure',
        retcode: 1503,
        retryAfterMs: 1_000,
      };
    }

    let mode: 'delivered' | 'queued' = 'queued';

    if (this.sender) {
      try {
        if (this.sender(event.payload)) {
          this.store.markSent(event.accountId, result.deliverSeq);
          mode = 'delivered';
        }
      } catch {
        this.store.markFailed(event.accountId, result.deliverSeq);
      }
    }

    return {
      accepted: true,
      eventKey: result.eventKey,
      deliverSeq: result.deliverSeq,
      mode,
    };
  }
}
