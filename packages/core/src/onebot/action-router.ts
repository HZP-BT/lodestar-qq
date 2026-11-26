import { errorMessage } from './errors.js';
import { AdapterActionError } from '../adapter/action-error.js';
import type { OneBotActionRequest, OneBotActionResponse } from './types.js';
import { isRecord } from './types.js';

/**
 * Numeric retcodes used by Lodestar.
 *
 * OneBot v11 only defines `status`/`retcode` fields and leaves the numeric
 * values implementation-defined. 0/1/100/102 and the 14xx WebSocket mapping
 * come from the CQHTTP docs; 1500-1507 are Lodestar extensions. See ADR 0003.
 */
export const RETCODE = {
  OK: 0,
  ASYNC: 1,
  BAD_REQUEST: 100,
  INVALID_DATA: 102,
  WS_BAD_REQUEST: 1400,
  WS_UNAUTHORIZED: 1401,
  WS_FORBIDDEN: 1403,
  ACTION_NOT_FOUND: 1404,
  INTERNAL_ERROR: 1500,
  ACTION_TIMEOUT: 1501,
  ADAPTER_UNAVAILABLE: 1502,
  BACKPRESSURE: 1503,
  RATE_LIMITED: 1504,
  VERSION_INCOMPATIBLE: 1505,
  AUTH_FAILED: 1506,
  MESSAGE_NOT_FOUND: 1507,
  SEND_DISABLED: 1508,
} as const;

export interface ActionContext {
  action: string;
  selfId: number;
  echo: unknown;
}

export type ActionHandler = (params: Record<string, unknown>, context: ActionContext) => unknown;

/**
 * OneBot action dispatcher. Actions not present in the registry fail with
 * 1404 (CQHTTP WebSocket mapping for HTTP 404 / action not found) instead of
 * being silently dropped.
 */
export class ActionRouter {
  private readonly handlers = new Map<string, ActionHandler>();
  private fallback: ActionHandler | null = null;

  register(action: string, handler: ActionHandler): this {
    this.handlers.set(action, handler);
    return this;
  }

  setFallback(handler: ActionHandler): this {
    this.fallback = handler;
    return this;
  }

  has(action: string): boolean {
    return this.handlers.has(action);
  }

  list(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(request: OneBotActionRequest, selfId: number): Promise<OneBotActionResponse> {
    const echoPart = request.echo === undefined ? {} : { echo: request.echo };

    if (request.action.length === 0) {
      return {
        status: 'failed',
        retcode: RETCODE.BAD_REQUEST,
        data: null,
        message: 'Invalid action name',
        ...echoPart,
      };
    }

    if (request.params !== undefined && !isRecord(request.params)) {
      return {
        status: 'failed',
        retcode: RETCODE.BAD_REQUEST,
        data: null,
        message: 'params must be an object',
        ...echoPart,
      };
    }

    const handler = this.handlers.get(request.action) ?? this.fallback;

    if (!handler) {
      return {
        status: 'failed',
        retcode: RETCODE.ACTION_NOT_FOUND,
        data: null,
        message: `Action not found: ${request.action}`,
        ...echoPart,
      };
    }

    const params = request.params === undefined ? {} : request.params;

    try {
      const data = await handler(params, {
        action: request.action,
        selfId,
        echo: request.echo,
      });

      return {
        status: 'ok',
        retcode: RETCODE.OK,
        data: data ?? null,
        ...echoPart,
      };
    } catch (error) {
      if (error instanceof AdapterActionError) {
        return {
          status: 'failed',
          retcode: error.retcode,
          data: error.data,
          message: error.message,
          ...echoPart,
        };
      }

      return {
        status: 'failed',
        retcode: RETCODE.INTERNAL_ERROR,
        data: null,
        message: errorMessage(error),
        ...echoPart,
      };
    }
  }
}
