// The load-bearing suite: byte-exactness through the Hono layer. Every case
// here guards a specific fragility PLAN.md names by file and line in the
// clients Salik replaces — a naive `c.req.json()` + re-`JSON.stringify()`
// would pass a deep-equal check on all of these while still corrupting the
// wire body (reordering keys, reformatting numbers, or dropping a field no
// declared type knows about), so assertions compare raw bytes, never parsed
// objects.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTestApp, authHeaders, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, rawResponse, streamResponse, type FakeUpstream } from './fake-upstreams.ts';

const TOKEN = TEST_CLIENTS[0]!.token; // portfolio, interactive tier

describe('byte-exact passthrough', () => {
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

  test('Ollama /api/chat: a format schema, an unknown field, and a trailing-zero number all survive byte-for-byte', async () => {
    // Hand-built rather than JSON.stringify(obj) at the call site, so this
    // string IS the ground truth — nothing else in the test can "agree with
    // itself" by construction the way two independent stringify calls would.
    const exactBody =
      '{"model":"gemma4:12b","stream":false,"think":false,' +
      '"format":{"type":"object","properties":{"vendor":{"type":"string"},"amount":{"type":"number"}},"required":["vendor","amount"]},' +
      '"options":{"temperature":0.500,"num_predict":160},' +
      '"messages":[{"role":"user","content":"hello"}],' +
      '"x_custom_debug_marker":"keep-me-untouched"}';

    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: exactBody,
    });
    expect(res.status).toBe(200);
    expect(ollama.lastCall()!.rawBody.toString('utf8')).toBe(exactBody);
  });

  test('Ollama /api/chat: think:false is preserved exactly — PLAN.md documents this as a correctness fix, not vendor noise', async () => {
    const body = JSON.stringify({
      model: 'gemma4:12b',
      stream: false,
      think: false,
      options: { temperature: 0 },
      messages: [{ role: 'user', content: '.' }],
    });
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body,
    });
    expect(res.status).toBe(200);
    const receivedRaw = ollama.lastCall()!.rawBody.toString('utf8');
    expect(receivedRaw).toBe(body);
    expect(JSON.parse(receivedRaw).think).toBe(false);
  });

  test('OpenAI-compat vision call (reasoning_effort, max_completion_tokens, function tools) forwards byte-exact to local Ollama', async () => {
    // The exact shape receipt-analyzer/spike-vision-accuracy.py measured at
    // 10/10 — PLAN.md: "Don't 'improve' this for the vision path."
    const body = JSON.stringify({
      model: 'gemma4:12b',
      max_completion_tokens: 1024,
      reasoning_effort: 'none',
      messages: [
        { role: 'system', content: 'You are extracting structured data from a photo of a purchase receipt.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the fields from this receipt.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'RecordReceipt', parameters: { type: 'object', properties: {} } } }],
    });

    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir, openaiLocalModels: ['gemma4:12b'] });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body,
    });
    expect(res.status).toBe(200);
    const call = ollama.lastCall()!;
    expect(call.path).toBe('/v1/chat/completions');
    expect(call.rawBody.toString('utf8')).toBe(body);
  });

  test('a multi-megabyte base64 image_url survives byte-for-byte, not just "about the right size"', async () => {
    const bigImage = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < bigImage.length; i++) bigImage[i] = i % 256; // deterministic, non-uniform — hides silent truncation
    const dataUrl = `data:image/jpeg;base64,${bigImage.toString('base64')}`;
    const body = JSON.stringify({
      model: 'gemma4:12b',
      max_completion_tokens: 1024,
      reasoning_effort: 'none',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
      tools: [{ type: 'function', function: { name: 'RecordReceipt', parameters: {} } }],
    });

    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir, openaiLocalModels: ['gemma4:12b'] });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body,
    });
    expect(res.status).toBe(200);
    const received = ollama.lastCall()!.rawBody;
    expect(received.length).toBe(Buffer.byteLength(body));
    expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
  });

  test('Anthropic /v1/messages forwards byte-exact and swaps the client Salik token for the real upstream key', async () => {
    const anthropic = createFakeUpstream('anthropic');
    const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    const { app } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, anthropicApiKey: 'sk-ant-REAL-UPSTREAM-KEY', bodiesDir });

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body,
    });
    expect(res.status).toBe(200);
    const call = anthropic.lastCall()!;
    expect(call.rawBody.toString('utf8')).toBe(body);
    expect(call.headers['x-api-key']).toBe('sk-ant-REAL-UPSTREAM-KEY');
    expect(call.headers['authorization']).toBeUndefined(); // the client's own Salik bearer token must never leak upstream
    expect(call.headers['anthropic-version']).toBe('2023-06-01'); // filled in — the raw request above sent none
    anthropic.stop();
  });

  test("a client's own anthropic-version header wins over Salik's default", async () => {
    const anthropic = createFakeUpstream('anthropic');
    const { app } = buildTestApp({ ollamaUrl: ollama.url, anthropicUrl: anthropic.url, bodiesDir });
    await app.request('/v1/messages', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json', 'anthropic-version': '2022-01-01' }),
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1, messages: [] }),
    });
    expect(anthropic.lastCall()!.headers['anthropic-version']).toBe('2022-01-01');
    anthropic.stop();
  });
});

describe('streaming', () => {
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

  test('a streamed Ollama response arrives at the client in multiple chunks over time, not one buffered blob', async () => {
    ollama.setDefaultResponse(
      streamResponse(
        [
          '{"model":"gemma4:12b","message":{"role":"assistant","content":"Hel"},"done":false}\n',
          '{"model":"gemma4:12b","message":{"role":"assistant","content":"lo"},"done":false}\n',
          '{"model":"gemma4:12b","done":true,"prompt_eval_count":10,"eval_count":2}\n',
        ],
        { delayMs: 30 },
      ),
    );
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const arrivalsMs: number[] = [];
    const t0 = Date.now();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      arrivalsMs.push(Date.now() - t0);
    }
    expect(arrivalsMs.length).toBeGreaterThanOrEqual(3);
    // A fully-buffered implementation collapses every chunk into the same
    // instant; genuine streaming spreads them out over the scripted delay.
    expect(arrivalsMs[arrivalsMs.length - 1]! - arrivalsMs[0]!).toBeGreaterThan(40);
  });

  test('a gzip-compressed upstream response is transparently decompressed, and the now-stale content-encoding header is stripped rather than forwarded', async () => {
    // fetch() decodes gzip before Salik's own code ever sees the bytes, so the
    // ORIGINAL content-encoding/content-length would mislabel what actually
    // gets piped to the client — src/upstream.ts strips both for exactly this
    // reason. A real, valid gzip body (not just a lying header) proves fetch
    // really did decode it, rather than the test accidentally passing because
    // nothing tried to decode anything.
    const plain = '{"ok":true,"models":[]}';
    const compressed = gzipSync(Buffer.from(plain));
    ollama.setDefaultResponse(
      rawResponse(compressed, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', connection: 'keep-alive', 'x-upstream-custom': 'keep-me' },
      }),
    );
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const res = await app.request('/api/tags', { headers: authHeaders(TOKEN) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(plain);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('x-upstream-custom')).toBe('keep-me');
  });

  test('hop-by-hop request headers never reach the upstream (host, connection) and the client Authorization is replaced, not forwarded', async () => {
    ollama.setDefaultResponse(jsonResponse({ models: [] }));
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    // An unrealistic, clearly-attributable value for `connection` — fetch()
    // manages its own connection-level header regardless of what src/upstream.ts
    // strips, so the meaningful assertion is "the client's literal value
    // never survives", not "no connection header exists at all". POST
    // /api/chat specifically, since that's the path that sets the auth
    // placeholder (the GET health probes don't need one — Ollama ignores
    // auth entirely — so there is nothing to assert there).
    await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(TOKEN, { connection: 'salik-test-marker-should-not-survive', host: 'salik.example:9999', 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', messages: [] }),
    });
    const call = ollama.lastCall()!;
    expect(call.headers['connection']).not.toBe('salik-test-marker-should-not-survive');
    // fetch() sets its own Host for the target URL — the client's inbound one must not leak through.
    expect(call.headers['host']).not.toBe('salik.example:9999');
    expect(call.headers['authorization']).toBe('Bearer local'); // Salik's own placeholder, not the client's Salik token
  });
});
