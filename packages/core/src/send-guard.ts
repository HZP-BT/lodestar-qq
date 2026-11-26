import { createHash } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

import { RETCODE } from './onebot/action-router.js';
import { isRecord } from './onebot/types.js';

export interface QuietHours {
  startHour: number;
  endHour: number;
}

export interface SendGuardConfig {
  /** Empty means all group sends are blocked (conservative default). */
  groupWhitelist: number[];
  /** When privateEnabled is true, an empty list allows all private peers. */
  privateWhitelist: number[];
  privateEnabled: boolean;
  atOnly: boolean;
  dailyQuota: number;
  perGroupDailyQuota: number | null;
  minIntervalMs: number;
  randomDelayMs: number;
  quietHours: QuietHours | null;
  /** Suppress identical content to the same target within this window. */
  duplicateWindowMs: number;
  /** Consecutive adapter send failures that open the circuit. */
  sendFailureThreshold: number;
  auditRetentionDays: number;
  stopFile: string;
}

export type SendBlockReason =
  | 'stop'
  | 'circuit_open'
  | 'security'
  | 'whitelist'
  | 'not_at'
  | 'quota'
  | 'rate_limit'
  | 'quiet_hours'
  | 'duplicate';

export type SendCircuitState = 'CLOSED' | 'OPEN';

export interface SendAuditRecord {
  id: number;
  accountId: number;
  action: string;
  targetType: string;
  targetId: string;
  decision: 'allowed' | 'blocked';
  reason: string;
  messageHash: string | null;
  messageLength: number | null;
  retcode: number | null;
  createdAt: number;
}

export interface SendGuardStorage {
  getQuota(key: string): number;
  incrementQuota(key: string, now: number): void;
  getLastSentAt(key: string): number | null;
  setLastSentAt(key: string, now: number): void;
  getCircuit(): { state: SendCircuitState; reason: string | null } | null;
  setCircuit(state: SendCircuitState, reason: string | null, now: number): void;
  writeAudit(record: Omit<SendAuditRecord, 'id'>): void;
  recentAudit(limit: number): SendAuditRecord[];
  pruneAudit(before: number): void;
}

export type SendDecision =
  | { allowed: true; delayMs: number }
  | {
      allowed: false;
      reason: SendBlockReason;
      retcode: number;
      retryAfterMs?: number;
    };

export const DEFAULT_SEND_GUARD_CONFIG: SendGuardConfig = {
  groupWhitelist: [],
  privateWhitelist: [],
  privateEnabled: true,
  atOnly: false,
  dailyQuota: 200,
  perGroupDailyQuota: 80,
  minIntervalMs: 2_000,
  randomDelayMs: 1_500,
  quietHours: null,
  duplicateWindowMs: 60_000,
  sendFailureThreshold: 3,
  auditRetentionDays: 30,
  stopFile: 'data/STOP',
};

export interface SendGuardOptions {
  now?: () => number;
  random?: () => number;
  storage?: SendGuardStorage;
}

/**
 * Core-owned send guard. It runs for every adapter/backend, before outbox or
 * adapter.execute(). It is not an adapter responsibility.
 *
 * Productized S1 behavior: SQLite-backed daily quota/rate/circuit/audit when a
 * storage is attached; conservative in-memory fallback for tests and CLI.
 */
export class SendGuard {
  private config: SendGuardConfig;
  private readonly now: () => number;
  private readonly random: () => number;
  private storage: SendGuardStorage | null;
  private stopTimer: NodeJS.Timeout | null = null;
  private stopDisabled = false;
  private circuit: SendCircuitState = 'CLOSED';
  private circuitReason: string | null = null;
  private consecutiveFailures = 0;
  private readonly dailyCounts = new Map<string, number>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly recentMessages = new Map<string, number>();
  private readonly blocked = new Map<SendBlockReason, number>();
  private allowed = 0;
  private auditTotal = 0;
  private lastAuditPruneAt = 0;

  constructor(config: Partial<SendGuardConfig> = {}, options: SendGuardOptions = {}) {
    this.config = { ...DEFAULT_SEND_GUARD_CONFIG, ...config };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.storage = options.storage ?? null;
    this.refreshStopFlag();
    this.loadCircuit();
    this.pruneAudit();
  }

  attachStorage(storage: SendGuardStorage): void {
    this.storage = storage;
    this.loadCircuit();
    this.pruneAudit();
  }

  startStopWatchdog(intervalMs = 5_000): void {
    this.stopTimer = setInterval(() => {
      this.refreshStopFlag();
    }, intervalMs);
    this.stopTimer.unref?.();
  }

  stop(): void {
    if (this.stopTimer) {
      clearInterval(this.stopTimer);
      this.stopTimer = null;
    }
  }

  refreshStopFlag(): boolean {
    this.stopDisabled = existsSync(this.config.stopFile);
    return this.stopDisabled;
  }

  isSendAction(action: string): boolean {
    return action.startsWith('send_') || action.startsWith('upload_');
  }

  check(action: string, params: Record<string, unknown>, selfId: number): SendDecision {
    this.refreshStopFlag();

    if (!this.isSendAction(action)) {
      return { allowed: true, delayMs: 0 };
    }

    const target = targetOf(params);
    const message = messageMeta(params);

    if (this.stopDisabled) {
      return this.block(action, selfId, target, message, 'stop', RETCODE.SEND_DISABLED);
    }

    if (this.circuit === 'OPEN') {
      return this.block(
        action,
        selfId,
        target,
        message,
        'circuit_open',
        RETCODE.ADAPTER_UNAVAILABLE,
      );
    }

    const now = this.now();
    this.maybePrune(now);
    const groupId = target.type === 'group' ? Number(target.id) : null;
    const userId = target.type === 'private' ? Number(target.id) : null;

    if (groupId !== null) {
      if (!this.config.groupWhitelist.includes(groupId)) {
        return this.block(action, selfId, target, message, 'whitelist', RETCODE.RATE_LIMITED);
      }

      if (this.config.atOnly && !containsAtSelf(params.message, selfId)) {
        return this.block(action, selfId, target, message, 'not_at', RETCODE.RATE_LIMITED);
      }
    } else if (userId !== null) {
      if (!this.config.privateEnabled) {
        return this.block(action, selfId, target, message, 'whitelist', RETCODE.RATE_LIMITED);
      }

      if (
        this.config.privateWhitelist.length > 0 &&
        !this.config.privateWhitelist.includes(userId)
      ) {
        return this.block(action, selfId, target, message, 'whitelist', RETCODE.RATE_LIMITED);
      }
    } else {
      return this.block(action, selfId, target, message, 'whitelist', RETCODE.RATE_LIMITED);
    }

    if (this.isQuietHours(now)) {
      return this.block(action, selfId, target, message, 'quiet_hours', RETCODE.RATE_LIMITED);
    }

    const rateKey = groupId !== null ? `${selfId}:group:${groupId}` : `${selfId}:private`;
    const lastSent = this.getLastSentAt(rateKey);
    const elapsed = now - lastSent;

    if (lastSent > 0 && elapsed < this.config.minIntervalMs) {
      return this.block(
        action,
        selfId,
        target,
        message,
        'rate_limit',
        RETCODE.RATE_LIMITED,
        this.config.minIntervalMs - elapsed,
      );
    }

    const date = localDate(now);
    const accountQuotaKey = `${selfId}:${date}:account`;
    if (this.getQuota(accountQuotaKey) >= this.config.dailyQuota) {
      return this.block(action, selfId, target, message, 'quota', RETCODE.RATE_LIMITED);
    }

    if (groupId !== null && this.config.perGroupDailyQuota !== null) {
      const groupQuotaKey = `${selfId}:group:${groupId}:${date}`;
      if (this.getQuota(groupQuotaKey) >= this.config.perGroupDailyQuota) {
        return this.block(action, selfId, target, message, 'quota', RETCODE.RATE_LIMITED);
      }
    }

    if (message.hash) {
      const duplicateKey = `${selfId}:${target.type}:${target.id}:${message.hash}`;
      const lastSeen = this.recentMessages.get(duplicateKey) ?? 0;
      if (lastSeen > 0 && now - lastSeen < this.config.duplicateWindowMs) {
        return this.block(action, selfId, target, message, 'duplicate', RETCODE.RATE_LIMITED);
      }
    }

    this.setLastSentAt(rateKey, now);
    this.incrementQuota(accountQuotaKey, now);
    if (groupId !== null) {
      this.incrementQuota(`${selfId}:group:${groupId}:${date}`, now);
    }
    if (message.hash) {
      this.recentMessages.set(`${selfId}:${target.type}:${target.id}:${message.hash}`, now);
    }

    this.allowed += 1;
    this.writeAudit(action, selfId, target, message, 'allowed', 'allowed', RETCODE.OK);

    return {
      allowed: true,
      delayMs: Math.floor(this.random() * (this.config.randomDelayMs + 1)),
    };
  }

  reportSendSuccess(): void {
    this.consecutiveFailures = 0;
  }

  reportSendFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.sendFailureThreshold) {
      this.openCircuit('send_failures');
    }
  }

  reportSecuritySignal(reason: string): void {
    this.openCircuit(`security:${reason}`);
  }

  resetCircuit(): void {
    this.circuit = 'CLOSED';
    this.circuitReason = null;
    this.consecutiveFailures = 0;
    this.storage?.setCircuit('CLOSED', null, this.now());
  }

  openCircuit(reason: string): void {
    this.circuit = 'OPEN';
    this.circuitReason = reason;
    this.storage?.setCircuit('OPEN', reason, this.now());
  }

  blockedCount(reason: SendBlockReason): number {
    return this.blocked.get(reason) ?? 0;
  }

  snapshot(): {
    circuit: SendCircuitState;
    circuitReason: string | null;
    stopDisabled: boolean;
    allowed: number;
    blocked: Record<string, number>;
    auditTotal: number;
  } {
    return {
      circuit: this.circuit,
      circuitReason: this.circuitReason,
      stopDisabled: this.stopDisabled,
      allowed: this.allowed,
      blocked: Object.fromEntries(this.blocked),
      auditTotal: this.auditTotal,
    };
  }

  configSnapshot(): SendGuardConfig {
    return {
      ...this.config,
      groupWhitelist: [...this.config.groupWhitelist],
      privateWhitelist: [...this.config.privateWhitelist],
      quietHours: this.config.quietHours ? { ...this.config.quietHours } : null,
    };
  }

  quotaSnapshot(selfId: number): {
    date: string;
    account: { used: number; limit: number };
    groups: Array<{ groupId: number; used: number; limit: number | null }>;
  } {
    const date = localDate(this.now());
    return {
      date,
      account: {
        used: this.getQuota(`${selfId}:${date}:account`),
        limit: this.config.dailyQuota,
      },
      groups: this.config.groupWhitelist.map((groupId) => ({
        groupId,
        used: this.getQuota(`${selfId}:group:${groupId}:${date}`),
        limit: this.config.perGroupDailyQuota,
      })),
    };
  }

  updateConfig(patch: Partial<SendGuardConfig>): void {
    this.config = {
      ...this.config,
      ...patch,
      ...(patch.groupWhitelist ? { groupWhitelist: [...patch.groupWhitelist] } : {}),
      ...(patch.privateWhitelist ? { privateWhitelist: [...patch.privateWhitelist] } : {}),
      ...(patch.quietHours !== undefined
        ? { quietHours: patch.quietHours ? { ...patch.quietHours } : null }
        : {}),
    };
    this.refreshStopFlag();
  }

  writeStopSentinel(): void {
    writeFileSync(this.config.stopFile, 'stop\n', 'utf8');
    this.refreshStopFlag();
  }

  clearStopSentinel(): void {
    try {
      unlinkSync(this.config.stopFile);
    } catch {
      // Missing STOP is the desired state.
    }
    this.refreshStopFlag();
  }

  stopFilePath(): string {
    return this.config.stopFile;
  }

  private loadCircuit(): void {
    const stored = this.storage?.getCircuit();
    if (stored) {
      this.circuit = stored.state;
      this.circuitReason = stored.reason;
    }
  }

  private pruneAudit(): void {
    if (!this.storage) {
      return;
    }
    const now = this.now();
    const before = now - this.config.auditRetentionDays * 24 * 60 * 60 * 1_000;
    this.storage.pruneAudit(before);
    this.lastAuditPruneAt = now;
  }

  private maybePrune(now: number): void {
    if (this.storage && now - this.lastAuditPruneAt > 24 * 60 * 60 * 1_000) {
      this.storage.pruneAudit(now - this.config.auditRetentionDays * 24 * 60 * 60 * 1_000);
      this.lastAuditPruneAt = now;
    }

    if (this.recentMessages.size > 1_024) {
      for (const [key, seenAt] of this.recentMessages) {
        if (now - seenAt >= this.config.duplicateWindowMs) {
          this.recentMessages.delete(key);
        }
      }
    }
  }

  private getQuota(key: string): number {
    return this.storage ? this.storage.getQuota(key) : (this.dailyCounts.get(key) ?? 0);
  }

  private incrementQuota(key: string, now: number): void {
    if (this.storage) {
      this.storage.incrementQuota(key, now);
    } else {
      this.dailyCounts.set(key, (this.dailyCounts.get(key) ?? 0) + 1);
    }
  }

  private getLastSentAt(key: string): number {
    if (this.storage) {
      return this.storage.getLastSentAt(key) ?? 0;
    }
    return this.lastSentAt.get(key) ?? 0;
  }

  private setLastSentAt(key: string, now: number): void {
    if (this.storage) {
      this.storage.setLastSentAt(key, now);
    } else {
      this.lastSentAt.set(key, now);
    }
  }

  private block(
    action: string,
    selfId: number,
    target: Target,
    message: MessageMeta,
    reason: SendBlockReason,
    retcode: number,
    retryAfterMs?: number,
  ): SendDecision {
    this.blocked.set(reason, (this.blocked.get(reason) ?? 0) + 1);
    this.writeAudit(action, selfId, target, message, 'blocked', reason, retcode);
    return {
      allowed: false,
      reason,
      retcode,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  private writeAudit(
    action: string,
    selfId: number,
    target: Target,
    message: MessageMeta,
    decision: 'allowed' | 'blocked',
    reason: string,
    retcode: number,
  ): void {
    this.auditTotal += 1;
    if (!this.storage) {
      return;
    }
    this.storage.writeAudit({
      accountId: selfId,
      action,
      targetType: target.type,
      targetId: target.id,
      decision,
      reason,
      messageHash: message.hash,
      messageLength: message.length,
      retcode,
      createdAt: this.now(),
    });
  }

  private isQuietHours(now: number): boolean {
    if (!this.config.quietHours) {
      return false;
    }

    const hour = new Date(now).getHours();
    const { startHour, endHour } = this.config.quietHours;

    if (startHour === endHour) {
      return false;
    }

    return startHour < endHour
      ? hour >= startHour && hour < endHour
      : hour >= startHour || hour < endHour;
  }
}

interface Target {
  type: 'group' | 'private' | 'unknown';
  id: string;
}

interface MessageMeta {
  hash: string | null;
  length: number | null;
}

function targetOf(params: Record<string, unknown>): Target {
  const groupId = toId(params.group_id);
  if (groupId !== null) {
    return { type: 'group', id: String(groupId) };
  }

  const userId = toId(params.user_id);
  if (userId !== null) {
    return { type: 'private', id: String(userId) };
  }

  return { type: 'unknown', id: '' };
}

function messageMeta(params: Record<string, unknown>): MessageMeta {
  if (params.message === undefined) {
    return { hash: null, length: null };
  }

  const serialized = JSON.stringify(params.message);
  return {
    hash: createHash('sha256').update(serialized).digest('hex').slice(0, 32),
    length: serialized.length,
  };
}

function toId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

function containsAtSelf(message: unknown, selfId: number): boolean {
  if (!Array.isArray(message)) {
    return false;
  }

  return message.some(
    (segment) =>
      isRecord(segment) &&
      segment.type === 'at' &&
      isRecord(segment.data) &&
      String(segment.data.qq) === String(selfId),
  );
}

function localDate(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
