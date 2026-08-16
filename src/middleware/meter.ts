// Wraps the route handler: times it, writes one `requests` row always, and a
// debug body only when asked. Registered last of the shared middleware (see
// server/server.ts), so by the time this runs, auth has already put a real
// `client`/`tier` on the context — a 401/402 never reaches here, and
// deliberately gets no row (see src/middleware/budget.ts).
import { Buffer } from 'node:buffer';
import type { Database } from 'bun:sqlite';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createMiddleware } from 'hono/factory';
import { bumpDailySpend, insertRequest } from '../db.ts';
import { computeCost, extractUsage } from '../pricing.ts';
import { toErrorResponse } from '../upstream.ts';
import { ZERO_USAGE, type AppEnv, type PriceTable, type Usage } from '../types.ts';

export interface MeterDeps {
  db: Database;
  priceTable: PriceTable;
  bodiesDir: string;
}

function toBase64(buf: ArrayBuffer | Buffer): string {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
}

function daysBefore(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure so it's directly unit-testable: which body-log filenames are past
 * retention. "Keep the last N days" means N calendar days INCLUDING today —
 * retentionDays=3 on 08-16 keeps {08-16, 08-15, 08-14} and drops 08-13 and
 * earlier — so the cutoff is (retentionDays - 1) days back, floored at 0 so
 * today is never pruned even when retentionDays is 0.
 */
export function staleBodyFiles(files: readonly string[], today: string, retentionDays: number): string[] {
  const cutoff = daysBefore(today, Math.max(retentionDays - 1, 0));
  return files.filter((f) => {
    const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1];
    return day !== undefined && day < cutoff;
  });
}

/** Called once at startup (server/server.ts) — a personal single-tenant tool
 * restarted by launchd periodically doesn't need a cron for this. */
export function pruneOldBodies(bodiesDir: string, retentionDays: number, today = new Date().toISOString().slice(0, 10)): string[] {
  let entries: string[];
  try {
    entries = readdirSync(bodiesDir);
  } catch {
    return [];
  }
  const stale = staleBodyFiles(entries, today, retentionDays);
  for (const file of stale) {
    try {
      unlinkSync(path.join(bodiesDir, file));
    } catch {
      /* already gone */
    }
  }
  return stale;
}

interface DebugEntry {
  ts: string;
  requestId: string;
  client: string;
  tier: string;
  surface: string;
  upstream: string;
  model: string | null;
  status: number;
  requestBody: string | null;
  responseBody: string | null;
}

function writeDebugEntry(bodiesDir: string, entry: DebugEntry): void {
  mkdirSync(bodiesDir, { recursive: true });
  const file = path.join(bodiesDir, `${entry.ts.slice(0, 10)}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + '\n');
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort — chmod failing must never fail the request */
  }
}

export function createMeterMiddleware({ db, priceTable, bodiesDir }: MeterDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const t0 = Date.now();
    try {
      await next();
    } catch (err) {
      // Defensive only: every route is expected to catch its own errors via
      // toErrorResponse() (see src/routes/*.ts) so this should not normally
      // trigger — kept as a backstop against a future route that forgets to.
      c.res = toErrorResponse(err);
    }

    const res = c.res;
    const latencyMs = Date.now() - t0;
    const client = c.get('client');
    const tier = c.get('tier');
    const surface = c.get('surface');
    const upstream = c.get('upstream');
    const routedModel = c.get('model');
    const requestedModel = c.get('requestedModel');
    const fellBack = c.get('fellBack');
    const queueWaitMs = c.get('queueWaitMs');
    const preempted = c.get('preempted');
    const requestId = c.get('requestId');
    const debugRequestBody = c.get('debugRequestBody');
    const debugOn = client.debug || c.req.header('x-salik-debug') === '1';
    const ts = new Date().toISOString();

    const finish = (usage: Usage, model: string | null, costUsd: number | null, responseRaw: Buffer | null): void => {
      insertRequest(db, {
        ts,
        client: client.name,
        tier,
        surface,
        upstream,
        model,
        requestedModel,
        status: res.status,
        latencyMs,
        queueWaitMs,
        preempted,
        fellBack,
        usage,
        costUsd,
      });
      // !== null, not truthy: a genuinely free local model prices at exactly
      // 0, and that must still land a $0 daily_spend row so /api/salik/status
      // lists the client rather than omitting it entirely (see tests/status.test.ts).
      if (costUsd !== null) bumpDailySpend(db, client.name, ts.slice(0, 10), costUsd);

      console.log(
        `${ts} [${requestId}] ${client.name}/${tier} ${surface}->${upstream} model=${model ?? '-'} ` +
          `status=${res.status} latency=${latencyMs}ms queue=${queueWaitMs}ms` +
          `${preempted ? ' PREEMPTED' : ''}${fellBack ? ' FALLBACK' : ''} cost=${costUsd !== null ? `$${costUsd.toFixed(6)}` : 'n/a'}`,
      );

      if (debugOn) {
        writeDebugEntry(bodiesDir, {
          ts,
          requestId,
          client: client.name,
          tier,
          surface,
          upstream,
          model,
          status: res.status,
          requestBody: debugRequestBody ? toBase64(debugRequestBody) : null,
          responseBody: responseRaw ? toBase64(responseRaw) : null,
        });
      }
    };

    if (!res.body) {
      finish(ZERO_USAGE, routedModel, null, null);
      return;
    }

    const [clientStream, meterStream] = res.body.tee();
    c.res = new Response(clientStream, res);

    // Fire-and-forget: consuming the tee'd branch must never delay the
    // response already handed to the client above, and a metering failure
    // must never surface as a request failure.
    void (async () => {
      try {
        const raw = Buffer.from(await new Response(meterStream).arrayBuffer());
        const extracted = extractUsage(surface, raw);
        const model = routedModel ?? extracted.model;
        const usage: Usage = {
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          cacheReadTokens: extracted.cacheReadTokens,
          cacheWriteTokens: extracted.cacheWriteTokens,
        };
        const costUsd = computeCost(priceTable, model, usage);
        finish(usage, model, costUsd, raw);
      } catch (e) {
        console.error(`${new Date().toISOString()} [${requestId}] meter failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  });
}
