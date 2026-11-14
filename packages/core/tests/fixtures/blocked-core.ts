import { Watchdog } from '../../src/probe/watchdog.js';

const watchdog = new Watchdog({ timeoutMs: 200, intervalMs: 50 });
watchdog.startAutoBeat(50);

const startedAt = Date.now();
while (Date.now() - startedAt < 2_000) {
  // Intentionally block the event loop; the worker should kill the process.
}

watchdog.stop();
process.exit(0);
