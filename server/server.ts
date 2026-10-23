// Entry point: load config, open the db, wire the Hono app, serve. Always run
// directly (`bun server/server.ts`) — never imported, so there's no
// import.meta.url self-invocation guard to worry about; tests build their own
// throwaway Hono apps straight from src/routes instead of importing this file.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from 'hono/logger';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { pruneOldBodies } from '../src/middleware/meter.ts';
import { OllamaQueue } from '../src/queue.ts';
import { parseKeysFile, parseModelRegistry, parsePriceTable, parseSettings } from '../src/config.ts';

const ROOT = process.cwd();
const resolve = (p: string) => path.resolve(ROOT, p);

function loadJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(relPath), 'utf8'));
}

const settings = parseSettings(loadJson('config/settings.json'), 'config/settings.json');
const priceTable = parsePriceTable(loadJson('config/pricing.json'), 'config/pricing.json');
const modelRegistry = parseModelRegistry(loadJson('config/models.json'), 'config/models.json');

const keysPath = resolve('config/keys.json');
if (!existsSync(keysPath)) {
  console.error(`missing ${keysPath} — copy config/keys.json.example to config/keys.json and fill it in`);
  process.exit(1);
}
const keys = parseKeysFile(loadJson('config/keys.json'), 'config/keys.json');

// ---- pidfile: a stray manual run exits instead of competing with the
// launchd copy for the one Ollama slot. Mirrors trip-agent's src/gate.mjs
// claimPidFile(), which this replaces the need for entirely.
function claimPidFile(lockPath: string): boolean {
  try {
    const existingPid = Number(readFileSync(lockPath, 'utf8'));
    try {
      process.kill(existingPid, 0);
      return false; // still alive
    } catch {
      /* stale — fall through and claim it */
    }
  } catch {
    /* no pidfile yet */
  }
  writeFileSync(lockPath, String(process.pid));
  const release = (): void => {
    try {
      if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    // Registering a signal listener replaces Node/Bun's default
    // terminate-on-signal behaviour, so this must exit explicitly — without
    // it, `launchctl bootout` would be silently ignored and the old process
    // would linger, holding the pidfile the new one needs.
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
  return true;
}

const lockFile = resolve('data/salik.lock');
mkdirSync(path.dirname(lockFile), { recursive: true });
if (!claimPidFile(lockFile)) {
  console.error('another salik is already running (pidfile held by a live process) — exiting');
  process.exit(1);
}

const db = openDb(resolve(settings.dbPath));

const bodiesDir = resolve(settings.bodiesDir);
mkdirSync(bodiesDir, { recursive: true });
const pruned = pruneOldBodies(bodiesDir, settings.bodyRetentionDays);
if (pruned.length) console.log(`pruned ${pruned.length} body log(s) past ${settings.bodyRetentionDays}d retention`);

const queue = new OllamaQueue();

// hono/logger's own output has no wall-clock prefix; PLAN.md calls for a
// timestamped line, so supply a print function that adds one.
const timestampedLogger = logger((message: string, ...rest: string[]) => {
  console.log(new Date().toISOString(), message, ...rest);
});

const app = createApp({
  db,
  clients: keys.clients,
  priceTable,
  modelRegistry,
  bodiesDir,
  queue,
  ollama: settings.upstreams.ollama,
  anthropic: {
    url: settings.upstreams.anthropic.url,
    timeoutMs: settings.upstreams.anthropic.timeoutMs,
    apiKey: keys.upstreamKeys.anthropic,
    defaultVersion: settings.upstreams.anthropic.defaultVersion,
  },
  openai: { ...settings.upstreams.openai, apiKey: keys.upstreamKeys.openai },
  requestLogger: timestampedLogger,
});

const server = Bun.serve({
  port: settings.port,
  hostname: settings.host,
  fetch: app.fetch,
});

console.log(new Date().toISOString(), `salik listening on http://${settings.host}:${server.port} (pid ${process.pid})`);
