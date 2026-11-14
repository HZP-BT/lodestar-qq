import { describe, expect, it } from 'vitest';

import { computeEventKey } from '../src/adapter/event-key.js';

describe('computeEventKey', () => {
  it('does not collapse two identical messages with different deliveries', () => {
    const first = computeEventKey({
      accountId: 10001,
      deliverSeq: 1,
    });
    const second = computeEventKey({
      accountId: 10001,
      deliverSeq: 2,
    });

    expect(first).not.toBe(second);
  });

  it('treats the same Core delivery as duplicate', () => {
    const key = computeEventKey({
      accountId: 10001,
      deliverSeq: 7,
    });

    expect(
      computeEventKey({
        accountId: 10001,
        deliverSeq: 7,
      }),
    ).toBe(key);
  });

  it('dedupes by native source id across adapter restarts when available', () => {
    const first = computeEventKey({
      accountId: 10001,
      deliverSeq: 1,
      sourceEventId: 'native-42',
    });
    const replay = computeEventKey({
      accountId: 10001,
      deliverSeq: 99,
      sourceEventId: 'native-42',
    });

    expect(replay).toBe(first);
  });

  it('keeps different native source ids distinct', () => {
    const a = computeEventKey({
      accountId: 10001,
      deliverSeq: 1,
      sourceEventId: 'native-1',
    });
    const b = computeEventKey({
      accountId: 10001,
      deliverSeq: 2,
      sourceEventId: 'native-2',
    });

    expect(a).not.toBe(b);
  });

  it('does not use payload content, so identical text is preserved', () => {
    // This is the same guarantee as the first test; kept explicit for MOCK-01.
    const first = computeEventKey({ accountId: 10001, deliverSeq: 10 });
    const second = computeEventKey({ accountId: 10001, deliverSeq: 11 });
    expect(first).not.toBe(second);
  });
});
