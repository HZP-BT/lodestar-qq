import { describe, expect, it } from 'vitest';

import { detectNodeSqlite } from '../src/storage/detect-node-sqlite.js';

describe('detectNodeSqlite', () => {
  it('reports the runtime SQLite feature with actionable fields', () => {
    const detection = detectNodeSqlite();

    expect(detection.nodeVersion).toBe(process.version);
    expect(detection.abi).toBe(process.versions.modules);
    expect(detection.execPath).toBe(process.execPath);
    expect(detection.available).toBe(true);
    expect(detection.recommendation).toContain('available');
  });
});
