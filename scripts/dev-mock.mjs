import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

import { WebSocketServer } from 'ws';

import {
  AdminServer,
  CoreRuntime,
  HealthServer,
  createLogger,
} from '../packages/core/dist/index.js';
import { MockAdapter, MockControlServer } from '../packages/adapter-mock/dist/index.js';

function env(name, fallback) {
  return process.env[`LODESTAR_${name}`] ?? process.env[`POLARIS_${name}`] ?? fallback;
}

const accountId = Number(env('SELF_ID') ?? '10001');
const requestedMockAstrbotPort = env('MOCK_ASTRBOT_PORT')
  ? Number(env('MOCK_ASTRBOT_PORT'))
  : undefined;
const requestedHealthPort = env('HEALTH_PORT') ? Number(env('HEALTH_PORT')) : undefined;
const requestedControlPort = env('CONTROL_PORT') ? Number(env('CONTROL_PORT')) : undefined;
const requestedAdminPort = env('ADMIN_PORT') ? Number(env('ADMIN_PORT')) : undefined;
const controlToken = env('CONTROL_TOKEN') || undefined;
const adminHost = env('ADMIN_HOST') ?? '127.0.0.1';
const dataDir = env('DATA_DIR') ?? 'data/demo';
const logger = createLogger({ name: 'lodestar-dev-mock' });

function loadOrCreateAdminToken() {
  const configured = env('ADMIN_TOKEN')?.trim() ?? '';
  if (configured) return configured;

  const tokenFile = env('ADMIN_TOKEN_FILE') ?? resolve(dataDir, 'admin-token');
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // First run: create a persistent local token below.
  }

  const created = randomBytes(24).toString('hex');
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${created}\n`, { mode: 0o600 });
  return created;
}

const adminToken = loadOrCreateAdminToken();

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function isPortAvailable(port, host) {
  const probes = new Set([host, '127.0.0.1', '0.0.0.0']);
  for (const probe of probes) {
    if (!(await isPortFree(port, probe))) return false;
  }
  return true;
}

async function allocatePort(start, host, used) {
  for (let port = start; port < start + 100; port += 1) {
    if (used.has(port)) continue;
    if (await isPortAvailable(port, host)) {
      used.add(port);
      return port;
    }
  }
  throw new Error(`no free port found in range ${start}-${start + 99} on ${host}`);
}

function maybeOpenPanel(url) {
  if (env('NO_OPEN') === '1' || !process.stdout.isTTY) return;
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {});
}

async function main() {
  const usedPorts = new Set();
  const mockAstrbotPort = Number.isInteger(requestedMockAstrbotPort)
    ? requestedMockAstrbotPort
    : await allocatePort(6199, '0.0.0.0', usedPorts);
  usedPorts.add(mockAstrbotPort);
  const healthPort = Number.isInteger(requestedHealthPort)
    ? requestedHealthPort
    : await allocatePort(18080, '0.0.0.0', usedPorts);
  usedPorts.add(healthPort);
  const controlPort = Number.isInteger(requestedControlPort)
    ? requestedControlPort
    : await allocatePort(18090, '0.0.0.0', usedPorts);
  usedPorts.add(controlPort);
  const adminPort = Number.isInteger(requestedAdminPort)
    ? requestedAdminPort
    : await allocatePort(18081, adminHost, usedPorts);
  usedPorts.add(adminPort);
  const onebotUrl = env('ONEBOT_URL') ?? `ws://127.0.0.1:${mockAstrbotPort}/ws`;

  // A tiny AstrBot-compatible reverse WS endpoint for local demo validation.
  const astrbot = new WebSocketServer({
    host: '0.0.0.0',
    port: mockAstrbotPort,
    path: '/ws',
  });
  astrbot.on('connection', (socket, request) => {
    logger.info(
      { selfId: request.headers['x-self-id'], role: request.headers['x-client-role'] },
      'mock AstrBot connected',
    );
    socket.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.post_type === 'message') {
          logger.info({ rawMessage: payload.raw_message }, 'mock AstrBot received message');
        }
      } catch {
        // ignore
      }
    });
  });

  const adapter = new MockAdapter({ accountId });
  const control = new MockControlServer(adapter, {
    host: '0.0.0.0',
    port: controlPort,
    ...(controlToken === undefined ? {} : { token: controlToken }),
  });
  await control.start();

  const runtime = new CoreRuntime({
    adapter,
    client: {
      url: onebotUrl,
      reconnect: { enabled: true },
      heartbeat: { enabled: true },
    },
    databasePath: env('DB_PATH') ?? resolve(dataDir, 'demo.db'),
    sendGuard: {
      stopFile: env('STOP_FILE') ?? resolve(dataDir, 'STOP'),
      privateEnabled: true,
      atOnly: false,
      quietHours: null,
    },
    logger,
  });
  await runtime.start();

  const health = new HealthServer({
    getStatus: () => runtime.status(),
    host: '0.0.0.0',
    port: healthPort,
  });
  await health.start();

  const admin = new AdminServer({
    runtime,
    token: adminToken,
    tokenFile: env('ADMIN_TOKEN_FILE') ?? resolve(dataDir, 'admin-token'),
    host: adminHost,
    port: adminPort,
    allowNonLoopback: env('ADMIN_ALLOW_NON_LOOPBACK') === '1',
    configPath: env('SEND_GUARD_CONFIG') ?? resolve(dataDir, 'demo-send-guard.json'),
    protocolConfigPath: env('PROTOCOL_CONFIG') ?? resolve(dataDir, 'demo-upstream.json'),
    demo: true,
    webRoot: env('WEB_ROOT') ?? 'packages/web/dist',
    shutdown: () => shutdown('admin'),
    logger,
  });
  await admin.start();

  const panelUrl = `http://${adminHost === '0.0.0.0' ? '127.0.0.1' : adminHost}:${adminPort}`;
  logger.info(
    {
      health: `http://127.0.0.1:${healthPort}`,
      control: control.url,
      panel: panelUrl,
      mockAstrBot: `ws://127.0.0.1:${mockAstrbotPort}/ws`,
      accountId,
    },
    'dev-mock ready',
  );
  console.log(
    [
      '',
      'Lodestar demo is running',
      `  Panel:    ${panelUrl}`,
      `  Token:    ${adminToken}`,
      `  Health:   http://127.0.0.1:${healthPort}`,
      `  Control:  ${control.url}`,
      `  Mock bot: ws://127.0.0.1:${mockAstrbotPort}/ws`,
      '',
    ].join('\n'),
  );
  maybeOpenPanel(panelUrl);

  let stopping = false;

  async function shutdown(signal) {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, 'dev-mock shutting down');
    await admin.stop();
    await health.stop();
    await control.stop();
    await runtime.stop();
    await new Promise((resolve) => {
      astrbot.close(() => {
        resolve();
      });
    });
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main().catch((error) => {
  logger.error({ err: error }, 'dev-mock failed');
  process.exit(1);
});
