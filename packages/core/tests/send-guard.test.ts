import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ActionRouter } from '../src/onebot/action-router.js';
import { SendGuard } from '../src/send-guard.js';
import { openSqliteDatabase } from '../src/storage/database.js';
import { SendGuardStore } from '../src/storage/send-guard-store.js';

const SELF_ID = 999;
const GROUP_ID = 100;

function atMessage(text = 'hi'): unknown[] {
  return [
    { type: 'at', data: { qq: String(SELF_ID) } },
    { type: 'text', data: { text } },
  ];
}

function baseConfig(dir: string) {
  return {
    groupWhitelist: [GROUP_ID],
    privateEnabled: false,
    atOnly: true,
    dailyQuota: 10,
    perGroupDailyQuota: null,
    minIntervalMs: 0,
    randomDelayMs: 0,
    quietHours: null,
    stopFile: join(dir, 'STOP'),
  };
}

describe('SendGuard', () => {
  it('allows a whitelisted group only when the bot is @-mentioned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    try {
      const guard = new SendGuard(baseConfig(dir));
      expect(
        guard.check('send_group_msg', { group_id: GROUP_ID, message: atMessage() }, SELF_ID),
      ).toMatchObject({ allowed: true });

      expect(
        guard.check('send_group_msg', { group_id: GROUP_ID, message: 'hello' }, SELF_ID),
      ).toMatchObject({ allowed: false, reason: 'not_at', retcode: 1504 });

      expect(
        guard.check('send_group_msg', { group_id: 200, message: atMessage() }, SELF_ID),
      ).toMatchObject({ allowed: false, reason: 'whitelist', retcode: 1504 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks private sends unless explicitly enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    try {
      const guard = new SendGuard(baseConfig(dir));
      expect(guard.check('send_private_msg', { user_id: 1, message: 'hi' }, SELF_ID)).toMatchObject(
        { allowed: false, reason: 'whitelist' },
      );

      const enabled = new SendGuard({ ...baseConfig(dir), privateEnabled: true });
      expect(
        enabled.check('send_private_msg', { user_id: 1, message: 'hi' }, SELF_ID),
      ).toMatchObject({ allowed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces daily quota, rate limit and quiet hours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    try {
      const now = 1_000_000;
      const quota = new SendGuard(
        { ...baseConfig(dir), dailyQuota: 1 },
        { now: () => now, random: () => 0 },
      );
      const params = { group_id: GROUP_ID, message: atMessage() };
      expect(quota.check('send_group_msg', params, SELF_ID)).toMatchObject({ allowed: true });
      expect(quota.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'quota',
        retcode: 1504,
      });

      const rate = new SendGuard(
        { ...baseConfig(dir), minIntervalMs: 1_000 },
        { now: () => now, random: () => 0 },
      );
      expect(rate.check('send_group_msg', params, SELF_ID)).toMatchObject({ allowed: true });
      expect(rate.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'rate_limit',
        retcode: 1504,
        retryAfterMs: 1_000,
      });

      const quietNow = new Date(2026, 0, 1, 2, 0, 0).getTime();
      const quiet = new SendGuard(
        { ...baseConfig(dir), quietHours: { startHour: 0, endHour: 8 } },
        { now: () => quietNow, random: () => 0 },
      );
      expect(quiet.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'quiet_hours',
        retcode: 1504,
      });
      void now;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('STOP sentinel blocks sends and the watchdog picks it up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    try {
      const guard = new SendGuard(baseConfig(dir));
      guard.startStopWatchdog(10);
      const params = { group_id: GROUP_ID, message: atMessage() };

      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({ allowed: true });

      writeFileSync(join(dir, 'STOP'), 'stop');
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });

      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'stop',
        retcode: 1508,
      });
      expect(guard.blockedCount('stop')).toBe(1);
      guard.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires into ActionRouter before the send handler runs', async () => {
    let handlerCalled = false;
    const router = new ActionRouter({
      isSendAction: () => true,
      check: () => ({ allowed: false, reason: 'stop', retcode: 1508 }),
    });
    router.register('send_group_msg', () => {
      handlerCalled = true;
      return { message_id: 1 };
    });

    const response = await router.dispatch(
      { action: 'send_group_msg', params: { group_id: 1 }, echo: 'e1' },
      SELF_ID,
    );

    expect(response).toMatchObject({ status: 'failed', retcode: 1508, echo: 'e1' });
    expect(handlerCalled).toBe(false);
  });

  it('persists quota and circuit state across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    const dbPath = join(dir, 'guard.db');
    const now = 1_000_000;
    const firstDb = openSqliteDatabase(dbPath);
    const firstStore = new SendGuardStore(firstDb);
    try {
      const first = new SendGuard(
        { ...baseConfig(dir), dailyQuota: 1 },
        { now: () => now, random: () => 0, storage: firstStore },
      );
      expect(
        first.check('send_group_msg', { group_id: GROUP_ID, message: atMessage('first') }, SELF_ID),
      ).toMatchObject({ allowed: true });
      first.reportSecuritySignal('test-signal');
      expect(first.snapshot().circuit).toBe('OPEN');
    } finally {
      firstDb.close();
    }

    const secondDb = openSqliteDatabase(dbPath);
    const secondStore = new SendGuardStore(secondDb);
    try {
      const second = new SendGuard(
        { ...baseConfig(dir), dailyQuota: 1 },
        { now: () => now + 100, random: () => 0, storage: secondStore },
      );
      expect(second.snapshot().circuit).toBe('OPEN');
      second.resetCircuit();
      expect(
        second.check(
          'send_group_msg',
          { group_id: GROUP_ID, message: atMessage('second') },
          SELF_ID,
        ),
      ).toMatchObject({ allowed: false, reason: 'quota', retcode: 1504 });
    } finally {
      secondDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes metadata-only audit records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    const db = openSqliteDatabase(join(dir, 'guard.db'));
    try {
      const store = new SendGuardStore(db);
      const guard = new SendGuard(baseConfig(dir), {
        now: () => 1_000_000,
        random: () => 0,
        storage: store,
      });

      expect(
        guard.check(
          'send_group_msg',
          { group_id: GROUP_ID, message: atMessage('secret text') },
          SELF_ID,
        ),
      ).toMatchObject({ allowed: true });

      const [record] = store.recentAudit(1);
      expect(record).toMatchObject({
        accountId: SELF_ID,
        action: 'send_group_msg',
        targetType: 'group',
        targetId: String(GROUP_ID),
        decision: 'allowed',
        reason: 'allowed',
        retcode: 0,
      });
      expect(record?.messageHash).toMatch(/^[0-9a-f]{32}$/);
      expect(record?.messageLength).toBeGreaterThan(0);
      expect(JSON.stringify(record)).not.toContain('secret text');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the circuit on probe degradation and requires manual reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    let health = 'ONLINE';
    try {
      const guard = new SendGuard(baseConfig(dir), {
        now: () => 1_000_000,
        random: () => 0,
        healthProvider: () => health,
      });
      const params = { group_id: GROUP_ID, message: atMessage('one') };

      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({ allowed: true });
      health = 'DEGRADED';
      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'probe_unhealthy',
        retcode: 1502,
      });
      health = 'ONLINE';
      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'circuit_open',
        retcode: 1502,
      });

      guard.resetCircuit();
      expect(
        guard.check(
          'send_group_msg',
          { group_id: GROUP_ID, message: atMessage('after-reset') },
          SELF_ID,
        ),
      ).toMatchObject({ allowed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the circuit after repeated send failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    try {
      const guard = new SendGuard(
        { ...baseConfig(dir), sendFailureThreshold: 3 },
        { now: () => 1_000_000, random: () => 0 },
      );
      guard.reportSendFailure();
      guard.reportSendFailure();
      expect(guard.snapshot().circuit).toBe('CLOSED');
      guard.reportSendFailure();
      expect(guard.snapshot().circuit).toBe('OPEN');
      expect(
        guard.check(
          'send_group_msg',
          { group_id: GROUP_ID, message: atMessage('blocked') },
          SELF_ID,
        ),
      ).toMatchObject({ allowed: false, reason: 'circuit_open' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suppresses duplicate content within the configured window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-guard-'));
    try {
      const guard = new SendGuard(
        { ...baseConfig(dir), duplicateWindowMs: 60_000 },
        { now: () => 1_000_000, random: () => 0 },
      );
      const params = { group_id: GROUP_ID, message: atMessage('repeat') };
      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({ allowed: true });
      expect(guard.check('send_group_msg', params, SELF_ID)).toMatchObject({
        allowed: false,
        reason: 'duplicate',
        retcode: 1504,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
