/*
 * Minimal self-loader spike for NTQQ (local-only).
 *
 * It does not depend on LiteLoaderQQNT. The installed package.json "main" points
 * here; this file:
 *   1. writes a startup marker,
 *   2. loads QQ's original application.asar entry,
 *   3. waits for the nt_1 session and starts the minimal OneBot WS adapter.
 *
 * The OneBot adapter binds 127.0.0.1 only, supports text sends, and never reads
 * credentials. It is a spike, not a production adapter.
 */
const fs = require('fs');
const path = require('path');

const logPath = `D:\\qq-loader\\self-loader-${process.pid}.jsonl`;

function log(entry) {
  try {
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        type: process.type,
        ...entry,
      }) + '\n',
    );
  } catch {}
}

function readConfig() {
  const configPath = 'D:\\qq-loader\\onebot-config.json';
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {
      selfId: 0,
      host: '127.0.0.1',
      port: 3001,
      accessToken: '',
      nickname: 'polaris',
    };
  }
}

fs.writeFileSync(logPath, '');
log({
  kind: 'loader_start',
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
  },
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
  hasTypeArg: process.argv.some((arg) => arg.startsWith('--type=')),
});

process.on('uncaughtException', (error) => {
  log({
    kind: 'uncaught',
    error: String(error && error.stack ? error.stack : error),
  });
});
process.on('unhandledRejection', (error) => {
  log({
    kind: 'unhandled',
    error: error && error.stack ? error.stack : String(error),
  });
});

let wrapper = null;
try {
  wrapper = require(path.join(process.resourcesPath, 'app', 'wrapper.node'));
  log({ kind: 'wrapper_loaded' });
} catch (error) {
  log({
    kind: 'wrapper_error',
    error: String(error && error.stack ? error.stack : error),
  });
}

const isMainProcess =
  path.basename(process.execPath).toLowerCase() === 'qq.exe' &&
  !process.argv.some((arg) => arg.startsWith('--type='));

let attached = false;
let attempts = 0;
let onebot = null;
process.on('exit', () => {
  onebot?.close();
});

function tryAttach() {
  if (attached || !wrapper) return;
  attempts += 1;
  try {
    const session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
    if (!session) {
      log({ kind: 'attach_wait', attempts });
      return;
    }
    const service = session.getMsgService();
    if (!service) {
      log({ kind: 'attach_wait_service', attempts });
      return;
    }
    const config = readConfig();
    try {
      const { startOneBot } = require(path.join(__dirname, 'onebot.js'));
      onebot = startOneBot({
        service,
        config,
        selfId: Number(config.selfId) || 0,
        nickname: config.nickname || 'polaris',
      });
      log({
        kind: 'onebot_started',
        port: Number(config.port) || 3001,
        selfId: Number(config.selfId) || 0,
      });
    } catch (error) {
      log({
        kind: 'onebot_error',
        error: String(error && error.stack ? error.stack : error),
      });
    }
    attached = true;
    log({ kind: 'attached', attempts });
  } catch (error) {
    log({
      kind: 'attach_error',
      attempts,
      error: String(error && error.stack ? error.stack : error),
    });
  }
}

if (isMainProcess) {
  const timer = setInterval(() => {
    if (attached || attempts >= 300) {
      clearInterval(timer);
      return;
    }
    tryAttach();
  }, 1000);

  setTimeout(tryAttach, 3000);
  log({ kind: 'attach_enabled' });
} else {
  log({ kind: 'attach_skip', reason: 'not-main' });
}

const original = path.join(
  process.resourcesPath,
  'app',
  './application.asar/app_launcher/index.js',
);
log({ kind: 'original_require', path: original });

try {
  require(original);
  log({ kind: 'original_returned' });
} catch (error) {
  log({
    kind: 'original_error',
    error: String(error && error.stack ? error.stack : error),
  });
}
