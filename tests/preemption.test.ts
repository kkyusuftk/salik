// End-to-end through the real HTTP layer (route -> queue -> upstream -> meter),
// complementing tests/queue.test.ts's direct unit coverage of OllamaQueue.
// These two scenarios are named explicitly in PLAN.md's Verification section:
// preemption returning 409 salik_preempted, and a client abort mid-stream
// releasing the slot within 200ms.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTestApp, authHeaders, TEST_CLIENTS } from './build-app.ts';
import { createFakeUpstream, jsonResponse, HANG, type FakeUpstream } from './fake-upstreams.ts';

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Extracts the current holder's client name, or null if the slot is idle. */
function slotClient(queue: { status(): { slot: { kind: string; client?: string } } }): string | null {
  const slot = queue.status().slot;
  return slot.kind === 'occupied' ? (slot.client ?? null) : null;
}

describe('preemption end-to-end', () => {
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

  test('an interactive request preempts a running batch request: batch gets 409 salik_preempted, interactive completes normally, both are recorded correctly', async () => {
    // Only the FIRST /api/chat call hangs — the interactive request's own
    // (new) fetch to the fake server must still get a real answer.
    ollama.setScript((call) => {
      if (call.path !== '/api/chat') return jsonResponse({ models: [] });
      const chatCalls = ollama.calls.filter((c) => c.path === '/api/chat').length;
      return chatCalls === 1 ? HANG : jsonResponse({ model: 'gemma4:12b', message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 5, eval_count: 2 });
    });

    const { app, db, queue } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const batchClient = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!;
    const interactiveClient = TEST_CLIENTS.find((c) => c.name === 'portfolio')!;

    const batchPromise = app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(batchClient.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', stream: false, messages: [] }),
    });

    // Proof the batch call is genuinely in flight (holding the slot), not just queued.
    await waitUntil(() => ollama.calls.length > 0);
    expect(queue.status().slot).toMatchObject({ tier: 'batch', client: 'trip-agent-worker' });

    const t0 = Date.now();
    const interactivePromise = app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(interactiveClient.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', stream: false, messages: [] }),
    });

    const [batchRes, interactiveRes] = await Promise.all([batchPromise, interactivePromise]);
    expect(Date.now() - t0).toBeLessThan(1000); // "within ~1s" per PLAN.md's verification section

    expect(batchRes.status).toBe(409);
    const batchBody = (await batchRes.json()) as { error: { type: string } };
    expect(batchBody.error.type).toBe('salik_preempted');
    expect(interactiveRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50)); // meter's fire-and-forget tail for both requests
    const rows = db.query<{ client: string; preempted: number; status: number; queue_wait_ms: number }, []>(
      'SELECT client, preempted, status, queue_wait_ms FROM requests ORDER BY id',
    ).all();

    const batchRow = rows.find((r) => r.client === 'trip-agent-worker');
    const interactiveRow = rows.find((r) => r.client === 'portfolio');
    expect(batchRow).toMatchObject({ preempted: 1, status: 409 });
    expect(interactiveRow).toMatchObject({ preempted: 0, status: 200 });
    // Preemption never queues — both the original grant and the preemptor's
    // takeover are immediate.
    expect(batchRow!.queue_wait_ms).toBeLessThan(50);
    expect(interactiveRow!.queue_wait_ms).toBeLessThan(50);
  });

  test('a client aborting mid-stream releases the queue slot within 200ms, unblocking the next queued request', async () => {
    // Only the FIRST /api/chat call hangs — once the aborted request frees
    // the slot, job-agent's own (queued, then granted) call must get a real
    // answer rather than hanging forever too.
    ollama.setScript((call) => {
      if (call.path !== '/api/chat') return jsonResponse({ models: [] });
      const chatCalls = ollama.calls.filter((c) => c.path === '/api/chat').length;
      return chatCalls === 1 ? HANG : jsonResponse({ model: 'gemma4:12b', message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 5, eval_count: 2 });
    });
    const { app, queue } = buildTestApp({ ollamaUrl: ollama.url, bodiesDir });
    const worker = TEST_CLIENTS.find((c) => c.name === 'trip-agent-worker')!;
    const jobAgent = TEST_CLIENTS.find((c) => c.name === 'job-agent')!; // also batch tier — must queue, not preempt

    const controller = new AbortController();
    const abortedCall = app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(worker.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', stream: false, messages: [] }),
      signal: controller.signal,
    });

    await waitUntil(() => ollama.calls.length > 0);
    expect(queue.status().slot.kind).toBe('occupied');

    // A second batch-tier request queues behind the first (same tier, no preemption).
    const queuedCall = app.request('/api/chat', {
      method: 'POST',
      headers: authHeaders(jobAgent.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'gemma4:12b', stream: false, messages: [] }),
    });
    await waitUntil(() => queue.status().pending.length === 1);

    const t0 = Date.now();
    controller.abort();

    const abortedRes = await abortedCall;
    expect(abortedRes.status).toBe(499); // src/middleware/meter.ts's "client closed the request" convention

    // job-agent was already waiting, so the freed slot goes straight to it —
    // it never sits observably idle in this scenario.
    await waitUntil(() => slotClient(queue) === 'job-agent');
    expect(Date.now() - t0).toBeLessThan(200);

    // With the slot freed, the second request should now be running (or already done).
    const queuedRes = await queuedCall;
    expect(queuedRes.status).toBe(200);
  });
});
