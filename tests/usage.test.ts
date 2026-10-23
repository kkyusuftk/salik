// GET /api/salik/usage and the arithmetic behind it.
//
// Rows are written straight into the ledger with chosen timestamps rather than
// driven through real calls: the thing under test is the bucketing and the
// sums, and a test that had to wait for the clock to cross an hour boundary to
// prove hour bucketing would never run.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hourlyUsage, insertRequest } from '../src/db.ts';
import { formatOffset, parseTzOffsetMinutes, sumTotals, totalsOf } from '../src/usage.ts';
import { buildTestApp, authHeaders, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, type FakeUpstream } from './fake-upstreams.ts';
import type { Database } from 'bun:sqlite';

const TOKEN = TEST_CLIENTS[0]!.token;

/** `hoursAgo` back from now, snapped nowhere — the exact instant is what makes bucketing testable. */
function at(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

function record(
  db: Database,
  opts: { ts: string; client?: string; input?: number; cached?: number; cacheWrite?: number; output?: number; cost?: number | null },
): void {
  insertRequest(db, {
    ts: opts.ts,
    client: opts.client ?? 'portfolio',
    tier: 'batch',
    surface: 'openai',
    upstream: 'openai',
    model: 'gpt-5-mini',
    requestedModel: 'gpt-5-mini',
    status: 200,
    latencyMs: 10,
    queueWaitMs: 0,
    preempted: false,
    fellBack: false,
    usage: {
      inputTokens: opts.input ?? 0,
      outputTokens: opts.output ?? 0,
      cacheReadTokens: opts.cached ?? 0,
      cacheWriteTokens: opts.cacheWrite ?? 0,
    },
    costUsd: opts.cost === undefined ? 0.001 : opts.cost,
  });
}

interface UsageResponse {
  window: { hours: number; since: string; tz: string; offsetMinutes: number };
  client: string | null;
  groupedBy: string[];
  buckets: Array<{
    hour: string; client: string | null; requests: number;
    inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    promptTokens: number; outputTokens: number; totalTokens: number; costUsd: number;
  }>;
  totals: { requests: number; inputTokens: number; cacheReadTokens: number; promptTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
}

describe('the token arithmetic', () => {
  test('everything read in counts as prompt tokens, cached or not', () => {
    const totals = totalsOf({
      hour: '2026-08-18T14:00', client: null, requests: 1,
      inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 10, outputTokens: 50, costUsd: 0.5,
    });
    // The question this report answers is "how many tokens", not "how much did
    // they cost" — a cached token is billed at a tenth but is still a token.
    expect(totals.promptTokens).toBe(1010);
    expect(totals.totalTokens).toBe(1060);
  });

  test('summing buckets adds every component, not just the total', () => {
    const one = { hour: 'x', client: null, requests: 1, inputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 2, costUsd: 0.1 };
    const totals = sumTotals([one, { ...one, hour: 'y' }]);
    expect(totals).toMatchObject({ requests: 2, inputTokens: 20, cacheReadTokens: 2, promptTokens: 22, outputTokens: 4, totalTokens: 26 });
    expect(totals.costUsd).toBeCloseTo(0.2, 10);
  });

  test('an offset is read the several ways a person writes one', () => {
    expect(parseTzOffsetMinutes('utc')).toBe(0);
    expect(parseTzOffsetMinutes(null)).toBe(0);
    expect(parseTzOffsetMinutes('+04:00')).toBe(240);
    expect(parseTzOffsetMinutes('+0400')).toBe(240);
    expect(parseTzOffsetMinutes('-05:30')).toBe(-330);
    expect(parseTzOffsetMinutes('240')).toBe(240);
    // Refused rather than quietly treated as UTC: a report labelled with the
    // wrong hours looks right, which is the dangerous kind of wrong.
    expect(parseTzOffsetMinutes('Asia/Dubai')).toBeNull();
    expect(parseTzOffsetMinutes('+99:00')).toBeNull();
    expect(formatOffset(-330)).toBe('-05:30');
  });
});

describe('hourlyUsage()', () => {
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

  test('groups by the hour, newest first, and leaves empty hours out', () => {
    const { db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    record(db, { ts: at(1), input: 100, output: 10 });
    record(db, { ts: at(1), input: 200, output: 20 });
    record(db, { ts: at(3), input: 5, output: 1 });

    const buckets = hourlyUsage(db, { since: at(24) });
    expect(buckets.length).toBe(2); // the hour between them has no row at all
    expect(buckets[0]!.inputTokens).toBe(300);
    expect(buckets[0]!.requests).toBe(2);
    expect(buckets[1]!.inputTokens).toBe(5);
    expect(buckets[0]!.hour > buckets[1]!.hour).toBe(true);
  });

  test('the window excludes anything older than `since`', () => {
    const { db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    record(db, { ts: at(1), input: 7 });
    record(db, { ts: at(50), input: 999 });
    expect(sumTotals(hourlyUsage(db, { since: at(24) })).inputTokens).toBe(7);
  });

  test('an offset moves the hour boundaries, not just the labels', () => {
    const { db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    // 23:30 UTC is 03:30 the NEXT day in Dubai — the case where a naive
    // substr(ts,1,13) would file the row under the wrong day entirely.
    record(db, { ts: '2026-08-17T23:30:00.000Z', input: 42 });
    const since = '2026-08-17T00:00:00.000Z';

    expect(hourlyUsage(db, { since })[0]!.hour).toBe('2026-08-17T23:00');
    expect(hourlyUsage(db, { since, offsetMinutes: 240 })[0]!.hour).toBe('2026-08-18T03:00');
    expect(hourlyUsage(db, { since, offsetMinutes: -300 })[0]!.hour).toBe('2026-08-17T18:00');
  });

  test('by-client splits an hour that one client alone would hide', () => {
    const { db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    record(db, { ts: at(1), client: 'portfolio', input: 10 });
    record(db, { ts: at(1), client: 'trip-agent-worker', input: 90 });

    expect(hourlyUsage(db, { since: at(24) })[0]!.inputTokens).toBe(100);
    const split = hourlyUsage(db, { since: at(24), byClient: true });
    expect(split.length).toBe(2);
    expect(split.map((b) => b.client).sort()).toEqual(['portfolio', 'trip-agent-worker']);
    const filtered = hourlyUsage(db, { since: at(24), client: 'trip-agent-worker' });
    expect(filtered[0]!.inputTokens).toBe(90);
  });

  test('a request with no pricing entry still counts its tokens', () => {
    const { db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    // cost_usd is NULL for an unpriced model. COALESCE keeps it out of the
    // money column without dropping the row's tokens with it.
    record(db, { ts: at(1), input: 500, output: 50, cost: null });
    const bucket = hourlyUsage(db, { since: at(24) })[0]!;
    expect(bucket.inputTokens).toBe(500);
    expect(bucket.costUsd).toBe(0);
  });
});

describe('GET /api/salik/usage', () => {
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
    expect((await app.request('/api/salik/usage')).status).toBe(401);
  });

  test('reports the window it used, the totals, and the buckets under them', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    record(db, { ts: at(1), input: 1000, cached: 200, output: 100, cost: 0.01 });
    record(db, { ts: at(2), input: 500, output: 50, cost: 0.005 });

    const res = await app.request('/api/salik/usage', { headers: authHeaders(TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageResponse;

    expect(body.window.hours).toBe(24);
    expect(body.window.tz).toBe('+00:00'); // the endpoint is UTC unless asked otherwise
    expect(body.groupedBy).toEqual(['hour']);
    expect(body.buckets.length).toBe(2);
    expect(body.totals.promptTokens).toBe(1700); // 1500 fresh + 200 cached
    expect(body.totals.outputTokens).toBe(150);
    expect(body.totals.totalTokens).toBe(1850);
    expect(body.totals.costUsd).toBeCloseTo(0.015, 10);
  });

  test('honours hours, client and by=client', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    record(db, { ts: at(1), client: 'portfolio', input: 10 });
    record(db, { ts: at(1), client: 'job-agent', input: 90 });
    record(db, { ts: at(40), client: 'portfolio', input: 7000 });

    const scoped = (await (await app.request('/api/salik/usage?hours=2&client=job-agent', { headers: authHeaders(TOKEN) })).json()) as UsageResponse;
    expect(scoped.client).toBe('job-agent');
    expect(scoped.totals.inputTokens).toBe(90);

    const split = (await (await app.request('/api/salik/usage?by=client', { headers: authHeaders(TOKEN) })).json()) as UsageResponse;
    expect(split.groupedBy).toEqual(['hour', 'client']);
    expect(split.buckets.length).toBe(2);

    const wide = (await (await app.request('/api/salik/usage?hours=48', { headers: authHeaders(TOKEN) })).json()) as UsageResponse;
    expect(wide.totals.inputTokens).toBe(7100);
  });

  test('a timezone shifts the buckets and is echoed back', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    record(db, { ts: at(1), input: 1 });
    const body = (await (await app.request('/api/salik/usage?tz=%2B04:00', { headers: authHeaders(TOKEN) })).json()) as UsageResponse;
    expect(body.window.tz).toBe('+04:00');
    expect(body.window.offsetMinutes).toBe(240);
    const utcHour = new Date(Date.now() - 3_600_000).toISOString().slice(11, 13);
    expect(body.buckets[0]!.hour.slice(11, 13)).toBe(String((Number(utcHour) + 4) % 24).padStart(2, '0'));
  });

  test('a window or a zone it cannot honour is a 400, not a guess', async () => {
    const { app } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    for (const q of ['?hours=0', '?hours=nonsense', '?hours=100000', '?tz=Asia/Dubai']) {
      const res = await app.request(`/api/salik/usage${q}`, { headers: authHeaders(TOKEN) });
      expect(res.status).toBe(400);
    }
  });

  test('answers even when the caller is over budget, like status does', async () => {
    const { app, db } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const client = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!;
    db.query('INSERT INTO daily_spend (client, date, cost_usd) VALUES (?, ?, ?)')
      .run(client.name, new Date().toISOString().slice(0, 10), 999);
    const res = await app.request('/api/salik/usage', { headers: authHeaders(client.token) });
    expect(res.status).toBe(200);
  });
});
