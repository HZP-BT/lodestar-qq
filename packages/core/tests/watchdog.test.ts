import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(here, '..');
const fixture = join(here, 'fixtures', 'blocked-core.ts');

describe('Watchdog (MOCK-14)', () => {
  it('kills a blocked event loop from an isolated worker', async () => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: coreRoot,
      stdio: 'ignore',
    });

    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1_500);
    expect(signal === 'SIGKILL' || code !== 0).toBe(true);
  }, 10_000);
});
