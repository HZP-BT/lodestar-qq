import { describe, expect, it } from 'vitest';

import { buildAuthHeaders, withQueryToken } from '../src/onebot/auth.js';

describe('auth helpers', () => {
  it('builds Bearer and Token authorization headers', () => {
    expect(buildAuthHeaders('abc', 'Bearer')).toEqual({
      Authorization: 'Bearer abc',
    });
    expect(buildAuthHeaders('abc', 'Token')).toEqual({
      Authorization: 'Token abc',
    });
  });

  it('returns no header without a token', () => {
    expect(buildAuthHeaders(undefined)).toEqual({});
    expect(buildAuthHeaders('')).toEqual({});
  });

  it('adds a query token only when requested', () => {
    const url = 'ws://127.0.0.1:6199/ws';
    expect(withQueryToken(url, 'abc', 'header')).toBe(url);
    expect(withQueryToken(url, 'abc', 'query')).toBe('ws://127.0.0.1:6199/ws?access_token=abc');
    expect(withQueryToken(url, undefined, 'query')).toBe(url);
  });
});
