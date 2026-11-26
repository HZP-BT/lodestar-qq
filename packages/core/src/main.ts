import { parseReverseWsConfig } from './config.js';
import { createLogger } from './logger.js';
import { ReverseWsClient } from './onebot/reverse-ws-client.js';
import { detectNodeSqlite } from './storage/detect-node-sqlite.js';
import { PROTOCOL_VERSION, VERSION } from './version.js';

const logger = createLogger({ name: 'lodestar-core' });
const sqlite = detectNodeSqlite();

if (sqlite.available) {
  logger.debug(
    { nodeVersion: sqlite.nodeVersion, abi: sqlite.abi },
    'node:sqlite feature detection passed',
  );
} else {
  logger.error(
    { ...sqlite },
    'node:sqlite is unavailable; storage features will fail. Use an official Node.js build or Docker image, or switch to the better-sqlite3 driver.',
  );
}

function env(name: string): string | undefined {
  return process.env[`LODESTAR_${name}`] ?? process.env[`POLARIS_${name}`];
}

const token = env('ONEBOT_TOKEN');

const config = parseReverseWsConfig({
  url: env('ONEBOT_URL') ?? 'ws://127.0.0.1:6199/ws',
  selfId: env('SELF_ID') ?? '0',
  ...(token ? { accessToken: token } : {}),
});

if (config.selfId === 0) {
  logger.warn(
    'LODESTAR_SELF_ID is not set; using 0. AstrBot may route actions to the wrong account.',
  );
}

const client = new ReverseWsClient({
  url: config.url,
  selfId: config.selfId,
  ...(config.accessToken ? { accessToken: config.accessToken } : {}),
  tokenScheme: config.tokenScheme,
  tokenPlacement: config.tokenPlacement,
  clientRole: config.clientRole,
  reconnect: config.reconnect,
  heartbeat: config.heartbeat,
  maxConcurrentActions: config.maxConcurrentActions,
  actionTimeoutMs: config.actionTimeoutMs,
  logger,
});

// Minimal smoke-test actions. Real account data comes from the adapter in M1.2+.
client.registerAction('get_login_info', () => ({
  user_id: config.selfId,
  nickname: 'Lodestar (M1 skeleton)',
}));
client.registerAction('get_version_info', () => ({
  app_name: 'lodestar-qq',
  app_version: VERSION,
  protocol_version: PROTOCOL_VERSION,
}));
client.registerAction('get_status', () => {
  const health = client.heartbeatStatus;
  return {
    online: health.online,
    good: health.good,
  };
});

client.onOpen(({ selfId }) => {
  logger.info({ selfId }, 'reverse WS ready; waiting for AstrBot actions');
});
client.onClose(({ code, reason, willReconnect }) => {
  logger.warn({ code, reason, willReconnect }, 'reverse WS closed');
});
client.onError((error) => {
  logger.error({ err: error }, 'reverse WS error');
});
client.onReconnecting(({ attempt, delayMs }) => {
  logger.info({ attempt, delayMs }, 'reverse WS reconnect scheduled');
});
client.onAuthFailure((info) => {
  logger.error(
    { ...info },
    'authentication/handshake failed; fix the URL/token and restart, or call resume() after updating the token',
  );
});
client.onEvent((event) => {
  logger.info({ event }, 'OneBot event received');
});

client.start();

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  void client.stop().finally(() => {
    process.exit(0);
  });
}

process.once('SIGINT', () => {
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});
