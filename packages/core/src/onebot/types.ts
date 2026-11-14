/**
 * OneBot v11 envelope types. The event union is intentionally open: adapters
 * add fields, and Lodestar should forward unknown fields instead of dropping
 * them.
 */
export interface OneBotEvent {
  time: number;
  self_id: number;
  post_type: string;
  [key: string]: unknown;
}

export interface OneBotActionRequest {
  action: string;
  params?: unknown;
  echo?: unknown;
}

export interface OneBotActionResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
  echo?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
