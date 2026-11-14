import type { OneBotEvent } from '../onebot/types.js';
import type { EventStore } from '../storage/event-store.js';

export type OutboxSender = (event: OneBotEvent) => boolean;

/**
 * Replays pending/sending outbox rows in Core deliverSeq order.
 * A failed send leaves the row pending (not failed) and stops the flush, so the
 * next reconnect can retry without losing ordering.
 */
export class OutboxDispatcher {
  constructor(
    private readonly store: EventStore,
    private readonly sender: OutboxSender,
  ) {}

  flush(accountId?: number): { sent: number; blocked: number } {
    let sent = 0;

    for (const row of this.store.listReplayable(accountId)) {
      let payload: OneBotEvent;

      try {
        payload = JSON.parse(row.payload_json) as OneBotEvent;
      } catch {
        this.store.markFailed(row.account_id, row.deliver_seq);
        return { sent, blocked: 1 };
      }

      if (!this.sender(payload)) {
        return { sent, blocked: 1 };
      }

      this.store.markSent(row.account_id, row.deliver_seq);
      sent += 1;
    }

    return { sent, blocked: 0 };
  }
}
