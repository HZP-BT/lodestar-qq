export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_delivery_seq (
  account_id INTEGER PRIMARY KEY,
  next_deliver_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_dedup (
  event_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_dedup_expiry ON event_dedup(expires_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  event_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  deliver_seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('critical','normal','low')),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, deliver_seq)
);
CREATE INDEX IF NOT EXISTS event_outbox_order ON event_outbox(account_id, deliver_seq);
CREATE INDEX IF NOT EXISTS event_outbox_cleanup ON event_outbox(status, sent_at);

CREATE TABLE IF NOT EXISTS message_ref (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_ref_native
  ON message_ref(account_id, native_message_id)
  WHERE native_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_ref_expiry ON message_ref(expires_at);

CREATE TABLE IF NOT EXISTS send_quota (
  quota_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS send_rate (
  rate_key TEXT PRIMARY KEY,
  last_sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS send_circuit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('CLOSED','OPEN')),
  reason TEXT,
  opened_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS send_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed','blocked')),
  reason TEXT NOT NULL,
  message_hash TEXT,
  message_length INTEGER,
  retcode INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS send_audit_time ON send_audit(created_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  ip TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(created_at);

INSERT INTO schema_meta(key, value)
VALUES ('schema_version', '${SCHEMA_VERSION}')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;
