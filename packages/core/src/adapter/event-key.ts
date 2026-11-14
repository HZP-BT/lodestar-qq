import { createHash } from 'node:crypto';

export interface EventKeyInput {
  accountId: number;
  /** Native message/event id when available. */
  sourceEventId?: string;
  /**
   * Core-assigned, persistent monotonic delivery sequence. It never resets on
   * adapter restart and is the ordering key for replay.
   */
  deliverSeq: number;
}

/**
 * Idempotency key for an adapter delivery.
 *
 * The payload is deliberately NOT hashed: two genuine messages with identical
 * text ("好的", "1", repeated stickers) must not collapse into one event.
 *
 * - With a native source id, dedupe the same source event across adapter
 *   restarts/sessions.
 * - Without a source id, each Core delivery is unique (deliverSeq), so there is
 *   no content-based dedupe. Adapters must supply sourceEventId for messages
 *   they want deduped across restarts.
 */
export function computeEventKey(input: EventKeyInput): string {
  const identity =
    input.sourceEventId && input.sourceEventId.length > 0
      ? `source:${input.sourceEventId}`
      : `delivery:${input.deliverSeq}`;

  return createHash('sha256').update(`${input.accountId}:${identity}`, 'utf8').digest('hex');
}
