import type { OneBotEvent } from '../onebot/types.js';

/**
 * lifecycle/heartbeat are Core-owned. An adapter that tries to publish a
 * meta_event would create duplicate online state and heartbeat conflicts on
 * the AstrBot side (ADR 0005), so the EventSink rejects it.
 */
export function isAdapterForbiddenEvent(event: OneBotEvent): boolean {
  return event.post_type === 'meta_event';
}
