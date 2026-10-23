// The Hono app assembly: which paths get auth/budget/meter, and how the
// per-surface routes share one OllamaQueue. Used by both server/server.ts and
// tests/build-app.ts so the two can never drift apart — which is exactly how
// a middleware-scoping bug slipped in during development: two hand-wired
// copies disagreed about how Hono scopes middleware registered on a sub-app
// mounted at the same path prefix as a sibling sub-app (it doesn't scope at
// all — a `'*'` middleware on either leaks onto the other's routes, since
// `.route()` merges both into one shared underlying route table). Scoping
// auth/budget/meter to concrete paths on a single app, as below, avoids that
// entirely.
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requestId } from 'hono/request-id';
import type { Database } from 'bun:sqlite';
import { createAuthMiddleware } from './middleware/auth.ts';
import { createBudgetMiddleware } from './middleware/budget.ts';
import { createMeterMiddleware } from './middleware/meter.ts';
import { createPrologueMiddleware } from './middleware/prologue.ts';
import type { OllamaQueue } from './queue.ts';
import { createAnthropicRoutes } from './routes/anthropic.ts';
import { createModelsRoutes } from './routes/models.ts';
import { createOllamaRoutes } from './routes/ollama.ts';
import { createOpenAiRoutes } from './routes/openai.ts';
import { createStatusRoutes } from './routes/status.ts';
import { toErrorResponse } from './upstream.ts';
import type { Client, ModelRegistry, PriceTable } from './config.ts';
import type { AppEnv } from './context.ts';

export interface AppDeps {
  db: Database;
  clients: readonly Client[];
  priceTable: PriceTable;
  modelRegistry: ModelRegistry;
  bodiesDir: string;
  queue: OllamaQueue;
  ollama: { url: string; timeoutMs: number };
  anthropic: { url: string; timeoutMs: number; apiKey: string; defaultVersion: string };
  openai: { url: string; timeoutMs: number; apiKey: string };
  /** hono/logger (or similar) — omitted in tests to keep output quiet. */
  requestLogger?: MiddlewareHandler<AppEnv>;
}

// Every path a real model call can arrive on — auth, budget, metering, and
// the shared prologue (context defaults + body read + model hint + debug
// capture) all apply. Kept as an explicit list rather than discovered
// dynamically: the set is small and fixed by PLAN.md's API-surfaces table,
// and an explicit list is what makes the scoping bug described above
// impossible to reintroduce by accident. Update this alongside src/routes/*.ts
// if a new proxied path is added.
interface ProxiedPath {
  path: string;
  surface: 'ollama' | 'openai' | 'anthropic';
  /** Native passthrough surfaces set `model` from the request hint; the unified dispatch surface doesn't (dispatch owns `model`). */
  hintSetsModel: boolean;
}

const PROXIED_PATHS: readonly ProxiedPath[] = [
  { path: '/api/chat', surface: 'ollama', hintSetsModel: true },
  { path: '/api/tags', surface: 'ollama', hintSetsModel: true },
  { path: '/api/ps', surface: 'ollama', hintSetsModel: true },
  { path: '/api/version', surface: 'ollama', hintSetsModel: true },
  { path: '/v1/chat/completions', surface: 'openai', hintSetsModel: false },
  { path: '/v1/messages', surface: 'anthropic', hintSetsModel: true },
];

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestId());
  if (deps.requestLogger) app.use('*', deps.requestLogger);

  const authMw = createAuthMiddleware(deps.clients);
  const budgetMw = createBudgetMiddleware(deps.db);
  const meterMw = createMeterMiddleware({ db: deps.db, priceTable: deps.priceTable, bodiesDir: deps.bodiesDir });
  // Per-path because the prologue stamps the surface/upstream the path serves.
  const prologueByPath = new Map(
    PROXIED_PATHS.map((p) => [
      p.path,
      createPrologueMiddleware({ surface: p.surface, upstream: p.surface, hintSetsModel: p.hintSetsModel }),
    ]),
  );

  for (const { path } of PROXIED_PATHS) app.use(path, authMw, budgetMw, meterMw, prologueByPath.get(path)!);
  // Auth only — no budget gate (checking status must still work when over
  // budget) and no meter row (neither is a billable model call) — see
  // src/routes/status.ts and src/routes/models.ts.
  app.use('/api/salik/status', authMw);
  app.use('/api/salik/usage', authMw);
  app.use('/v1/models', authMw);

  app.route('/', createOllamaRoutes({ queue: deps.queue, url: deps.ollama.url, timeoutMs: deps.ollama.timeoutMs }));
  app.route(
    '/',
    createOpenAiRoutes({
      registry: deps.modelRegistry,
      queue: deps.queue,
      ollama: deps.ollama,
      anthropic: deps.anthropic,
      openai: deps.openai,
    }),
  );
  app.route(
    '/',
    createAnthropicRoutes({
      url: deps.anthropic.url,
      timeoutMs: deps.anthropic.timeoutMs,
      apiKey: deps.anthropic.apiKey,
      defaultVersion: deps.anthropic.defaultVersion,
    }),
  );
  app.route('/', createStatusRoutes({ queue: deps.queue, db: deps.db }));
  app.route('/', createModelsRoutes({ registry: deps.modelRegistry }));

  // Last-resort safety net. Every route is expected to convert its own
  // errors via toErrorResponse() already (see src/routes/*.ts) — this only
  // catches auth/budget or a future route that forgets to.
  app.onError((err) => toErrorResponse(err));

  return app;
}
