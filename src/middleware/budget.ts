// Daily cap enforcement. Runs after auth, so c.get('client') is real. A
// request rejected here never used any tokens, so — deliberately — it gets
// no src/middleware/meter.ts row: there is nothing to meter, only hono/logger's
// plain HTTP line.
import { createMiddleware } from 'hono/factory';
import type { Database } from 'bun:sqlite';
import type { AppEnv } from '../context.ts';
import { salikErrorBody } from '../errors.ts';
import { spendToday } from '../db.ts';

export function createBudgetMiddleware(db: Database) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const client = c.get('client');
    const today = new Date().toISOString().slice(0, 10);
    const spent = spendToday(db, client.name, today);

    if (spent >= client.dailyBudgetUsd) {
      return Response.json(
        salikErrorBody(
          'salik_budget_exceeded',
          `daily budget of $${client.dailyBudgetUsd.toFixed(2)} exceeded ($${spent.toFixed(2)} spent today)`,
        ),
        { status: 402 },
      );
    }

    await next();
  });
}
