// Salik's own introspection surface: queue depth, current holder, today's
// spend, per-client totals. Mounted with auth only (see src/app.ts) — no
// budget gate (checking status must still work when over budget) and no
// meter row (this isn't a billable model call).
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { hourlyUsage, requestCountToday, spendByClientToday } from '../db.ts';
import type { AppEnv } from '../context.ts';
import { salikErrorBody } from '../errors.ts';
import type { OllamaQueue } from '../queue.ts';
import { formatOffset, parseTzOffsetMinutes, since, sumTotals, totalsOf } from '../usage.ts';

/** A day of hours is the useful default; a week is the most anyone reads on one screen. */
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 31;

export interface StatusRouteDeps {
  queue: OllamaQueue;
  db: Database;
}

export function createStatusRoutes({ queue, db }: StatusRouteDeps) {
  const app = new Hono<AppEnv>();

  app.get('/api/salik/status', (c) => {
    const today = new Date().toISOString().slice(0, 10);
    const byClient = spendByClientToday(db, today);

    return c.json({
      queue: queue.status(),
      today,
      spend: {
        totalUsd: byClient.reduce((sum, row) => sum + row.cost_usd, 0),
        byClient: Object.fromEntries(byClient.map((row) => [row.client, row.cost_usd])),
      },
      requestsToday: requestCountToday(db, today),
    });
  });

  /**
   * Tokens, by hour. Mounted alongside status and for the same reasons: auth
   * only, no budget gate (a report you can't read once you're over your cap is
   * a report you can't use to find out why), no meter row (reading the ledger
   * is not a model call, and metering it would make the ledger a record of
   * itself).
   *
   * Buckets are UTC unless `tz` says otherwise, and every response states the
   * offset it used — an hourly figure whose zone is a guess is worse than no
   * figure, because it looks right.
   */
  app.get('/api/salik/usage', (c) => {
    const hoursRaw = c.req.query('hours');
    const hours = hoursRaw === undefined ? DEFAULT_HOURS : Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
      return Response.json(
        salikErrorBody('salik_invalid_request', `"hours" must be a number between 1 and ${MAX_HOURS}`),
        { status: 400 },
      );
    }

    const offsetMinutes = parseTzOffsetMinutes(c.req.query('tz') ?? null);
    if (offsetMinutes === null) {
      return Response.json(
        salikErrorBody('salik_invalid_request', '"tz" must be utc, local, ±HH:MM, or minutes east of UTC'),
        { status: 400 },
      );
    }

    const client = c.req.query('client');
    const byClient = c.req.query('by') === 'client';
    const from = since(hours);
    const buckets = hourlyUsage(db, { since: from, client, offsetMinutes, byClient });

    return c.json({
      window: { hours, since: from, tz: formatOffset(offsetMinutes), offsetMinutes },
      client: client ?? null,
      groupedBy: byClient ? ['hour', 'client'] : ['hour'],
      // Newest hour first, and hours with no traffic are absent rather than
      // zero-filled — see hourlyUsage().
      buckets: buckets.map((b) => ({ hour: b.hour, client: b.client, ...totalsOf(b) })),
      totals: sumTotals(buckets),
    });
  });

  return app;
}
