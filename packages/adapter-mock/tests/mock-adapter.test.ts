import { describe, expect, it } from 'vitest';

import { MockAdapter } from '../src/mock-adapter.js';
import type { AdapterEvent, EventSink } from '../src/protocol.js';

function fakeSink() {
  const events: AdapterEvent[] = [];
  const sink: EventSink = {
    publish(event) {
      events.push(event);
      return Promise.resolve({
        accepted: true,
        eventKey: `key-${events.length}`,
        deliverSeq: events.length,
        mode: 'queued',
      });
    },
  };
  return { sink, events };
}

describe('MockAdapter', () => {
  it('emits normalized events and advances inbound health', async () => {
    const { sink, events } = fakeSink();
    const adapter = new MockAdapter({ accountId: 10001, now: () => 1_000 });
    await adapter.start(sink, { accountId: 10001, sessionId: 'core-session-1' }, ['src-1']);

    const result = await adapter.emitText('hello', { groupId: 100 });

    expect(result).toMatchObject({ accepted: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: 10001,
      payload: { post_type: 'message', raw_message: 'hello' },
    });
    expect(adapter.receivedReplayManifest).toEqual(['src-1']);
    expect(adapter.sessionId).toBe('core-session-1');

    const health = await adapter.health();
    expect(health).toMatchObject({
      process: 'ready',
      loginState: 'LOGGED_IN',
      dataPlane: 'healthy',
      inboundCursor: 1,
    });
  });

  it('freeze stops events, freezeEvents keeps actions usable', async () => {
    const { sink, events } = fakeSink();
    const adapter = new MockAdapter({ accountId: 10001 });
    await adapter.start(sink, { accountId: 10001, sessionId: 's1' });

    adapter.freeze();
    expect(await adapter.emitText('blocked')).toBeNull();
    expect(events).toHaveLength(0);
    expect(
      (
        await adapter.execute(
          'get_login_info',
          {},
          { action: 'get_login_info', selfId: 10001, echo: null },
        )
      ).ok,
    ).toBe(false);

    adapter.resumeData();
    adapter.freezeEvents();
    expect(await adapter.emitText('blocked')).toBeNull();
    expect(
      (
        await adapter.execute(
          'get_login_info',
          {},
          { action: 'get_login_info', selfId: 10001, echo: null },
        )
      ).ok,
    ).toBe(true);

    adapter.resumeData();
    await adapter.emitText('ok');
    expect(events).toHaveLength(1);
  });

  it('exposes canary evidence without emitting a filtered event', async () => {
    const { sink, events } = fakeSink();
    const adapter = new MockAdapter({ accountId: 10001 });
    await adapter.start(sink, { accountId: 10001, sessionId: 's1' });

    adapter.canary('canary-nonce-1');

    expect(events).toHaveLength(0);
    expect(await adapter.health()).toMatchObject({
      inboundNonceSeen: 'canary-nonce-1',
      inboundCursor: 1,
    });
  });

  it('simulates crash, auth failure and action not found', async () => {
    const { sink } = fakeSink();
    const adapter = new MockAdapter({ accountId: 10001 });
    await adapter.start(sink, { accountId: 10001, sessionId: 's1' });

    adapter.authFail();
    expect(
      await adapter.execute(
        'get_login_info',
        {},
        { action: 'get_login_info', selfId: 10001, echo: null },
      ),
    ).toMatchObject({ ok: false, retcode: 1506 });

    expect(
      await adapter.execute(
        'unknown_action',
        {},
        { action: 'unknown_action', selfId: 10001, echo: null },
      ),
    ).toMatchObject({ ok: false, retcode: 1404 });

    adapter.crash();
    expect((await adapter.health()).process).toBe('stopped');
    expect(
      await adapter.execute(
        'get_login_info',
        {},
        { action: 'get_login_info', selfId: 10001, echo: null },
      ),
    ).toMatchObject({ ok: false, retcode: 1502 });
  });
});
