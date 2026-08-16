// GET /v1/models: auth required, lists the configured registry in OpenAI's
// own response shape. No budget gate, no meter row — a pure local-config
// read, same rationale as /api/salik/status.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authHeaders, buildTestApp, TEST_CLIENTS, TEST_MODEL_REGISTRY } from './build-app.ts';
import { createFakeUpstream, type FakeUpstream } from './fake-upstreams.ts';

describe('GET /v1/models', () => {
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

  test('requires auth', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/v1/models');
    expect(res.status).toBe(401);
  });

  test('lists every configured model with its id and provider', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/v1/models', { headers: authHeaders(TEST_CLIENTS[0]!.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(TEST_MODEL_REGISTRY.models.length);
    const gemma = body.data.find((m) => m.id === 'gemma4:12b');
    expect(gemma).toMatchObject({ id: 'gemma4:12b', object: 'model', owned_by: 'ollama' });
    const sonnet = body.data.find((m) => m.id === 'claude-sonnet-5');
    expect(sonnet).toMatchObject({ id: 'claude-sonnet-5', object: 'model', owned_by: 'anthropic' });
  });

  test('works even when the client is over budget — not budget-gated, same as /api/salik/status', async () => {
    // dailyBudgetUsd: 0 means already-over-cap with zero spend recorded — budget.ts compares spend >= cap.
    const overBudgetClients = TEST_CLIENTS.map((c) => (c.name === 'portfolio' ? { ...c, dailyBudgetUsd: 0 } : c));
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir, clients: overBudgetClients });
    const res = await app.request('/v1/models', { headers: authHeaders(overBudgetClients[0]!.token) });
    expect(res.status).toBe(200);
  });
});
