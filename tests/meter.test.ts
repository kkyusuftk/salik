// Debug body logging (opt-in only — PLAN.md is explicit that bodies-by-default
// would turn data/salik.db into a store of passport/visa/receipt images) and
// its retention pruning.
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneOldBodies, staleBodyFiles } from '../src/middleware/meter.ts';
import { buildTestApp, authHeaders, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, type FakeUpstream } from './fake-upstreams.ts';

describe('staleBodyFiles', () => {
  test('keeps files within the retention window and drops everything older', () => {
    const files = ['2026-08-13.jsonl', '2026-08-14.jsonl', '2026-08-15.jsonl', '2026-08-16.jsonl'];
    // retention 3, "today" 2026-08-16 -> cutoff is 2026-08-13; strictly older than that goes.
    expect(staleBodyFiles(files, '2026-08-16', 3)).toEqual(['2026-08-13.jsonl']);
  });

  test('ignores filenames that are not YYYY-MM-DD.jsonl', () => {
    expect(staleBodyFiles(['notes.txt', '2020-01-01.jsonl.bak', '.DS_Store'], '2026-08-16', 3)).toEqual([]);
  });

  test('an empty retention window (0 days) still keeps today', () => {
    expect(staleBodyFiles(['2026-08-16.jsonl', '2026-08-15.jsonl'], '2026-08-16', 0)).toEqual(['2026-08-15.jsonl']);
  });
});

describe('pruneOldBodies', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'salik-prune-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('deletes only the stale files, from a real directory', () => {
    writeFileSync(path.join(dir, '2026-08-10.jsonl'), '{}\n');
    writeFileSync(path.join(dir, '2026-08-15.jsonl'), '{}\n');
    writeFileSync(path.join(dir, '2026-08-16.jsonl'), '{}\n');

    const removed = pruneOldBodies(dir, 3, '2026-08-16');

    expect(removed.sort()).toEqual(['2026-08-10.jsonl']);
    expect(existsSync(path.join(dir, '2026-08-10.jsonl'))).toBe(false);
    expect(existsSync(path.join(dir, '2026-08-15.jsonl'))).toBe(true);
    expect(existsSync(path.join(dir, '2026-08-16.jsonl'))).toBe(true);
  });

  test('a missing directory is a no-op, not a crash — first run before any debug traffic', () => {
    expect(pruneOldBodies(path.join(dir, 'does-not-exist'), 3)).toEqual([]);
  });
});

describe('debug body logging (opt-in)', () => {
  let ollama: FakeUpstream;
  let bodiesDir: string;

  beforeEach(() => {
    ollama = createFakeUpstream('ollama');
    ollama.setDefaultResponse(jsonResponse({ model: 'gemma4:12b', message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 1 }));
    bodiesDir = mkdtempSync(path.join(tmpdir(), 'salik-bodies-'));
  });

  afterEach(() => {
    ollama.stop();
    rmSync(bodiesDir, { recursive: true, force: true });
  });

  function readEntries(): unknown[] {
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(bodiesDir, `${today}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  test('an ordinary client produces no body log at all', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'portfolio')!; // debug: false
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(client.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(readEntries()).toEqual([]);
  });

  test("a client configured with debug:true gets both request and response bodies logged, base64-encoded, chmod 600", async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'debug-client')!; // debug: true
    const requestBody = JSON.stringify({ model: 'gemma4:12b', messages: [{ role: 'user', content: 'sensitive receipt text' }] });

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(client.token, { 'content-type': 'application/json' }),
      body: requestBody,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const entries = readEntries() as Array<{ client: string; requestBody: string | null; responseBody: string | null }>;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.client).toBe('debug-client');
    expect(Buffer.from(entry.requestBody!, 'base64').toString('utf8')).toBe(requestBody);
    expect(JSON.parse(Buffer.from(entry.responseBody!, 'base64').toString('utf8'))).toMatchObject({ model: 'gemma4:12b' });

    const today = new Date().toISOString().slice(0, 10);
    const stat = statSync(path.join(bodiesDir, `${today}.jsonl`));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('the X-Salik-Debug: 1 header turns on body logging for a client that does not otherwise have it', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'portfolio')!; // debug: false
    await app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(client.token, { 'content-type': 'application/json', 'x-salik-debug': '1' }),
      body: JSON.stringify({ model: 'gemma4:12b', messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(readEntries()).toHaveLength(1);
  });
});
