import { openSqliteDatabase } from '../src/storage/database.js';
import { EventStore } from '../src/storage/event-store.js';
import { EventSinkImpl } from '../src/adapter/event-sink.js';
import type { AdapterEvent } from '../src/adapter/types.js';
import { describe, expect, it } from 'vitest';

const DAY = 24 * 60 * 60 * 1_000;

function textEvent(accountId: number, text: string): AdapterEvent {
  return {
    accountId,
    occurredAt: 1_000,
    payload: {
      time: 1,
      self_id: accountId,
      post_type: 'message',
      message_type: 'private',
      raw_message: text,
    },
  };
}

function openStore(options: { maxOutboxPerAccount?: number; now?: () => number } = {}) {
  const db = openSqliteDatabase(':memory:');
  const store = new EventStore(db, options);
  return { db, store };
}

describe('EventSink A1/A3/A4/A6', () => {
  it('A1: delivers two identical texts and does not dedup by content', async () => {
    const { store } = openStore();
    const delivered: string[] = [];
    const sink = new EventSinkImpl(store, (event) => {
      delivered.push(String(event.raw_message));
      return true;
    });

    const first = await sink.publish(textEvent(10001, '好的'));
    const second = await sink.publish(textEvent(10001, '好的'));

    expect(first).toMatchObject({ accepted: true, mode: 'delivered' });
    expect(second).toMatchObject({ accepted: true, mode: 'delivered' });
    expect(first.accepted && second.accepted && first.eventKey !== second.eventKey).toBe(true);
    expect(first.accepted && first.deliverSeq).toBe(1);
    expect(second.accepted && second.deliverSeq).toBe(2);
    expect(delivered).toEqual(['好的', '好的']);
  });

  it('deduplicates before consuming deliverSeq when sourceEventId exists', async () => {
    const { store } = openStore();
    const sink = new EventSinkImpl(store);
    const event: AdapterEvent = {
      ...textEvent(10001, 'hello'),
      sourceEventId: 'native-42',
    };

    const first = await sink.publish(event);
    const duplicate = await sink.publish(event);

    expect(first).toMatchObject({ accepted: true, deliverSeq: 1 });
    expect(duplicate).toEqual({
      accepted: false,
      reason: 'duplicate',
      eventKey: first.accepted ? first.eventKey : undefined,
    });
    expect(store.nextDeliverSeq(10001)).toBe(2);
    expect(store.outboxOrder(10001)).toHaveLength(1);
  });

  it('A3: rejects adapter meta before touching storage', async () => {
    const { store } = openStore();
    const sink = new EventSinkImpl(store, () => true);

    const result = await sink.publish({
      accountId: 10001,
      occurredAt: 1_000,
      payload: {
        time: 1,
        self_id: 10001,
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
      },
    });

    expect(result).toEqual({ accepted: false, reason: 'forbidden_event_source' });
    expect(store.outboxOrder(10001)).toHaveLength(0);
  });

  it('A4: pure pending overflow returns 1503 and keeps pending', async () => {
    const { store } = openStore({ maxOutboxPerAccount: 2 });
    const sink = new EventSinkImpl(store);

    await sink.publish(textEvent(10001, '1'));
    await sink.publish(textEvent(10001, '2'));
    const third = await sink.publish(textEvent(10001, '3'));

    expect(third).toEqual({
      accepted: false,
      reason: 'backpressure',
      retcode: 1503,
      retryAfterMs: 1_000,
    });
    expect(store.pendingCount(10001)).toBe(2);
    expect(store.nextDeliverSeq(10001)).toBe(3);
  });

  it('A6: replay order uses Core deliverSeq, not adapter session seq', () => {
    const { db, store } = openStore();
    const insert = db.prepare(
      `INSERT INTO event_outbox
        (event_key, account_id, deliver_seq, payload_json, priority, status, created_at)
       VALUES (?, 1, ?, '{}', 'normal', 'pending', ?)`,
    );
    insert.run('old-session-50', 50, 1);
    insert.run('new-session-51', 51, 1);

    expect(store.outboxOrder(1).map((row) => row.deliver_seq)).toEqual([50, 51]);
  });
});

describe('schema and cleanup A2/A5', () => {
  it('A2: creates the primary key and required unique/cleanup indexes', () => {
    const { db } = openStore();
    const indexNames = (table: string): string[] =>
      (db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      );

    expect(indexNames('event_outbox')).toEqual(
      expect.arrayContaining(['event_outbox_order', 'event_outbox_cleanup']),
    );
    expect(indexNames('event_dedup')).toContain('event_dedup_expiry');
    expect(indexNames('message_ref')).toEqual(
      expect.arrayContaining(['idx_message_ref_native', 'message_ref_expiry']),
    );
  });

  it('A5: cleanup keeps pending rows and message_refs referenced by pending', () => {
    let now = 1_000_000;
    const { db, store } = openStore({ now: () => now });
    const sink = new EventSinkImpl(store);

    // We need accepted results synchronously for keys; EventStore.publish is sync.
    const pending = store.publish({
      accountId: 1,
      payload: textEvent(1, 'pending').payload,
      priority: 'normal',
      occurredAt: now,
    });
    const sent = store.publish({
      accountId: 1,
      sourceEventId: 'sent-native',
      payload: textEvent(1, 'sent').payload,
      priority: 'normal',
      occurredAt: now,
    });

    expect(pending.status).toBe('accepted');
    expect(sent.status).toBe('accepted');
    if (pending.status !== 'accepted' || sent.status !== 'accepted') {
      throw new Error('unexpected publish result');
    }

    store.markSent(1, sent.deliverSeq);
    store.insertMessageRef({
      accountId: 1,
      messageId: -1,
      nativeMessageId: null,
      conversationType: 'group',
      conversationId: 100,
      eventKey: pending.eventKey,
      createdAt: now,
      expiresAt: now - 1,
    });
    store.insertMessageRef({
      accountId: 1,
      messageId: -2,
      nativeMessageId: null,
      conversationType: 'group',
      conversationId: 100,
      eventKey: sent.eventKey,
      createdAt: now,
      expiresAt: now - 1,
    });

    now += 2 * DAY;
    const result = store.cleanup(now);

    expect(result.sentDeleted).toBe(1);
    expect(store.pendingCount(1)).toBe(1);
    const refs = db
      .prepare('SELECT event_key FROM message_ref ORDER BY message_id')
      .all() as Array<{
      event_key: string;
    }>;
    expect(refs.map((row) => row.event_key)).toEqual([pending.eventKey]);
    void sink;
  });
});
