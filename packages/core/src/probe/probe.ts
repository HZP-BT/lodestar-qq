import type { AdapterHealth, AdapterInterface, AdapterLoginState } from '../adapter/types.js';
import type { HealthState } from '../onebot/reverse-ws-client.js';

export interface ProbeConfig {
  probeIntervalMs: number;
  actionTimeoutMs: number;
  degradedFailures: number;
  offlineFailures: number;
  offlineFailureWindowMs: number;
  activeWindowMs: number;
  idleAfterMs: number;
  stagnantDegradedMs: number;
  stagnantOfflineMs: number;
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  probeIntervalMs: 15_000,
  actionTimeoutMs: 5_000,
  degradedFailures: 3,
  offlineFailures: 5,
  offlineFailureWindowMs: 90_000,
  activeWindowMs: 10 * 60_000,
  idleAfterMs: 10 * 60_000,
  stagnantDegradedMs: 60_000,
  stagnantOfflineMs: 120_000,
};

export interface ProbeSnapshot {
  state: HealthState;
  loginState: AdapterLoginState;
  actionFailures: number;
  lastActionOkAt: number;
  lastInboundAt: number;
  inboundCursor: number | null;
  lastCursorChangeAt: number;
  lastNonce: string | null;
}

/**
 * Health state machine. It is deliberately independent of Core's event loop:
 * callers own the timer (or run it in a separate process), and this class only
 * evaluates snapshots.
 */
export class Probe {
  private readonly config: ProbeConfig;
  private readonly now: () => number;
  private readonly initializedAt: number;
  private timer: NodeJS.Timeout | null = null;

  private state: HealthState = 'UNKNOWN';
  private loginState: AdapterLoginState = 'UNKNOWN';
  private actionFailures = 0;
  private lastActionOkAt = 0;
  private lastInboundAt = 0;
  private inboundCursor: number | null = null;
  private lastCursorChangeAt = 0;
  private lastNonce: string | null = null;

  constructor(config: Partial<ProbeConfig> = {}, options: { now?: () => number } = {}) {
    this.config = { ...DEFAULT_PROBE_CONFIG, ...config };
    this.now = options.now ?? Date.now;
    this.initializedAt = this.now();
  }

  get healthState(): HealthState {
    return this.state;
  }

  get adapterLoginState(): AdapterLoginState {
    return this.loginState;
  }

  snapshot(): ProbeSnapshot {
    return {
      state: this.state,
      loginState: this.loginState,
      actionFailures: this.actionFailures,
      lastActionOkAt: this.lastActionOkAt,
      lastInboundAt: this.lastInboundAt,
      inboundCursor: this.inboundCursor,
      lastCursorChangeAt: this.lastCursorChangeAt,
      lastNonce: this.lastNonce,
    };
  }

  observe(health: AdapterHealth, now = this.now()): void {
    this.loginState = health.loginState;

    if (health.inboundCursor !== undefined) {
      if (this.inboundCursor === null) {
        this.inboundCursor = health.inboundCursor;
        this.lastCursorChangeAt = now;
      } else if (health.inboundCursor !== this.inboundCursor) {
        this.inboundCursor = health.inboundCursor;
        this.lastCursorChangeAt = now;
        this.lastInboundAt = now;
      }
    }

    if (health.lastInboundAt !== undefined && health.lastInboundAt > this.lastInboundAt) {
      this.lastInboundAt = health.lastInboundAt;
    }

    if (health.inboundNonceSeen !== undefined && health.inboundNonceSeen !== this.lastNonce) {
      this.lastNonce = health.inboundNonceSeen;
      this.lastInboundAt = now;
      this.lastCursorChangeAt = now;
    }

    this.evaluate(now);
  }

  recordActionProbe(ok: boolean, now = this.now()): void {
    if (ok) {
      this.actionFailures = 0;
      this.lastActionOkAt = now;
    } else {
      this.actionFailures += 1;
    }

    this.evaluate(now);
  }

  start(adapter: AdapterInterface): void {
    if (this.timer) {
      return;
    }

    const tick = (): void => {
      void this.probeOnce(adapter);
    };

    tick();
    this.timer = setInterval(tick, this.config.probeIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async probeOnce(adapter: AdapterInterface): Promise<void> {
    const now = this.now();

    try {
      const health = await adapter.health();
      this.observe(health, now);
    } catch {
      this.observe(
        {
          process: 'ready',
          loginState: this.loginState,
          dataPlane: 'dead',
        },
        now,
      );
    }

    const ok = await withTimeout(
      adapter.execute(
        'get_login_info',
        {},
        { action: 'get_login_info', selfId: adapter.accountId, echo: null },
      ),
      this.config.actionTimeoutMs,
    )
      .then((result) => result.ok)
      .catch(() => false);

    this.recordActionProbe(ok, now);

    try {
      this.observe(await adapter.health(), this.now());
    } catch {
      // Keep the last known state; the next probe will retry.
    }
  }

  private evaluate(now: number): void {
    if (
      this.actionFailures >= this.config.offlineFailures ||
      (this.lastActionOkAt > 0 && now - this.lastActionOkAt >= this.config.offlineFailureWindowMs)
    ) {
      this.state = 'OFFLINE';
      return;
    }

    if (this.actionFailures >= this.config.degradedFailures) {
      this.state = 'DEGRADED';
      return;
    }

    const actionFresh =
      this.lastActionOkAt > 0 &&
      now - this.lastActionOkAt <
        Math.max(this.config.probeIntervalMs * 2, this.config.stagnantDegradedMs);

    if (this.lastInboundAt > 0) {
      const idleFor = now - this.lastInboundAt;

      if (idleFor >= this.config.idleAfterMs) {
        this.state = 'IDLE';
        return;
      }

      if (idleFor < this.config.activeWindowMs) {
        // A successful action probe proves the data plane is still answering.
        // Inbound silence alone is normal for an idle bot, so only treat a
        // stagnant cursor as a symptom when the action probe is also stale.
        if (!actionFresh) {
          const stagnantFor = now - this.lastCursorChangeAt;

          if (stagnantFor >= this.config.stagnantOfflineMs) {
            this.state = 'OFFLINE';
            return;
          }

          if (stagnantFor >= this.config.stagnantDegradedMs) {
            this.state = 'DEGRADED';
            return;
          }
        }

        this.state = 'ONLINE';
        return;
      }
    }

    if (this.lastActionOkAt > 0 && now - this.initializedAt >= this.config.idleAfterMs) {
      this.state = 'IDLE';
      return;
    }

    this.state = 'UNKNOWN';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
