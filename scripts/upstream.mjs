import { readFileSync } from 'node:fs';

import {
  AdminServer,
  CoreRuntime,
  HealthServer,
  createLogger,
} from '../packages/core/dist/index.js';
import { OneBotUpstreamAdapter } from '../packages/adapter-onebot-upstream/dist/index.js';

const configPath =
  process.env.LODESTAR_UPSTREAM_CONFIG ??
  process.env.POLARIS_UPSTREAM_CONFIG ??
  'config/upstream.json';
const logger = createLogger({ name: 'polaris-upstream' });

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  logger.error(
    { configPath, err: error instanceof Error ? error.message : String(error) },
    'cannot read upstream config; copy config/upstream.example.json to config/upstream.json',
  );
  process.exit(2);
}

function readSendGuardConfig(nextConfig) {
  const sendGuardPath = nextConfig.admin?.configPath ?? 'config/send-guard.json';
  try {
    const parsed = JSON.parse(readFileSync(sendGuardPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall back to the bootstrap config if the admin file is not readable.
  }
  return {};
}

function createRuntime(nextConfig) {
  const adapter = new OneBotUpstreamAdapter({
    url: nextConfig.upstream.url,
    selfId: nextConfig.selfId,
    ...(nextConfig.upstream.token ? { accessToken: nextConfig.upstream.token } : {}),
    logger,
  });
  const guardFile = readSendGuardConfig(nextConfig);

  return new CoreRuntime({
    adapter,
    client: {
      url: nextConfig.astrbot.url,
      ...(nextConfig.astrbot.token ? { accessToken: nextConfig.astrbot.token } : {}),
      reconnect: { enabled: true },
      heartbeat: { enabled: true },
    },
    databasePath: nextConfig.databasePath ?? 'data/polaris.db',
    sendGuard: {
      ...(nextConfig.sendGuard ?? {}),
      ...guardFile,
      stopFile: guardFile.stopFile ?? nextConfig.sendGuard?.stopFile ?? 'data/STOP',
    },
    logger,
  });
}

async function main() {
  let runtime = createRuntime(config);
  await runtime.start();

  let restartPromise = null;
  async function restartRuntime() {
    if (restartPromise) return restartPromise;

    restartPromise = (async () => {
      const nextConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      const previousConfig = config;
      const nextRuntime = createRuntime(nextConfig);

      await runtime.stop();
      runtime = nextRuntime;
      try {
        await runtime.start();
        config = nextConfig;
        logger.info(
          {
            astrbot: nextConfig.astrbot.url,
            upstream: nextConfig.upstream.url,
          },
          'core runtime restarted',
        );
        return { restartedAt: new Date().toISOString() };
      } catch (error) {
        logger.error({ err: error }, 'core runtime restart failed; rolling back');
        try {
          runtime = createRuntime(previousConfig);
          await runtime.start();
          config = previousConfig;
          logger.warn('core runtime rolled back to the previous configuration');
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, 'core runtime rollback failed');
        }
        throw error;
      }
    })();

    try {
      return await restartPromise;
    } finally {
      restartPromise = null;
    }
  }

  const adminRuntime = {
    status: () => runtime.status(),
    adapter: { health: () => runtime.adapter.health() },
    get guard() {
      return runtime.guard;
    },
    get sendGuardStoreInstance() {
      return runtime.sendGuardStoreInstance;
    },
    restart: restartRuntime,
  };

  const health = new HealthServer({
    getStatus: () => runtime.status(),
    host: config.health?.host ?? '127.0.0.1',
    port: config.health?.port ?? 18080,
  });
  await health.start();

  let admin = null;
  if (config.admin?.enabled !== false) {
    admin = new AdminServer({
      runtime: adminRuntime,
      ...(() => {
        const adminToken =
          process.env.LODESTAR_ADMIN_TOKEN ??
          process.env.POLARIS_ADMIN_TOKEN ??
          config.admin?.token;
        return adminToken ? { token: adminToken } : {};
      })(),
      host: config.admin?.host ?? '127.0.0.1',
      port: config.admin?.port ?? 18081,
      configPath: config.admin?.configPath ?? 'config/send-guard.json',
      protocolConfigPath: config.admin?.protocolConfigPath ?? configPath,
      webRoot: config.admin?.webRoot ?? 'packages/web/dist',
      shutdown: () => shutdown('admin'),
      logger,
    });
    await admin.start();
  }

  logger.info(
    {
      health: `http://${config.health?.host ?? '127.0.0.1'}:${config.health?.port ?? 18080}`,
      admin: admin?.url,
      astrbot: config.astrbot.url,
      upstream: config.upstream.url,
      accountId: config.selfId,
    },
    'upstream runtime ready',
  );

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'upstream runtime shutting down');
    await admin?.stop();
    await health.stop();
    await runtime.stop();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error) => {
  logger.error({ err: error }, 'upstream runtime failed to start');
  process.exit(1);
});
