import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const SCHEMA = `
  CREATE TABLE event_dedup (
    event_key TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX event_dedup_expiry ON event_dedup(expires_at);

  CREATE TABLE event_outbox (
    event_key TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    deliver_seq INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, deliver_seq)
  );
  CREATE INDEX event_outbox_order ON event_outbox(account_id, deliver_seq);
  CREATE INDEX event_outbox_cleanup ON event_outbox(status, sent_at);

  CREATE TABLE message_ref (
    account_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    native_message_id TEXT,
    conversation_type TEXT NOT NULL,
    conversation_id INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (account_id, message_id)
  );
  CREATE UNIQUE INDEX idx_message_ref_native
    ON message_ref(account_id, native_message_id)
    WHERE native_message_id IS NOT NULL;
  CREATE INDEX message_ref_expiry ON message_ref(expires_at);
`;

function insertMessage(
  db: DatabaseSync,
  accountId: number,
  messageId: number,
  nativeMessageId: string | null,
): void {
  db.prepare(
    `INSERT INTO message_ref
      (account_id, message_id, native_message_id, conversation_type, conversation_id, event_key, created_at)
     VALUES (?, ?, ?, 'group', 100, ?, ?)`,
  ).run(accountId, messageId, nativeMessageId, `event-${messageId}`, Date.now());
}

function indexNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

describe('node:sqlite runtime contract', () => {
  it('enforces the message_ref primary key and unique native id', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);

    insertMessage(db, 1, -1, 'native-a');
    expect(() => insertMessage(db, 1, -1, 'native-b')).toThrow();
    expect(() => insertMessage(db, 1, -2, 'native-a')).toThrow();

    const rows = db.prepare('SELECT message_id FROM message_ref').all();
    expect(rows).toHaveLength(1);

    expect(indexNames(db, 'message_ref')).toEqual(
      expect.arrayContaining(['idx_message_ref_native', 'message_ref_expiry']),
    );
    expect(indexNames(db, 'event_dedup')).toContain('event_dedup_expiry');
    expect(indexNames(db, 'event_outbox')).toEqual(
      expect.arrayContaining(['event_outbox_order', 'event_outbox_cleanup']),
    );

    db.close();
  });

  it('persists negative signed int32 ids across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'polaris-sqlite-'));
    const databasePath = join(directory, 'test.db');

    try {
      const first = new DatabaseSync(databasePath);
      first.exec(SCHEMA);
      insertMessage(first, 1, -2147483648, 'native-min');
      first.close();

      const reopened = new DatabaseSync(databasePath);
      const row = reopened
        .prepare('SELECT message_id FROM message_ref WHERE account_id = ?')
        .get(1) as { message_id: number } | undefined;
      expect(row?.message_id).toBe(-2147483648);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('orders outbox replay by Core deliver_seq, not adapter session seq', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    const insert = db.prepare(
      `INSERT INTO event_outbox
        (event_key, account_id, deliver_seq, payload_json, priority, status, created_at)
       VALUES (?, 1, ?, '{}', 'normal', 'pending', ?)`,
    );

    insert.run('old-session-50', 50, Date.now());
    insert.run('new-session-1', 51, Date.now());

    const rows = db
      .prepare('SELECT deliver_seq FROM event_outbox ORDER BY account_id, deliver_seq')
      .all() as Array<{ deliver_seq: number }>;
    expect(rows.map((row) => row.deliver_seq)).toEqual([50, 51]);
    db.close();
  });
});
