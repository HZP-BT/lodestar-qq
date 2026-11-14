import { createRequire } from 'node:module';

import { errorMessage } from '../onebot/errors.js';

export interface NodeSqliteDetection {
  available: boolean;
  nodeVersion: string;
  abi: string;
  execPath: string;
  error?: string;
  recommendation: string;
}

/**
 * Node can be built without SQLite (some distro packages). Probe it at
 * startup instead of letting the first storage call fail with
 * ERR_UNKNOWN_BUILTIN_MODULE.
 */
export function detectNodeSqlite(): NodeSqliteDetection {
  const base = {
    nodeVersion: process.version,
    abi: process.versions.modules ?? 'unknown',
    execPath: process.execPath,
  };

  try {
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite') as {
      DatabaseSync?: new (path: string) => { exec(sql: string): void; close(): void };
      Database?: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const Database = sqlite.Database ?? sqlite.DatabaseSync;

    if (!Database) {
      return {
        ...base,
        available: false,
        error: 'node:sqlite loaded but has no DatabaseSync/Database export',
        recommendation:
          'Use an official Node.js build or official Docker image; or switch to the better-sqlite3 driver.',
      };
    }

    const db = new Database(':memory:');
    db.exec('CREATE TABLE polaris_probe (x INTEGER)');
    db.close();

    return {
      ...base,
      available: true,
      recommendation: 'node:sqlite is available',
    };
  } catch (error) {
    return {
      ...base,
      available: false,
      error: errorMessage(error),
      recommendation:
        'This Node build may not include SQLite. Use an official Node.js build or official Docker image; or switch to the better-sqlite3 driver.',
    };
  }
}
