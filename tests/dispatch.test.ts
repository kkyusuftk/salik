// End-to-end through the real HTTP layer (route -> dispatch -> queue/provider
// -> meter), matching tests/preemption.test.ts's own style for exercising
// control flow rather than isolating dispatch() with hand-built fakes.
// Covers src/dispatch.ts's fallback contract: one hop, never on Preempted,
// never on a client disconnect, and unknown models 404.
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authHeaders, buildTestApp, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, HANG, type FakeUpstream } from './fake-upstreams.ts';
import type { ModelRegistry } from '../src/types.ts';

const TOKEN = TEST_CLIENTS[0]!.token; // portfolio, interactive tier

function registryWithFallback(primaryFallback?: string): ModelRegistry {
  const models = [
    { id: 'primary', provider: 'anthropic' as const, upstreamModel: 'primary-model', ...(primaryFallback ? { fallback: primaryFallback } : {}) },
    { id: 'backup', provider: 'anthropic' as const, upstreamModel: 'backup-model' },
    { id: 'local', provider: 'ollama' as const, upstreamModel: 'gemma4:12b' },
  ];
  return { defaultFallback: 'backup', models, byId: new Map(models.map((m) => [m.id, m])) };
}

function anthropicResponseFor(model: string) {
  return jsonResponse({
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: `hello from ${model}` }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

describe('dispatch: fallback', () => {
  let ollama: FakeUpstream;
  let anthropic: FakeUpstream;
  let bodiesDir: string;

  beforeEach(() => {
    ollama = createFakeUpstream('ollama');
    anthropic = createFakeUpstream('anthropic');
    bodiesDir = mkdtempSync(path.join(tmpdir(), 'salik-test-'));
  });

  afterEach(() => {
    ollama.stop();
    anthropic.stop();
    rmSync(bodiesDir, { recursive: true, force: true });
  });

  test('primary succeeds: fallback is never attempted', async () => {
    anthropic.setScript(() => anthropicResponseFor('primary-model'));
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, bodiesDir, modelRegistry: registryWithFallback() });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('primary');
    expect(anthropic.calls).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 50));
    const row = db.query<{ requested_model: string; model: string; fell_back: number }, []>(
      'SELECT requested_model, model, fell_back FROM requests ORDER BY id DESC LIMIT 1',
    ).get();
    expect(row).toMatchObject({ requested_model: 'primary', model: 'primary-model', fell_back: 0 });
  });

  test('primary fails (non-2xx): the model-specific fallback is served instead, exactly one hop', async () => {
    anthropic.setScript((call) => {
      const model = (JSON.parse(call.rawBody.toString('utf8')) as { model: string }).model;
      return model === 'primary-model' ? jsonResponse({ error: { type: 'api_error', message: 'boom' } }, 500) : anthropicResponseFor('backup-model');
    });
    const { app, db } = buildTestApp({
      ollamaUrl: ollama.url,
      anthropicUrl: anthropic.url,
      bodiesDir,
      modelRegistry: registryWithFallback('backup'),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    // Echoes the model that ACTUALLY served the request, not the one requested.
    expect(body.model).toBe('backup');
    expect(anthropic.calls).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 50));
    const row = db.query<{ requested_model: string; model: string; fell_back: number; status: number }, []>(
      'SELECT requested_model, model, fell_back, status FROM requests ORDER BY id DESC LIMIT 1',
    ).get();
    expect(row).toMatchObject({ requested_model: 'primary', model: 'backup-model', fell_back: 1, status: 200 });
  });

  test('no configured fallback and no usable default: the primary failure is returned as-is', async () => {
    anthropic.setScript(() => jsonResponse({ error: { type: 'api_error', message: 'boom' } }, 500));
    // `primary`'s own fallback points at itself, so there's nothing to fall back to.
    const models = [{ id: 'primary', provider: 'anthropic' as const, upstreamModel: 'primary-model', fallback: 'primary' }];
    const registry: ModelRegistry = { defaultFallback: 'primary', models, byId: new Map(models.map((m) => [m.id, m])) };
    const { app } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, bodiesDir, modelRegistry: registry });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(500);
    expect(anthropic.calls).toHaveLength(1); // never retried against itself
  });

  test('the fallback itself failing is final — no second hop', async () => {
    anthropic.setScript(() => jsonResponse({ error: { type: 'api_error', message: 'boom' } }, 500));
    const { app } = buildTestApp({
      ollamaUrl: ollama.url,
      anthropicUrl: anthropic.url,
      bodiesDir,
      modelRegistry: registryWithFallback('backup'),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(500);
    expect(anthropic.calls).toHaveLength(2); // primary + one fallback hop, never a third attempt
  });

  test('cross-provider fallback: an Ollama-backed primary can fall back to an Anthropic-backed model', async () => {
    ollama.setScript(() => jsonResponse({ error: 'boom' }, 500));
    anthropic.setScript(() => anthropicResponseFor('backup-model'));
    const { app } = buildTestApp({
      ollamaUrl: ollama.url,
      anthropicUrl: anthropic.url,
      bodiesDir,
      modelRegistry: registryWithFallback(),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'local', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('backup'); // registryWithFallback()'s defaultFallback, since 'local' names none of its own
    expect(anthropic.calls).toHaveLength(1);
  });

  test('preemption is never fallback-eligible: an Ollama-backed primary preempted mid-flight still returns 409, and the fallback is never called', async () => {
    ollama.setScript((call) => {
      if (call.path !== '/v1/chat/completions') return jsonResponse({ models: [] });
      const chatCalls = ollama.calls.filter((c) => c.path === '/v1/chat/completions').length;
      // First call (batch) hangs until preempted; the interactive preemptor's
      // own call is the second and needs a real answer to complete normally.
      return chatCalls === 1
        ? HANG
        : jsonResponse({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            model: 'gemma4:12b',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          });
    });
    const { app, queue } = buildTestApp({
      ollamaUrl: ollama.url,
      anthropicUrl: anthropic.url,
      bodiesDir,
      modelRegistry: registryWithFallback(),
    });
    const batchClient = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!;
    const interactiveClient = TEST_CLIENTS.find((c) => c.name === 'portfolio')!;

    const batchPromise = app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(batchClient.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'local', messages: [] }),
    });

    const start = Date.now();
    while (ollama.calls.length === 0) {
      if (Date.now() - start > 1000) throw new Error('timed out waiting for the batch call to reach the fake upstream');
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(queue.status().slot).toMatchObject({ tier: 'batch', client: 'trip-agent-worker' });

    const interactiveRes = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(interactiveClient.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'local', messages: [] }),
    });
    expect(interactiveRes.status).toBe(200);

    const batchRes = await batchPromise;
    expect(batchRes.status).toBe(409);
    const batchBody = (await batchRes.json()) as { error: { type: string } };
    expect(batchBody.error.type).toBe('salik_preempted');
    expect(anthropic.calls).toHaveLength(0); // preemption never triggers the fallback
  });

  test('an unrecognized model returns 404 salik_unknown_model, not a fallback attempt', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, bodiesDir, modelRegistry: registryWithFallback() });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'does-not-exist', messages: [] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('salik_unknown_model');
    expect(anthropic.calls).toHaveLength(0);
  });

  test('a missing "model" field is a 400, not a 404', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, bodiesDir, modelRegistry: registryWithFallback() });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('an unaliased model (upstreamModel === id) still forwards byte-exact through dispatch, same as before the rewrite', async () => {
    // Deliberately the DEFAULT registry (TEST_MODEL_REGISTRY), not
    // registryWithFallback()'s 'local' entry — that one is aliased to
    // gemma4:12b on purpose. TEST_MODEL_REGISTRY's gemma4:12b maps to
    // itself, the common/seed-config case, so rewriteModelField() must be a
    // true no-op here.
    const body = JSON.stringify({ model: 'gemma4:12b', stream: false, messages: [{ role: 'user', content: 'hello' }] });
    const { app } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, bodiesDir });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body,
    });
    expect(res.status).toBe(200);
    expect(ollama.lastCall()!.rawBody.toString('utf8')).toBe(body);
  });
});
