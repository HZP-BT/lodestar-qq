import { describe, expect, it } from 'vitest';

import { ExponentialBackoff } from '../src/onebot/backoff.js';

describe('ExponentialBackoff', () => {
  it('doubles delays up to maxMs and resets', () => {
    const backoff = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 5_000,
      jitter: 0,
      random: () => 0.5,
    });

    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      1_000, 2_000, 4_000, 5_000,
    ]);

    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });

  it('applies jitter within the configured fraction', () => {
    const backoff = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 1_000,
      jitter: 0.2,
      random: () => 0,
    });

    expect(backoff.next()).toBe(800);
  });

  it('rejects invalid options', () => {
    expect(() => new ExponentialBackoff({ baseMs: 0, maxMs: 10, jitter: 0 })).toThrow(RangeError);
    expect(() => new ExponentialBackoff({ baseMs: 100, maxMs: 10, jitter: 0 })).toThrow(RangeError);
    expect(() => new ExponentialBackoff({ baseMs: 100, maxMs: 200, jitter: 2 })).toThrow(
      RangeError,
    );
  });
});
