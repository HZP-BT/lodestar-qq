import type { AdapterLoginState } from '../adapter/types.js';

/**
 * Runtime health, derived from the OneBot reverse-WS connection and the
 * adapter-confirmed login state. There is no independent active probe: Core
 * never sends synthetic actions to decide whether it is healthy.
 */
export type HealthState = 'UNKNOWN' | 'ONLINE' | 'OFFLINE';

export interface RuntimeHealth {
  state: HealthState;
  loginState: AdapterLoginState;
}

export function deriveHealth(connected: boolean, loginState: AdapterLoginState): HealthState {
  if (!connected) {
    return 'OFFLINE';
  }
  return loginState === 'LOGGED_IN' ? 'ONLINE' : 'UNKNOWN';
}
