// Builds a real app via src/app.ts — the same assembly server/server.ts uses
// — with injected config and an in-memory db instead of reading disk/env.
// Deliberately NOT a hand-mirrored copy of the wiring (that's what caused a
// middleware-scoping bug during development — see src/app.ts's own comment).
import { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { OllamaQueue } from '../src/queue.ts';
import type { AppEnv, Client, PriceTable } from '../src/types.ts';

export const TEST_CLIENTS: Client[] = [
  { token: 'tok-interactive', name: 'portfolio', tier: 'interactive', dailyBudgetUsd: 2.0, debug: false },
  { token: 'tok-chat', name: 'trip-agent-web', tier: 'chat', dailyBudgetUsd: 0.5, debug: false },
  { token: 'tok-batch', name: 'trip-agent-worker', tier: 'batch', dailyBudgetUsd: 0.5, debug: false },
  { token: 'tok-batch-2', name: 'job-agent', tier: 'batch', dailyBudgetUsd: 1.0, debug: false },
  { token: 'tok-debug', name: 'debug-client', tier: 'batch', dailyBudgetUsd: 5.0, debug: true },
];

export const TEST_PRICE_TABLE: PriceTable = {
  'claude-sonnet-5': [
    { until: '2026-08-31', input: 2.0, output: 10.0 },
    { input: 3.0, output: 15.0 },
  ],
  'claude-opus-5': [{ input: 5.0, output: 25.0 }],
  'gemma4:12b': [{ input: 0, output: 0 }],
};

export interface TestAppOptions {
  clients?: Client[];
  priceTable?: PriceTable;
  ollamaUrl: string;
  anthropicUrl?: string;
  anthropicApiKey?: string;
  openaiUrl?: string;
  openaiApiKey?: string;
  openaiLocalModels?: string[];
  timeoutMs?: number;
  bodiesDir: string;
}

export interface TestApp {
  app: Hono<AppEnv>;
  db: Database;
  queue: OllamaQueue;
}

export function buildTestApp(opts: TestAppOptions): TestApp {
  const db = openDb(':memory:');
  const queue = new OllamaQueue();
  const timeoutMs = opts.timeoutMs ?? 5000;

  const app = createApp({
    db,
    clients: opts.clients ?? TEST_CLIENTS,
    priceTable: opts.priceTable ?? TEST_PRICE_TABLE,
    bodiesDir: opts.bodiesDir,
    queue,
    ollama: { url: opts.ollamaUrl, timeoutMs },
    anthropic: {
      url: opts.anthropicUrl ?? 'http://127.0.0.1:1', // unused unless a test opts in
      timeoutMs,
      apiKey: opts.anthropicApiKey ?? 'test-anthropic-key',
      defaultVersion: '2023-06-01',
    },
    openai: {
      url: opts.openaiUrl ?? 'http://127.0.0.1:1', // unused unless a test opts in
      timeoutMs,
      localModels: opts.openaiLocalModels ?? [],
      apiKey: opts.openaiApiKey ?? 'test-openai-key',
    },
    // No requestLogger: hono/logger's console noise isn't useful in tests.
  });

  return { app, db, queue };
}

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}
