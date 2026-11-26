import type { SqliteDatabase } from './database.js';

interface AdminAuditRow {
  id: number | bigint;
  actor: string;
  action: string;
  ip: string;
  details_json: string;
  created_at: number | bigint;
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
 * Metadata-only audit of admin panel actions (password changes, restarts,
 * shutdowns, protocol edits). Never stores request bodies or tokens.
 */
export class AdminAuditStore {
  constructor(private readonly db: SqliteDatabase) {}

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
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
