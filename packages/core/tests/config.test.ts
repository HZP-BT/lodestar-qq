import { describe, expect, it } from 'vitest';

import { parseReverseWsConfig } from '../src/config.js';

describe('parseReverseWsConfig', () => {
  it('applies defaults for a minimal AstrBot configuration', () => {
    const config = parseReverseWsConfig({
      url: 'ws://127.0.0.1:6199/ws',
      selfId: '10001',
    });

    expect(config.selfId).toBe(10001);
    expect(config.tokenScheme).toBe('Bearer');
    expect(config.tokenPlacement).toBe('header');
    expect(config.clientRole).toBe('Universal');
    expect(config.reconnect.enabled).toBe(true);
    expect(config.reconnect.baseMs).toBe(1_000);
    expect(config.heartbeat.intervalMs).toBe(30_000);
    expect(config.maxConcurrentActions).toBe(8);
  });

  it('rejects a non-WebSocket URL', () => {
    expect(() =>
      parseReverseWsConfig({
        url: 'http://127.0.0.1:6199/ws',
        selfId: 10001,
      }),
    ).toThrow();
  });

  it('rejects a negative self id', () => {
    expect(() =>
      parseReverseWsConfig({
        url: 'ws://127.0.0.1:6199/ws',
        selfId: -1,
      }),
    ).toThrow();
  });
});
