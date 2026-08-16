// Token -> {client, tier}, checked against both header styles a real client
// might use — see src/middleware/auth.ts for why (@anthropic-ai/sdk and
// anthropic-java default to x-api-key, not Authorization: Bearer, and
// PLAN.md's API-surfaces table promises them a baseURL-only migration).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTestApp, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, type FakeUpstream } from './fake-upstreams.ts';

describe('auth middleware', () => {
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

  test('no Authorization header at all -> 401', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/tags');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('salik_invalid_api_key');
  });

  test('an unrecognised token -> 401', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/tags', { headers: { authorization: 'Bearer not-a-real-token' } });
    expect(res.status).toBe(401);
  });

  test('a well-formed but garbage bearer header -> 401, not a crash', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/tags', { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(res.status).toBe(401);
  });

  test('Authorization: Bearer <token> authenticates — the raw-fetch client convention', async () => {
    ollama.setDefaultResponse(jsonResponse({ models: [] }));
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/tags', { headers: { authorization: `Bearer ${TEST_CLIENTS[0]!.token}` } });
    expect(res.status).toBe(200);
  });

  test('x-api-key: <token> also authenticates — the Anthropic-SDK-default convention', async () => {
    ollama.setDefaultResponse(jsonResponse({ models: [] }));
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/tags', { headers: { 'x-api-key': TEST_CLIENTS[0]!.token } });
    expect(res.status).toBe(200);
  });

  test('different tokens resolve to their own distinct client, not just "any valid token"', async () => {
    ollama.setDefaultResponse(jsonResponse({
      id: 'chatcmpl', object: 'chat.completion', model: 'gemma4:12b',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir, openaiLocalModels: ['gemma4:12b'] });

    const portfolio = TEST_CLIENTS.find((c) => c.name === 'portfolio')!;
    const jobAgent = TEST_CLIENTS.find((c) => c.name === 'job-agent')!;

    for (const client of [portfolio, jobAgent]) {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemma4:12b', messages: [] }),
      });
      expect(res.status).toBe(200);
    }
    // Let the fire-and-forget metering tail settle before reading the db.
    await new Promise((r) => setTimeout(r, 50));

    const rows = db.query<{ client: string }, []>('SELECT client FROM requests ORDER BY id').all();
    expect(rows.map((r) => r.client)).toEqual(['portfolio', 'job-agent']);
  });
});
