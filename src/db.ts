// bun:sqlite schema + migrations. Two tables: `requests` (one row per call,
// forever) and `daily_spend` (one row per client per day, the running total
// `middleware/budget.ts` checks against).
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RequestRow } from './types.ts';

export function openDb(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  // WAL: the server handles many requests concurrently (cloud upstreams
  // parallelise), so a writer must not block readers hitting /api/salik/status.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an already-existing
 * on-disk table, so it won't retroactively add a column to someone's live
 * data/salik.db — this fills that gap for columns added after the table
 * already shipped.
 */
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                 TEXT NOT NULL,
      client             TEXT NOT NULL,
      tier               TEXT NOT NULL,
      surface            TEXT NOT NULL,
      upstream           TEXT NOT NULL,
      model              TEXT,
      status             INTEGER NOT NULL,
      latency_ms         INTEGER NOT NULL,
      queue_wait_ms      INTEGER NOT NULL DEFAULT 0,
      preempted          INTEGER NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL
    );
    CREATE INDEX IF NOT EXISTS idx_requests_client_ts ON requests(client, ts);
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);

    CREATE TABLE IF NOT EXISTS daily_spend (
      client   TEXT NOT NULL,
      date     TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (client, date)
    );
  `);

  // requested_model/fell_back: added after the table shipped — see
  // src/dispatch.ts. requested_model is the client's own `model` field
  // before any fallback resolution; model keeps meaning "the real upstream
  // string that answered". Always in lockstep on the three native
  // passthrough routes, which never fall back.
  addColumnIfMissing(db, 'requests', 'requested_model', 'TEXT');
  addColumnIfMissing(db, 'requests', 'fell_back', 'INTEGER NOT NULL DEFAULT 0');
}

export function insertRequest(db: Database, row: RequestRow): void {
  db.query(`
    INSERT INTO requests (
      ts, client, tier, surface, upstream, model, requested_model, status, latency_ms, queue_wait_ms,
      preempted, fell_back, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ts,
    row.client,
    row.tier,
    row.surface,
    row.upstream,
    row.model,
    row.requestedModel,
    row.status,
    row.latencyMs,
    row.queueWaitMs,
    row.preempted ? 1 : 0,
    row.fellBack ? 1 : 0,
    row.usage.inputTokens,
    row.usage.outputTokens,
    row.usage.cacheReadTokens,
    row.usage.cacheWriteTokens,
    row.costUsd,
  );
}

export function bumpDailySpend(db: Database, client: string, date: string, costUsd: number): void {
  db.query(`
    INSERT INTO daily_spend (client, date, cost_usd) VALUES (?, ?, ?)
    ON CONFLICT(client, date) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd
  `).run(client, date, costUsd);
}

interface DailySpendRow {
  cost_usd: number;
}

export function spendToday(db: Database, client: string, date: string): number {
  const row = db
    .query<DailySpendRow, [string, string]>('SELECT cost_usd FROM daily_spend WHERE client = ? AND date = ?')
    .get(client, date);
  return row?.cost_usd ?? 0;
}

export interface ClientSpendRow {
  client: string;
  cost_usd: number;
}

export function spendByClientToday(db: Database, date: string): ClientSpendRow[] {
  return db
    .query<ClientSpendRow, [string]>('SELECT client, cost_usd FROM daily_spend WHERE date = ? ORDER BY cost_usd DESC')
    .all(date);
}

export interface RequestCountRow {
  count: number;
}

export function requestCountToday(db: Database, dateIsoPrefix: string): number {
  const row = db
    .query<RequestCountRow, [string]>(`SELECT COUNT(*) as count FROM requests WHERE ts LIKE ? || '%'`)
    .get(dateIsoPrefix);
  return row?.count ?? 0;
}
