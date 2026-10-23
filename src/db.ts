// bun:sqlite schema + migrations. Two tables: `requests` (one row per call,
// forever) and `daily_spend` (one row per client per day, the running total
// `middleware/budget.ts` checks against).
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RequestRow } from './wire.ts';

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

// ------------------------------------------------------------------ usage
//
// Token accounting, read straight off the `requests` ledger rather than from a
// rollup table. `daily_spend` exists because src/middleware/budget.ts has to
// answer "am I over?" on the hot path of every request; nothing is on the hot
// path here, and a pre-aggregated hourly table would be a second source of
// truth to keep honest for no gain — SQLite groups 100k rows of this in
// milliseconds, and idx_requests_ts already covers the window scan.

/** One hour of the ledger. `client` is null when the rows weren't split by client. */
export interface UsageBucket {
  /** 'YYYY-MM-DDTHH:00', in whatever zone the caller asked for — NOT necessarily UTC. */
  hour: string;
  client: string | null;
  requests: number;
  /** Prompt tokens the upstream actually read fresh. */
  inputTokens: number;
  /** Prompt tokens served from the upstream's cache. Disjoint from inputTokens — see src/pricing.ts. */
  cacheReadTokens: number;
  /** Prompt tokens written INTO the cache (Anthropic only; OpenAI reports none). */
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface HourlyUsageOptions {
  /** Oldest timestamp to include, as a full UTC ISO string. Compared lexicographically against `ts`. */
  since: string;
  /** Only this client, or every client when omitted. */
  client?: string | undefined;
  /** Shifts the hour boundaries off UTC — 240 buckets a Dubai day, -300 a New York one. */
  offsetMinutes?: number;
  /** One row per (hour, client) instead of one row per hour. */
  byClient?: boolean;
}

interface UsageRow {
  hour: string;
  client: string | null;
  requests: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * Hourly token and cost totals, newest hour first.
 *
 * Two things this deliberately does NOT do. It doesn't invent empty rows for
 * hours with no traffic — an hour that isn't there is an hour nothing ran in,
 * and a caller drawing a chart can fill the gaps knowing that. And it doesn't
 * fold cache reads into `inputTokens`: they're disjoint counts (src/pricing.ts
 * backs OpenAI's cached tokens out of prompt_tokens so they can be priced
 * differently), so the sum is the caller's to make, out in the open.
 */
export function hourlyUsage(db: Database, opts: HourlyUsageOptions): UsageBucket[] {
  const { since, client, offsetMinutes = 0, byClient = false } = opts;
  // Bound as a parameter, never interpolated: an offset is a number from a
  // query string, and SQLite modifiers are strings.
  const modifier = `${offsetMinutes >= 0 ? '+' : '-'}${Math.abs(Math.trunc(offsetMinutes))} minutes`;
  const clientColumn = byClient ? 'client' : 'NULL AS client';
  const groupBy = byClient ? 'hour, client' : 'hour';

  const rows = db
    .query<UsageRow, [string, string, string | null, string | null]>(`
      SELECT strftime('%Y-%m-%dT%H:00', ts, ?) AS hour,
             ${clientColumn},
             COUNT(*)                        AS requests,
             SUM(input_tokens)               AS input_tokens,
             SUM(cache_read_tokens)          AS cache_read_tokens,
             SUM(cache_write_tokens)         AS cache_write_tokens,
             SUM(output_tokens)              AS output_tokens,
             SUM(COALESCE(cost_usd, 0))      AS cost_usd
      FROM requests
      WHERE ts >= ?
        AND (? IS NULL OR client = ?)
      GROUP BY ${groupBy}
      ORDER BY hour DESC${byClient ? ', client ASC' : ''}
    `)
    .all(modifier, since, client ?? null, client ?? null);

  return rows.map((r) => ({
    hour: r.hour,
    client: r.client,
    requests: r.requests,
    inputTokens: r.input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
  }));
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
