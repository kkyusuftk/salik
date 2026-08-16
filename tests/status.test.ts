// /api/salik/status: auth required, but deliberately NOT budget-gated or
// metered — see src/routes/status.ts for why.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bumpDailySpend } from '../src/db.ts';
import { buildTestApp, authHeaders, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, type FakeUpstream } from './fake-upstreams.ts';

const TODAY = new Date().toISOString().slice(0, 10);

describe('GET /api/salik/status', () => {
  let ollama: FakeUpstream;
  let bodiesDir: string;

  beforeEach(() => {
    ollama = createFakeUpstream('ollama');
    bodiesDir = mkdtempSync(path.join(tmpdir(), 'salik-test-'));
  });

  afterEach(() => {
    ollama.stop();
    rmSync(bodiesDir, { recursive: true, force: true });
  });

  test('requires a valid token like everything else', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/salik/status');
    expect(res.status).toBe(401);
  });

  test('an idle queue and zero spend read exactly as such', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/salik/status', { headers: authHeaders(TEST_CLIENTS[0]!.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue: { slot: { kind: string }; pending: unknown[] };
      spend: { totalUsd: number; byClient: Record<string, number> };
      requestsToday: number;
    };
    expect(body.queue).toEqual({ slot: { kind: 'idle' }, pending: [] });
    expect(body.spend.totalUsd).toBe(0);
    expect(body.requestsToday).toBe(0);
  });

  test('reflects a real client\'s spend after a costed call', async () => {
    ollama.setDefaultResponse(
      jsonResponse({
        id: 'chatcmpl', object: 'chat.completion', model: 'gemma4:12b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      }),
    );
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'portfolio')!;

    const chatRes = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(client.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', messages: [] }),
    });
    expect(chatRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // fire-and-forget meter tail

    const statusRes = await app.request('/api/salik/status', { headers: authHeaders(client.token) });
    const body = (await statusRes.json()) as { spend: { totalUsd: number; byClient: Record<string, number> }; requestsToday: number };
    // gemma4:12b is priced at $0 — real tokens flowed, but the bill is zero.
    expect(body.spend.byClient['portfolio']).toBe(0);
    expect(body.requestsToday).toBe(1);
  });

  test('still answers even when the caller is over their own daily budget', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!; // $0.50 cap
    bumpDailySpend(db, client.name, TODAY, 999);

    const res = await app.request('/api/salik/status', { headers: authHeaders(client.token) });
    expect(res.status).toBe(200); // not 402 — status.ts is mounted without the budget middleware
  });
});
