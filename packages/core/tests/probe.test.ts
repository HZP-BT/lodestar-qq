import { describe, expect, it } from 'vitest';

import { Probe } from '../src/probe/probe.js';
import type { AdapterHealth } from '../src/adapter/types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function health(overrides: Partial<AdapterHealth> = {}): AdapterHealth {
  return {
    process: 'ready',
    loginState: 'LOGGED_IN',
    dataPlane: 'healthy',
    inboundCursor: 0,
    ...overrides,
  };
}

describe('Probe (MOCK-11/12/13)', () => {
  it('stays IDLE for 6h with zero inbound and healthy actions', () => {
    let now = 1_000_000;
    const probe = new Probe({ idleAfterMs: 10 * MINUTE }, { now: () => now });

    probe.observe(health({ inboundCursor: 0 }), now);
    const seen = new Set<string>();

    for (let hour = 0; hour <= 6; hour += 1) {
      now = 1_000_000 + hour * HOUR;
      probe.recordActionProbe(true, now);
      probe.observe(health({ inboundCursor: 0 }), now);
      seen.add(probe.healthState);
    }

    expect(probe.healthState).toBe('IDLE');
    expect(seen.has('DEGRADED')).toBe(false);
    expect(seen.has('OFFLINE')).toBe(false);
    expect(probe.adapterLoginState).toBe('LOGGED_IN');
  });

  it('stays ONLINE/IDLE when inbound is silent but action probes stay healthy', () => {
    let now = 1_000_000;
    const start = now;
    const probe = new Probe({}, { now: () => now });

    probe.observe(health({ inboundCursor: 1, lastInboundAt: now }), now);
    probe.recordActionProbe(true, now);
    expect(probe.healthState).toBe('ONLINE');

    for (let elapsed = 15_000; elapsed <= 61_000; elapsed += 15_000) {
      now = start + elapsed;
      probe.recordActionProbe(true, now);
      probe.observe(health({ inboundCursor: 1, lastInboundAt: start }), now);
    }
    expect(probe.healthState).toBe('ONLINE');

    now = start + 10 * MINUTE;
    probe.recordActionProbe(true, now);
    probe.observe(health({ inboundCursor: 1, lastInboundAt: start }), now);
    expect(probe.healthState).toBe('IDLE');
  });

  it('degrades/offlines when an active conversation stops advancing and actions are stale', () => {
    let now = 1_000_000;
    const probe = new Probe({}, { now: () => now });

    probe.observe(health({ inboundCursor: 1, lastInboundAt: now }), now);
    probe.recordActionProbe(true, now);
    expect(probe.healthState).toBe('ONLINE');

    now += 61_000;
    probe.observe(health({ inboundCursor: 1, lastInboundAt: 1_000_000 }), now);
    expect(probe.healthState).toBe('DEGRADED');

    now += 60_000;
    probe.observe(health({ inboundCursor: 1, lastInboundAt: 1_000_000 }), now);
    expect(probe.healthState).toBe('OFFLINE');
  });

  it('uses pre-filter nonce evidence even when the canary group is not whitelisted', () => {
    let now = 1_000_000;
    const probe = new Probe({}, { now: () => now });

    probe.observe(health({ inboundCursor: 0 }), now);
    probe.recordActionProbe(true, now);

    now += 1_000;
    probe.observe(
      health({
        inboundCursor: 0,
        inboundNonceSeen: 'canary-nonce-1',
        lastInboundAt: now,
      }),
      now,
    );

    expect(probe.healthState).toBe('ONLINE');
  });

  it('degrades then offlines on consecutive action probe failures', () => {
    let now = 1_000_000;
    const probe = new Probe({}, { now: () => now });

    probe.recordActionProbe(false, now);
    probe.recordActionProbe(false, now);
    probe.recordActionProbe(false, now);
    expect(probe.healthState).toBe('DEGRADED');

    probe.recordActionProbe(false, now);
    probe.recordActionProbe(false, now);
    expect(probe.healthState).toBe('OFFLINE');

    now += 1_000;
    probe.recordActionProbe(true, now);
    expect(probe.healthState).not.toBe('OFFLINE');
  });
});
