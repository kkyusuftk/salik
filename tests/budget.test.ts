// Daily cap enforcement (402), and the corollary from PLAN.md's middleware
// chain: a request refused here used no tokens, so it must never produce a
// src/middleware/meter.ts row — only auth failures and 402s are logged
// purely via the plain HTTP line, not the per-client ledger.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bumpDailySpend, requestCountToday } from '../src/db.ts';
import { buildTestApp, authHeaders, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, type FakeUpstream } from './fake-upstreams.ts';

const TODAY = new Date().toISOString().slice(0, 10);

describe('budget middleware', () => {
  let ollama: FakeUpstream;
  let bodiesDir: string;

  beforeEach(() => {
    ollama = createFakeUpstream('ollama');
    ollama.setDefaultResponse(jsonResponse({ models: [] }));
    bodiesDir = mkdtempSync(path.join(tmpdir(), 'salik-test-'));
  });

  afterEach(() => {
    ollama.stop();
    rmSync(bodiesDir, { recursive: true, force: true });
  });

  test('a client under budget proceeds normally', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!; // $0.50/day cap
    bumpDailySpend(db, client.name, TODAY, 0.1);

    const res = await app.request('/api/tags', { headers: authHeaders(client.token) });
    expect(res.status).toBe(200);
  });

  test('a client at or over their cap gets 402 salik_budget_exceeded', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!; // $0.50/day cap
    bumpDailySpend(db, client.name, TODAY, 0.5);

    const res = await app.request('/api/tags', { headers: authHeaders(client.token) });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('salik_budget_exceeded');
  });

  test('the cap is per-client — one client over budget does not block another', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const over = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!;
    const under = TEST_CLIENTS.find((c) => c.name === 'job-agent')!;
    bumpDailySpend(db, over.name, TODAY, 999); // wildly over its $0.50 cap

    const overRes = await app.request('/api/tags', { headers: authHeaders(over.token) });
    const underRes = await app.request('/api/tags', { headers: authHeaders(under.token) });
    expect(overRes.status).toBe(402);
    expect(underRes.status).toBe(200);
  });

  test('a 402 is never metered — no requests row, unlike a real proxied call', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const overBudget = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!;
    const fine = TEST_CLIENTS.find((c) => c.name === 'portfolio')!;
    bumpDailySpend(db, overBudget.name, TODAY, 0.5);

    const before = requestCountToday(db, TODAY);
    const blockedRes = await app.request('/api/tags', { headers: authHeaders(overBudget.token) });
    expect(blockedRes.status).toBe(402);

    const okRes = await app.request('/api/tags', { headers: authHeaders(fine.token) });
    expect(okRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // let the ok call's fire-and-forget meter tail land

    // Exactly one row landed (the 200 from the client that wasn't over
    // budget) — the 402 itself contributed nothing.
    expect(requestCountToday(db, TODAY)).toBe(before + 1);
  });
});
