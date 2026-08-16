// Salik's own introspection surface: queue depth, current holder, today's
// spend, per-client totals. Mounted with auth only (see server/server.ts) —
// no budget gate (checking status must still work when over budget) and no
// meter row (this isn't a billable model call).
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { requestCountToday, spendByClientToday } from '../db.ts';
import type { OllamaQueue } from '../queue.ts';
import type { AppEnv } from '../types.ts';

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

  return app;
}
