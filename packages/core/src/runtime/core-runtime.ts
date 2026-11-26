import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AdapterActionError } from '../adapter/action-error.js';
import { EventSinkImpl } from '../adapter/event-sink.js';
import type { AdapterActionResult, AdapterInterface, AdapterLoginState } from '../adapter/types.js';
import type { Logger } from '../logger.js';
import { nullLogger } from '../logger.js';
import { ReverseWsClient } from '../onebot/reverse-ws-client.js';
import type { ReverseWsClientOptions } from '../onebot/reverse-ws-client.js';
import { AdminAuditStore } from '../storage/admin-audit-store.js';
import { openSqliteDatabase } from '../storage/database.js';
import type { SqliteDatabase } from '../storage/database.js';
import { EventStore } from '../storage/event-store.js';
import { OutboxDispatcher } from '../storage/outbox-dispatcher.js';
import { deriveHealth } from './health.js';
import type { RuntimeHealth } from './health.js';

export interface CoreRuntimeOptions {
  adapter: AdapterInterface;
  client: Omit<ReverseWsClientOptions, 'selfId' | 'loginProvider' | 'logger'>;
  databasePath?: string;
  logger?: Logger;
  /** How often the adapter's reported login state is refreshed. */
  statusIntervalMs?: number;
  replayManifest?: string[];
}

export interface CoreRuntimeStatus {
  clientState: string;
  accountId: number;
  sessionId: string;
  pendingEvents: number;
  replayableEvents: number;
  health: RuntimeHealth;
}

/**
 * Wires an AdapterInterface into the Core pipeline:
 * adapter -> EventSink -> EventStore/Outbox -> ReverseWsClient -> AstrBot.
 */
export class CoreRuntime {
  readonly adapter: AdapterInterface;

  private readonly options: CoreRuntimeOptions;
  private readonly logger: Logger;
  private readonly sessionId: string;
  private db: SqliteDatabase | null = null;
  private store: EventStore | null = null;
  private adminAuditStore: AdminAuditStore | null = null;
  private client: ReverseWsClient | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private loginState: AdapterLoginState = 'UNKNOWN';
  private started = false;

  constructor(options: CoreRuntimeOptions) {
    this.options = options;
    this.adapter = options.adapter;
    this.logger = options.logger ?? nullLogger;
    this.sessionId = randomUUID();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const databasePath = this.options.databasePath ?? 'data/polaris.db';
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    const db = openSqliteDatabase(databasePath);
    const store = new EventStore(db);
    this.db = db;
    this.store = store;
    this.adminAuditStore = new AdminAuditStore(db);

    const client = new ReverseWsClient({
      ...this.options.client,
      selfId: this.adapter.accountId,
      logger: this.logger,
      loginProvider: () => this.loginState,
    });
    this.client = client;

    const send = (event: Parameters<ReverseWsClient['sendEvent']>[0]): boolean => {
      try {
        client.sendEvent(event);
        return true;
      } catch {
        return false;
      }
    };

    const sink = new EventSinkImpl(store, send);
    const dispatcher = new OutboxDispatcher(store, send);

    client.onOpen(() => {
      const result = dispatcher.flush(this.adapter.accountId);
      this.logger.info(
        { accountId: this.adapter.accountId, ...result },
        'outbox replay on reconnect',
      );
    });

    const executeAdapterAction = async (
      params: Record<string, unknown>,
      context: { action: string; selfId: number; echo: unknown },
    ): Promise<unknown> => {
      const action = context.action;
      const result: AdapterActionResult = await this.adapter.execute(action, params, context);

      if (!result.ok) {
        throw new AdapterActionError(
          result.message ?? `Adapter action failed: ${action}`,
          result.retcode ?? 1500,
          result.data ?? null,
        );
      }

      return result.data ?? null;
    };

    for (const action of this.adapter.capabilities().actions) {
      client.registerAction(action, executeAdapterAction);
    }
    // Real backends can implement actions beyond the advertised list; forward
    // unknown actions and let the upstream return its own retcode.
    client.registerFallbackAction(executeAdapterAction);

    await this.adapter.start(
      sink,
      { sessionId: this.sessionId, accountId: this.adapter.accountId },
      this.options.replayManifest ?? [],
    );

    await this.refreshAdapterStatus();
    const statusIntervalMs = this.options.statusIntervalMs ?? 5_000;
    this.statusTimer = setInterval(() => {
      void this.refreshAdapterStatus();
    }, statusIntervalMs);
    this.statusTimer.unref?.();

    client.start();

    this.started = true;
    this.logger.info(
      { accountId: this.adapter.accountId, sessionId: this.sessionId },
      'core runtime started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    await this.adapter.stop();
    await this.client?.stop();
    this.db?.close();
    this.started = false;
  }

  status(): CoreRuntimeStatus {
    return {
      clientState: this.client?.state ?? 'idle',
      accountId: this.adapter.accountId,
      sessionId: this.sessionId,
      pendingEvents: this.store?.pendingCount(this.adapter.accountId) ?? 0,
      replayableEvents: this.store?.listReplayable(this.adapter.accountId).length ?? 0,
      health: this.health,
    };
  }

  get health(): RuntimeHealth {
    if (!this.client) {
      return { state: 'UNKNOWN', loginState: this.loginState };
    }
    return {
      state: deriveHealth(this.client.isOpen, this.loginState),
      loginState: this.loginState,
    };
  }

  get clientInstance(): ReverseWsClient | null {
    return this.client;
  }

  get storeInstance(): EventStore | null {
    return this.store;
  }

  get adminAuditStoreInstance(): AdminAuditStore | null {
    return this.adminAuditStore;
  }

  private async refreshAdapterStatus(): Promise<void> {
    try {
      const health = await this.adapter.health();
      this.loginState = health.loginState;
    } catch {
      // The adapter cannot report; do not keep claiming a logged-in account.
      this.loginState = 'UNKNOWN';
    }
  }
}
