import { describe, expect, it } from 'vitest';

import { isAdapterForbiddenEvent } from '../src/adapter/event-policy.js';

describe('adapter event ownership', () => {
  it('rejects adapter-published meta events', () => {
    expect(
      isAdapterForbiddenEvent({
        time: 1,
        self_id: 10001,
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
      }),
    ).toBe(true);

    expect(
      isAdapterForbiddenEvent({
        time: 1,
        self_id: 10001,
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        status: { online: true, good: true },
      }),
    ).toBe(true);
  });

  it('allows message, notice and request events from adapters', () => {
    for (const postType of ['message', 'notice', 'request']) {
      expect(
        isAdapterForbiddenEvent({
          time: 1,
          self_id: 10001,
          post_type: postType,
        }),
      ).toBe(false);
    }
  });
});
