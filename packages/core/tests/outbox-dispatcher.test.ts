import { describe, expect, it } from 'vitest';

import { EventSinkImpl } from '../src/adapter/event-sink.js';
import type { AdapterEvent } from '../src/adapter/types.js';
import { EventStore } from '../src/storage/event-store.js';
import { openSqliteDatabase } from '../src/storage/database.js';
import { OutboxDispatcher } from '../src/storage/outbox-dispatcher.js';
import type { OneBotEvent } from '../src/onebot/types.js';

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

describe('OutboxDispatcher (MOCK-07/08)', () => {
  it('replays pending events in deliverSeq order after reconnect', () => {
    const db = openSqliteDatabase(':memory:');
    const store = new EventStore(db);
    let connected = false;
    const sink = new EventSinkImpl(store, () => connected);

    const first = sink.publish(textEvent(1, 'one'));
    const second = sink.publish(textEvent(1, 'two'));
    void first;
    void second;
    expect(store.pendingCount(1)).toBe(2);

    const dispatcher = new OutboxDispatcher(store, () => connected);
    expect(dispatcher.flush(1)).toEqual({ sent: 0, blocked: 1 });

    connected = true;
    expect(dispatcher.flush(1)).toEqual({ sent: 2, blocked: 0 });
    expect(store.outboxOrder(1).map((row) => row.status)).toEqual(['sent', 'sent']);
    expect(store.pendingCount(1)).toBe(0);
    db.close();
  });

  it('replays 100 messages after a long offline period without losing any', () => {
    const db = openSqliteDatabase(':memory:');
    const store = new EventStore(db);
    let connected = false;
    const sink = new EventSinkImpl(store, () => connected);

    for (let i = 0; i < 100; i += 1) {
      void sink.publish(textEvent(1, `m${i}`));
    }

    const dispatcher = new OutboxDispatcher(store, () => connected);
    expect(dispatcher.flush(1)).toEqual({ sent: 0, blocked: 1 });
    expect(store.pendingCount(1)).toBe(100);

    connected = true;
    expect(dispatcher.flush(1)).toEqual({ sent: 100, blocked: 0 });
    expect(store.pendingCount(1)).toBe(0);
    expect(store.outboxOrder(1)).toHaveLength(100);
    db.close();
  });

  it('keeps cross-session deliverSeq order during replay', () => {
    const db = openSqliteDatabase(':memory:');
    const store = new EventStore(db);
    const insert = db.prepare(
      `INSERT INTO event_outbox
        (event_key, account_id, deliver_seq, payload_json, priority, status, created_at)
       VALUES (?, 1, ?, ?, 'normal', 'pending', 1)`,
    );
    const oldPayload: OneBotEvent = {
      time: 1,
      self_id: 1,
      post_type: 'message',
      raw_message: 'old-50',
    };
    const newPayload: OneBotEvent = {
      time: 1,
      self_id: 1,
      post_type: 'message',
      raw_message: 'new-51',
    };
    insert.run('old-50', 50, JSON.stringify(oldPayload));
    insert.run('new-51', 51, JSON.stringify(newPayload));

    const sent: string[] = [];
    const dispatcher = new OutboxDispatcher(store, (event) => {
      sent.push(String(event.raw_message));
      return true;
    });

    expect(dispatcher.flush(1)).toEqual({ sent: 2, blocked: 0 });
    expect(sent).toEqual(['old-50', 'new-51']);
    db.close();
  });
});
