import { parseReverseWsConfig } from './config.js';
import { createLogger } from './logger.js';
import { ReverseWsClient } from './onebot/reverse-ws-client.js';
import { SendGuard } from './send-guard.js';
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

const groupWhitelist = idListEnv(env('GROUP_WHITELIST'));
const privateWhitelist = idListEnv(env('PRIVATE_WHITELIST'));
const privateEnabled = env('PRIVATE_ENABLED') === '1';
const dailyQuota = numberEnv('DAILY_QUOTA', 200);
const perGroupDailyQuota = numberEnv('PER_GROUP_DAILY_QUOTA', 80);
const minIntervalMs = numberEnv('MIN_INTERVAL_MS', 2_000);
const randomDelayMs = numberEnv('RANDOM_DELAY_MS', 1_500);
const duplicateWindowMs = numberEnv('DUPLICATE_WINDOW_MS', 60_000);
const sendFailureThreshold = numberEnv('SEND_FAILURE_THRESHOLD', 3);
const auditRetentionDays = numberEnv('AUDIT_RETENTION_DAYS', 30);
const stopFile = env('STOP_FILE') ?? 'data/STOP';

const sendGuard = new SendGuard({
  groupWhitelist,
  privateWhitelist,
  privateEnabled,
  dailyQuota,
  perGroupDailyQuota,
  minIntervalMs,
  randomDelayMs,
  duplicateWindowMs,
  sendFailureThreshold,
  auditRetentionDays,
  atOnly: env('AT_ONLY') !== '0',
  stopFile,
});
sendGuard.startStopWatchdog();
logger.info(
  {
    groupWhitelist,
    privateWhitelist,
    privateEnabled,
    dailyQuota,
    perGroupDailyQuota,
    minIntervalMs,
    randomDelayMs,
    duplicateWindowMs,
    sendFailureThreshold,
    auditRetentionDays,
    atOnly: env('AT_ONLY') !== '0',
    stopFile,
  },
  'SendGuard enabled',
);

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
  sendGuard,
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
  sendGuard.stop();
  void client.stop().finally(() => {
    process.exit(0);
  });
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function idListEnv(value: string | undefined): number[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(Number)
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

process.once('SIGINT', () => {
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});
