export interface ExponentialBackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Fraction of the nominal delay, in [0, 1]. */
  jitter: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Exponential backoff with full-width jitter around the nominal delay.
 * The attempt counter is reset only after a connection has been stable for a
 * while, not immediately on open, to avoid a reconnect hot loop.
 */
export class ExponentialBackoff {
  private attempts = 0;
  private readonly random: () => number;

  constructor(private readonly options: ExponentialBackoffOptions) {
    if (!Number.isFinite(options.baseMs) || options.baseMs <= 0) {
      throw new RangeError('baseMs must be a positive number');
    }

    if (!Number.isFinite(options.maxMs) || options.maxMs < options.baseMs) {
      throw new RangeError('maxMs must be greater than or equal to baseMs');
    }

    if (!Number.isFinite(options.jitter) || options.jitter < 0 || options.jitter > 1) {
      throw new RangeError('jitter must be between 0 and 1');
    }

    this.random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.attempts;
  }

  reset(): void {
    this.attempts = 0;
  }

  next(): number {
    const exponent = Math.min(this.attempts, 30);
    const nominal = Math.min(this.options.maxMs, this.options.baseMs * 2 ** exponent);
    this.attempts += 1;

    const jitter = nominal * this.options.jitter * (this.random() * 2 - 1);
    return Math.max(0, Math.round(nominal + jitter));
  }
}
