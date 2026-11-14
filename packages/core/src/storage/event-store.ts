import { computeEventKey } from '../adapter/event-key.js';
import type { EventPriority } from '../adapter/types.js';
import type { OneBotEvent } from '../onebot/types.js';
import type { SqliteDatabase } from './database.js';
import { SCHEMA_SQL } from './schema.js';

export interface StorePublishInput {
  accountId: number;
  sourceEventId?: string;
  payload: OneBotEvent;
  priority: EventPriority;
  occurredAt: number;
}

export type StorePublishResult =
  | { status: 'accepted'; eventKey: string; deliverSeq: number }
  | { status: 'duplicate'; eventKey: string }
  | { status: 'backpressure'; retcode: 1503 };

export interface EventStoreOptions {
  maxOutboxPerAccount?: number;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEDUP_TTL_MS: Record<string, number> = {
  message: 7 * DAY_MS,
  notice: 3 * DAY_MS,
  request: 3 * DAY_MS,
  meta_event: 1 * DAY_MS,
};

export class EventStore {
  private readonly maxOutboxPerAccount: number;
  private readonly now: () => number;

  constructor(
    private readonly db: SqliteDatabase,
    options: EventStoreOptions = {},
  ) {
    this.maxOutboxPerAccount = options.maxOutboxPerAccount ?? 10_000;
    this.now = options.now ?? Date.now;
    db.exec(SCHEMA_SQL);
  }

  /**
   * Dedup happens before deliverSeq allocation when sourceEventId is present:
   * a duplicate returns without consuming a sequence or writing an outbox row.
   */
  publish(input: StorePublishInput): StorePublishResult {
    const now = this.now();
    const expiresAt = now + (DEDUP_TTL_MS[input.payload.post_type] ?? DAY_MS);
    const priority = input.priority;

    if (input.sourceEventId) {
      const eventKey = computeEventKey({
        accountId: input.accountId,
        sourceEventId: input.sourceEventId,
        deliverSeq: 0,
      });

      this.db.exec('BEGIN IMMEDIATE');
      try {
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO event_dedup
              (event_key, account_id, first_seen_at, expires_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(eventKey, input.accountId, now, expiresAt);

        if (Number(inserted.changes) === 0) {
          this.db.exec('COMMIT');
          return { status: 'duplicate', eventKey };
        }

        const deliverSeq = this.allocateDeliverSeq(input.accountId);

        if (this.isOutboxFull(input.accountId)) {
          this.db.exec('ROLLBACK');
          return { status: 'backpressure', retcode: 1503 };
        }

        this.insertOutbox(eventKey, input, deliverSeq);
        this.db.exec('COMMIT');
        return { status: 'accepted', eventKey, deliverSeq };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deliverSeq = this.allocateDeliverSeq(input.accountId);
      const eventKey = computeEventKey({
        accountId: input.accountId,
        deliverSeq,
      });

      if (this.isOutboxFull(input.accountId)) {
        this.db.exec('ROLLBACK');
        return { status: 'backpressure', retcode: 1503 };
      }

      this.insertOutbox(eventKey, { ...input, priority }, deliverSeq);
      this.db.exec('COMMIT');
      return { status: 'accepted', eventKey, deliverSeq };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markSent(accountId: number, deliverSeq: number): void {
    this.db
      .prepare(
        `UPDATE event_outbox
            SET status = 'sent', sent_at = ?
          WHERE account_id = ? AND deliver_seq = ?`,
      )
      .run(this.now(), accountId, deliverSeq);
  }

  markFailed(accountId: number, deliverSeq: number): void {
    this.db
      .prepare(
        `UPDATE event_outbox
            SET status = 'failed', attempts = attempts + 1
          WHERE account_id = ? AND deliver_seq = ?`,
      )
      .run(accountId, deliverSeq);
  }

  pendingCount(accountId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM event_outbox
          WHERE account_id = ? AND status = 'pending'`,
      )
      .get(accountId) as { count: number | bigint } | undefined;

    return Number(row?.count ?? 0);
  }

  nextDeliverSeq(accountId: number): number {
    const row = this.db
      .prepare('SELECT next_deliver_seq FROM account_delivery_seq WHERE account_id = ?')
      .get(accountId) as { next_deliver_seq: number | bigint } | undefined;

    return Number(row?.next_deliver_seq ?? 1);
  }

  outboxOrder(
    accountId: number,
  ): Array<{ deliver_seq: number; event_key: string; status: string }> {
    return this.db
      .prepare(
        `SELECT deliver_seq, event_key, status
           FROM event_outbox
          WHERE account_id = ?
          ORDER BY deliver_seq ASC`,
      )
      .all(accountId) as Array<{ deliver_seq: number; event_key: string; status: string }>;
  }

  listReplayable(accountId?: number): Array<{
    account_id: number;
    deliver_seq: number;
    event_key: string;
    payload_json: string;
  }> {
    const where =
      accountId === undefined
        ? `status IN ('pending','sending')`
        : `account_id = ? AND status IN ('pending','sending')`;

    const statement = this.db.prepare(
      `SELECT account_id, deliver_seq, event_key, payload_json
         FROM event_outbox
        WHERE ${where}
        ORDER BY account_id ASC, deliver_seq ASC`,
    );

    return (accountId === undefined ? statement.all() : statement.all(accountId)) as Array<{
      account_id: number;
      deliver_seq: number;
      event_key: string;
      payload_json: string;
    }>;
  }

  insertMessageRef(input: {
    accountId: number;
    messageId: number;
    nativeMessageId: string | null;
    conversationType: string;
    conversationId: number;
    eventKey: string;
    createdAt: number;
    expiresAt: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO message_ref
          (account_id, message_id, native_message_id, conversation_type,
           conversation_id, event_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.accountId,
        input.messageId,
        input.nativeMessageId,
        input.conversationType,
        input.conversationId,
        input.eventKey,
        input.createdAt,
        input.expiresAt,
      );
  }

  cleanup(now = this.now()): {
    dedupDeleted: number;
    sentDeleted: number;
    failedDeleted: number;
    messageRefDeleted: number;
  } {
    const dedup = this.db.prepare('DELETE FROM event_dedup WHERE expires_at < ?').run(now);
    const sent = this.db
      .prepare(
        `DELETE FROM event_outbox
          WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < ?`,
      )
      .run(now - DAY_MS);
    const failed = this.db
      .prepare(
        `DELETE FROM event_outbox
          WHERE status = 'failed' AND created_at < ?`,
      )
      .run(now - 7 * DAY_MS);
    const refs = this.db
      .prepare(
        `DELETE FROM message_ref
          WHERE expires_at IS NOT NULL AND expires_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM event_outbox outbox
               WHERE outbox.event_key = message_ref.event_key
                 AND outbox.status IN ('pending','sending')
            )`,
      )
      .run(now);

    return {
      dedupDeleted: Number(dedup.changes),
      sentDeleted: Number(sent.changes),
      failedDeleted: Number(failed.changes),
      messageRefDeleted: Number(refs.changes),
    };
  }

  private allocateDeliverSeq(accountId: number): number {
    this.db
      .prepare(
        `INSERT INTO account_delivery_seq(account_id, next_deliver_seq)
         VALUES (?, 1)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .run(accountId);

    const row = this.db
      .prepare('SELECT next_deliver_seq FROM account_delivery_seq WHERE account_id = ?')
      .get(accountId) as { next_deliver_seq: number | bigint };

    const deliverSeq = Number(row.next_deliver_seq);
    this.db
      .prepare('UPDATE account_delivery_seq SET next_deliver_seq = ? WHERE account_id = ?')
      .run(deliverSeq + 1, accountId);

    return deliverSeq;
  }

  private isOutboxFull(accountId: number): boolean {
    if (this.pendingCount(accountId) < this.maxOutboxPerAccount) {
      return false;
    }

    // Sent rows are safe to drop; pending rows are never deleted.
    this.db
      .prepare(`DELETE FROM event_outbox WHERE account_id = ? AND status = 'sent'`)
      .run(accountId);

    return this.pendingCount(accountId) >= this.maxOutboxPerAccount;
  }

  private insertOutbox(eventKey: string, input: StorePublishInput, deliverSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO event_outbox
          (event_key, account_id, deliver_seq, payload_json, priority,
           status, created_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0)`,
      )
      .run(
        eventKey,
        input.accountId,
        deliverSeq,
        JSON.stringify(input.payload),
        input.priority,
        input.occurredAt,
      );
  }
}
