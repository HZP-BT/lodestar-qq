import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AdapterActionError } from '../adapter/action-error.js';
import { EventSinkImpl } from '../adapter/event-sink.js';
import type { AdapterActionResult, AdapterInterface } from '../adapter/types.js';
import type { Logger } from '../logger.js';
import { nullLogger } from '../logger.js';
import { ReverseWsClient } from '../onebot/reverse-ws-client.js';
import type { ReverseWsClientOptions } from '../onebot/reverse-ws-client.js';
import { Probe } from '../probe/probe.js';
import type { ProbeConfig } from '../probe/probe.js';
import { Watchdog } from '../probe/watchdog.js';
import { SendGuard } from '../send-guard.js';
import type { SendGuardConfig } from '../send-guard.js';
import { openSqliteDatabase } from '../storage/database.js';
import type { SqliteDatabase } from '../storage/database.js';
import { EventStore } from '../storage/event-store.js';
import { OutboxDispatcher } from '../storage/outbox-dispatcher.js';
import { SendGuardStore } from '../storage/send-guard-store.js';

export interface CoreRuntimeOptions {
  adapter: AdapterInterface;
  client: Omit<
    ReverseWsClientOptions,
    'selfId' | 'sendGuard' | 'healthProvider' | 'loginProvider' | 'logger'
  >;
  databasePath?: string;
  sendGuard?: Partial<SendGuardConfig>;
  logger?: Logger;
  probe?: Partial<ProbeConfig>;
  enableWatchdog?: boolean;
  replayManifest?: string[];
}

export interface CoreRuntimeStatus {
  clientState: string;
  accountId: number;
  sessionId: string;
  pendingEvents: number;
  replayableEvents: number;
  probe: ReturnType<Probe['snapshot']>;
  sendGuard: ReturnType<SendGuard['snapshot']>;
}

/**
 * Wires an AdapterInterface into the Core pipeline:
 * adapter -> EventSink -> EventStore/Outbox -> ReverseWsClient -> AstrBot.
 */
export class CoreRuntime {
  readonly adapter: AdapterInterface;
  readonly probe: Probe;
  readonly guard: SendGuard;

  private readonly options: CoreRuntimeOptions;
  private readonly logger: Logger;
  private readonly sessionId: string;
  private db: SqliteDatabase | null = null;
  private store: EventStore | null = null;
  private sendGuardStore: SendGuardStore | null = null;
  private client: ReverseWsClient | null = null;
  private watchdog: Watchdog | null = null;
  private started = false;

  constructor(options: CoreRuntimeOptions) {
    this.options = options;
    this.adapter = options.adapter;
    this.logger = options.logger ?? nullLogger;
    this.sessionId = randomUUID();
    this.probe = new Probe(options.probe, { now: Date.now });
    this.guard = new SendGuard(options.sendGuard, { now: Date.now });
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

    const guardStore = new SendGuardStore(db);
    this.sendGuardStore = guardStore;
    this.guard.attachStorage(guardStore);
    this.guard.setHealthProvider(() => this.probe.healthState);
    this.guard.startStopWatchdog();

    const client = new ReverseWsClient({
      ...this.options.client,
      selfId: this.adapter.accountId,
      logger: this.logger,
      sendGuard: this.guard,
      healthProvider: () => this.probe.healthState,
      loginProvider: () => this.probe.adapterLoginState,
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
      let result: AdapterActionResult;
      try {
        result = await this.adapter.execute(action, params, context);
      } catch (error) {
        if (this.guard.isSendAction(action)) {
          this.guard.reportSendFailure();
        }
        throw error;
      }

      if (this.guard.isSendAction(action)) {
        if (result.ok) {
          this.guard.reportSendSuccess();
        } else {
          this.guard.reportSendFailure();
        }
      }

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

    await this.probe.probeOnce(this.adapter);
    this.probe.start(this.adapter);
    client.start();

    if (this.options.enableWatchdog) {
      this.watchdog = new Watchdog();
      this.watchdog.startAutoBeat();
    }

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

    this.probe.stop();
    this.guard.stop();
    this.watchdog?.stop();
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
      probe: this.probe.snapshot(),
      sendGuard: this.guard.snapshot(),
    };
  }

  get clientInstance(): ReverseWsClient | null {
    return this.client;
  }

  get storeInstance(): EventStore | null {
    return this.store;
  }

  get sendGuardStoreInstance(): SendGuardStore | null {
    return this.sendGuardStore;
  }
}
