import type { SendAuditRecord, SendCircuitState, SendGuardStorage } from '../send-guard.js';
import type { SqliteDatabase } from './database.js';
import { SCHEMA_SQL } from './schema.js';

interface QuotaRow {
  count: number | bigint;
}

interface RateRow {
  last_sent_at: number | bigint;
}

interface CircuitRow {
  state: SendCircuitState;
  reason: string | null;
}

interface AuditRow {
  id: number | bigint;
  account_id: number | bigint;
  action: string;
  target_type: string;
  target_id: string;
  decision: 'allowed' | 'blocked';
  reason: string;
  message_hash: string | null;
  message_length: number | bigint | null;
  retcode: number | bigint | null;
  created_at: number | bigint;
}

interface AdminAuditRow {
  id: number | bigint;
  actor: string;
  action: string;
  ip: string;
  details_json: string;
  created_at: number | bigint;
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  decision?: 'allowed' | 'blocked';
  action?: string;
}

export interface AuditPage {
  items: SendAuditRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminAuditRecord {
  id: number;
  actor: string;
  action: string;
  ip: string;
  details: unknown;
  createdAt: number;
}

/**
 * SQLite-backed state for SendGuard: daily quota, rate timestamps, circuit
 * state and metadata-only audit. It is the productized replacement for the
 * spike's in-memory counters.
 */
export class SendGuardStore implements SendGuardStorage {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(SCHEMA_SQL);
  }

  getQuota(key: string): number {
    const row = this.db.prepare('SELECT count FROM send_quota WHERE quota_key = ?').get(key) as
      QuotaRow | undefined;
    return Number(row?.count ?? 0);
  }

  incrementQuota(key: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO send_quota (quota_key, count, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(quota_key) DO UPDATE SET
           count = count + 1,
           updated_at = excluded.updated_at`,
      )
      .run(key, now);
  }

  getLastSentAt(key: string): number | null {
    const row = this.db
      .prepare('SELECT last_sent_at FROM send_rate WHERE rate_key = ?')
      .get(key) as RateRow | undefined;
    return row ? Number(row.last_sent_at) : null;
  }

  setLastSentAt(key: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO send_rate (rate_key, last_sent_at)
         VALUES (?, ?)
         ON CONFLICT(rate_key) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
      )
      .run(key, now);
  }

  getCircuit(): { state: SendCircuitState; reason: string | null } | null {
    const row = this.db.prepare('SELECT state, reason FROM send_circuit WHERE id = 1').get() as
      CircuitRow | undefined;
    return row ? { state: row.state, reason: row.reason } : null;
  }

  setCircuit(state: SendCircuitState, reason: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO send_circuit (id, state, reason, opened_at, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           reason = excluded.reason,
           opened_at = CASE
             WHEN excluded.state = 'OPEN' AND send_circuit.state = 'CLOSED'
             THEN excluded.opened_at
             ELSE send_circuit.opened_at
           END,
           updated_at = excluded.updated_at`,
      )
      .run(state, reason, state === 'OPEN' ? now : null, now);
  }

  writeAudit(record: Omit<SendAuditRecord, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO send_audit
          (account_id, action, target_type, target_id, decision, reason,
           message_hash, message_length, retcode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.accountId,
        record.action,
        record.targetType,
        record.targetId,
        record.decision,
        record.reason,
        record.messageHash,
        record.messageLength,
        record.retcode,
        record.createdAt,
      );
  }

  recentAudit(limit = 50): SendAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, action, target_type, target_id, decision,
                reason, message_hash, message_length, retcode, created_at
           FROM send_audit
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(limit) as AuditRow[];

    return rows.map(mapAuditRow);
  }

  queryAudit(query: AuditQuery = {}): AuditPage {
    const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.decision) {
      where.push('decision = ?');
      params.push(query.decision);
    }
    if (query.action) {
      where.push('action = ?');
      params.push(query.action);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM send_audit ${whereSql}`)
      .get(...params) as { count: number | bigint } | undefined;
    const rows = this.db
      .prepare(
        `SELECT id, account_id, action, target_type, target_id, decision,
                reason, message_hash, message_length, retcode, created_at
           FROM send_audit
           ${whereSql}
          ORDER BY id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as AuditRow[];

    return {
      items: rows.map(mapAuditRow),
      total: Number(totalRow?.count ?? 0),
      limit,
      offset,
    };
  }

  writeAdminAudit(record: Omit<AdminAuditRecord, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO admin_audit (actor, action, ip, details_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.actor,
        record.action,
        record.ip,
        JSON.stringify(record.details),
        record.createdAt,
      );
  }

  recentAdminAudit(limit = 50): AdminAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, actor, action, ip, details_json, created_at
           FROM admin_audit
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(limit) as AdminAuditRow[];

    return rows.map((row) => ({
      id: Number(row.id),
      actor: row.actor,
      action: row.action,
      ip: row.ip,
      details: safeJson(row.details_json),
      createdAt: Number(row.created_at),
    }));
  }

  pruneAudit(before: number): void {
    this.db.prepare('DELETE FROM send_audit WHERE created_at < ?').run(before);
  }
}

function mapAuditRow(row: AuditRow): SendAuditRecord {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    decision: row.decision,
    reason: row.reason,
    messageHash: row.message_hash,
    messageLength: row.message_length === null ? null : Number(row.message_length),
    retcode: row.retcode === null ? null : Number(row.retcode),
    createdAt: Number(row.created_at),
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
