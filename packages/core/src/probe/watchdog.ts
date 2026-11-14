import { Worker } from 'node:worker_threads';

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const beats = new BigInt64Array(workerData.buffer);
const timeout = BigInt(workerData.timeoutMs);
setInterval(() => {
  const last = Atomics.load(beats, 0);
  if (last > 0n && BigInt(Date.now()) - last > timeout) {
    // The main thread is blocked; SIGKILL guarantees the supervisor can restart.
    process.kill(process.pid, 'SIGKILL');
  }
}, workerData.intervalMs);
`;

export interface WatchdogOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * MOCK-14: a worker thread monitors a SharedArrayBuffer heartbeat. If the Core
 * event loop blocks, the worker cannot see a beat and kills the process so an
 * external supervisor (systemd/docker/Scheduled Task) can restart it.
 */
export class Watchdog {
  private readonly beats: BigInt64Array;
  private readonly worker: Worker;
  private autoBeatTimer: NodeJS.Timeout | null = null;

  constructor(options: WatchdogOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const intervalMs = options.intervalMs ?? 1_000;

    if (!Number.isInteger(timeoutMs) || timeoutMs < 50) {
      throw new RangeError('timeoutMs must be an integer >= 50');
    }

    if (!Number.isInteger(intervalMs) || intervalMs < 10) {
      throw new RangeError('intervalMs must be an integer >= 10');
    }

    const buffer = new SharedArrayBuffer(8);
    this.beats = new BigInt64Array(buffer);
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { buffer, timeoutMs, intervalMs },
    });
    this.worker.unref();
    this.beat();
  }

  beat(now = Date.now()): void {
    Atomics.store(this.beats, 0, BigInt(now));
  }

  startAutoBeat(intervalMs = 1_000): void {
    this.autoBeatTimer = setInterval(() => {
      this.beat();
    }, intervalMs);
    this.autoBeatTimer.unref?.();
  }

  stop(): void {
    if (this.autoBeatTimer) {
      clearInterval(this.autoBeatTimer);
      this.autoBeatTimer = null;
    }

    void this.worker.terminate();
  }
}
