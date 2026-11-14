import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lodestar/adapter-mock': resolve(here, '../adapter-mock/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks',
    // The watchdog test measures wall-clock kill latency; keep test files
    // serial so unrelated workers do not inflate that measurement.
    fileParallelism: false,
  },
});
