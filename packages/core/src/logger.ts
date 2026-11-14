import pino from 'pino';

/**
 * The small logging surface Lodestar depends on. Keeping it narrow makes the
 * core testable without a real pino transport.
 */
export interface Logger {
  debug(message: string): void;
  debug(obj: Record<string, unknown>, message?: string): void;
  info(message: string): void;
  info(obj: Record<string, unknown>, message?: string): void;
  warn(message: string): void;
  warn(obj: Record<string, unknown>, message?: string): void;
  error(message: string): void;
  error(obj: Record<string, unknown>, message?: string): void;
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  const instance = pino({
    level:
      options.level ?? process.env.LODESTAR_LOG_LEVEL ?? process.env.POLARIS_LOG_LEVEL ?? 'info',
    name: options.name ?? 'polaris',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  return instance;
}
