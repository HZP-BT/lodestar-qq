import { createRequire } from 'node:module';

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  Database?: new (path: string) => unknown;
  DatabaseSync?: new (path: string) => unknown;
}

/**
 * Open SQLite through node:sqlite, preferring the non-deprecated `Database`
 * constructor on Node 26 and falling back to `DatabaseSync` on 22.16/24.
 */
export function openSqliteDatabase(path: string): SqliteDatabase {
  // `import.meta.url` is empty in a CJS release bundle; prefer __filename
  // when the same module is bundled for a portable Windows build.
  const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const sqlite = require('node:sqlite') as NodeSqliteModule;
  const Database = sqlite.Database ?? sqlite.DatabaseSync;

  if (!Database) {
    throw new Error(
      'node:sqlite has no Database/DatabaseSync export. Use an official Node.js build or switch to the better-sqlite3 driver.',
    );
  }

  return new Database(path) as SqliteDatabase;
}
