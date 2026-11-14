import { z } from 'zod';

const tokenSchemeSchema = z.enum(['Bearer', 'Token']);
const tokenPlacementSchema = z.enum(['header', 'query', 'both']);

const reconnectSchema = z.object({
  enabled: z.boolean().default(true),
  baseMs: z.number().int().positive().default(1_000),
  maxMs: z.number().int().positive().default(30_000),
  jitter: z.number().min(0).max(1).default(0.2),
  resetAfterMs: z.number().int().min(0).default(10_000),
});

const heartbeatSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(50).default(30_000),
  requirePong: z.boolean().default(true),
});

export const reverseWsConfigSchema = z.object({
  /** AstrBot's reverse WebSocket endpoint, for example ws://127.0.0.1:6199/ws. */
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
      message: 'url must use ws:// or wss://',
    }),
  /** QQ account id sent as the X-Self-ID header. Use 0 only for a mock/demo. */
  selfId: z
    .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
    .transform((value) => Number(value)),
  accessToken: z.string().min(1).optional(),
  /** aiocqhttp accepts both "Bearer <token>" and "Token <token>". */
  tokenScheme: tokenSchemeSchema.default('Bearer'),
  /** aiocqhttp only checks the Authorization header; query is for other servers. */
  tokenPlacement: tokenPlacementSchema.default('header'),
  clientRole: z.enum(['Universal', 'Event', 'Api']).default('Universal'),
  reconnect: reconnectSchema.default({}),
  heartbeat: heartbeatSchema.default({}),
  maxConcurrentActions: z.number().int().min(1).max(64).default(8),
  actionTimeoutMs: z.number().int().positive().default(30_000),
});

export type ReverseWsConfig = z.infer<typeof reverseWsConfigSchema>;

export function parseReverseWsConfig(input: unknown): ReverseWsConfig {
  return reverseWsConfigSchema.parse(input);
}
