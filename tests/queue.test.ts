// The single Ollama slot is the one piece of Salik with genuinely subtle
// concurrency, and it's the reason every other project on this Mac mini can
// retire its own ad-hoc priority heuristic — so it gets the most direct,
// implementation-level coverage in the suite: every row of PLAN.md's tier
// table, same-tier FIFO, priority (not arrival) order on release, a queued
// (never-started) client giving up, and a mid-run client abort freeing the
// slot fast enough that the next request doesn't stall behind a dead one.
import { describe, expect, test } from 'bun:test';
import { OllamaQueue, Preempted } from '../src/queue.ts';

/** Mimics a real fetch(): stays pending until its own signal aborts, then rejects. */
function abortableHang(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error('already aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function immediate(value: string) {
  return async (_signal: AbortSignal): Promise<string> => value;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('OllamaQueue — basic acquisition', () => {
  test('runs immediately when the slot is idle', async () => {
    const queue = new OllamaQueue();
    const { value, queueWaitMs } = await queue.run('batch', 'c1', new AbortController().signal, immediate('done'));
    expect(value).toBe('done');
    expect(queueWaitMs).toBeLessThan(20);
  });

  test('status() reports idle once everything drains', async () => {
    const queue = new OllamaQueue();
    await queue.run('batch', 'a', new AbortController().signal, immediate('done'));
    expect(queue.status()).toEqual({ slot: { kind: 'idle' }, pending: [] });
  });

  test('same-tier requests queue FIFO behind each other', async () => {
    const queue = new OllamaQueue();
    const order: string[] = [];
    const first = queue.run('batch', 'c1', new AbortController().signal, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('first-end');
      return 'first';
    });
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const second = queue.run('batch', 'c2', new AbortController().signal, async () => {
      order.push('second-start');
      return 'second';
    });
    await waitUntil(() => queue.status().pending.length === 1);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(firstResult.value).toBe('first');
    expect(secondResult.value).toBe('second');
    // It genuinely waited behind the ~30ms first call, not a coincidence of scheduling.
    expect(secondResult.queueWaitMs).toBeGreaterThanOrEqual(15);
  });
});

describe('OllamaQueue — PLAN.md tier table', () => {
  test('batch never preempts a running interactive request — it queues instead', async () => {
    const queue = new OllamaQueue();
    const runningAbort = new AbortController();
    const running = queue.run('interactive', 'portfolio', runningAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const batch = queue.run('batch', 'worker', new AbortController().signal, immediate('batch-done'));
    await waitUntil(() => queue.status().pending.length === 1);

    expect(queue.status().slot).toMatchObject({ kind: 'occupied', tier: 'interactive', client: 'portfolio' });
    expect(queue.status().pending).toEqual([{ tier: 'batch', count: 1 }]);

    runningAbort.abort(); // release it so the test can finish
    await expect(running).rejects.toThrow();
    expect((await batch).value).toBe('batch-done');
  });

  test('chat waits for a running interactive request — it queues instead of preempting', async () => {
    const queue = new OllamaQueue();
    const runningAbort = new AbortController();
    const running = queue.run('interactive', 'portfolio', runningAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const chat = queue.run('chat', 'trip-agent-web', new AbortController().signal, immediate('chat-done'));
    await waitUntil(() => queue.status().pending.length === 1);
    expect(queue.status().pending).toEqual([{ tier: 'chat', count: 1 }]);

    runningAbort.abort();
    await expect(running).rejects.toThrow();
    expect((await chat).value).toBe('chat-done');
  });

  test('chat preempts a running batch request immediately', async () => {
    const queue = new OllamaQueue();
    const batchAbort = new AbortController();
    const batch = queue.run('batch', 'worker', batchAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const chat = queue.run('chat', 'trip-agent-web', new AbortController().signal, immediate('chat-done'));

    await expect(batch).rejects.toBeInstanceOf(Preempted);
    const result = await chat;
    expect(result.value).toBe('chat-done');
    expect(result.queueWaitMs).toBeLessThan(20); // preempts immediately, never queues
  });

  test('interactive preempts a running chat request immediately', async () => {
    const queue = new OllamaQueue();
    const chatAbort = new AbortController();
    const chat = queue.run('chat', 'trip-agent-web', chatAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const interactive = queue.run('interactive', 'portfolio', new AbortController().signal, immediate('interactive-done'));

    await expect(chat).rejects.toBeInstanceOf(Preempted);
    expect((await interactive).value).toBe('interactive-done');
  });

  test('interactive preempts a running batch request immediately', async () => {
    const queue = new OllamaQueue();
    const batchAbort = new AbortController();
    const batch = queue.run('batch', 'worker', batchAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const interactive = queue.run('interactive', 'portfolio', new AbortController().signal, immediate('interactive-done'));

    await expect(batch).rejects.toBeInstanceOf(Preempted);
    expect((await interactive).value).toBe('interactive-done');
  });

  test('same tier never preempts itself, even interactive-on-interactive', async () => {
    const queue = new OllamaQueue();
    const firstAbort = new AbortController();
    const first = queue.run('interactive', 'a', firstAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const second = queue.run('interactive', 'b', new AbortController().signal, immediate('second-done'));
    await waitUntil(() => queue.status().pending.length === 1);
    expect(queue.status().pending).toEqual([{ tier: 'interactive', count: 1 }]);

    firstAbort.abort();
    await expect(first).rejects.toThrow();
    expect((await second).value).toBe('second-done');
  });

  test('when the slot frees, the highest-priority queued tier goes next — not arrival order', async () => {
    const queue = new OllamaQueue();
    const holderAbort = new AbortController();
    const holder = queue.run('interactive', 'holder', holderAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const order: string[] = [];
    // Arrival order is batch, then chat. Neither can preempt an interactive
    // holder, so both queue — priority order on release should still be chat first.
    const batchP = queue.run('batch', 'worker', new AbortController().signal, async () => {
      order.push('batch');
      return 'batch';
    });
    await waitUntil(() => queue.status().pending.some((p) => p.tier === 'batch'));
    const chatP = queue.run('chat', 'trip-agent-web', new AbortController().signal, async () => {
      order.push('chat');
      return 'chat';
    });
    await waitUntil(() => queue.status().pending.some((p) => p.tier === 'chat'));

    holderAbort.abort();
    await expect(holder).rejects.toThrow();
    await Promise.all([batchP, chatP]);
    expect(order).toEqual(['chat', 'batch']);
  });
});

describe('OllamaQueue — disconnects', () => {
  test('a client giving up while merely queued is dropped without affecting the others', async () => {
    const queue = new OllamaQueue();
    const holderAbort = new AbortController();
    const holder = queue.run('batch', 'holder', holderAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const middleAbort = new AbortController();
    const middle = queue.run('batch', 'middle', middleAbort.signal, immediate('middle-done'));
    await waitUntil(() => queue.status().pending[0]?.count === 1);
    const last = queue.run('batch', 'last', new AbortController().signal, immediate('last-done'));
    await waitUntil(() => queue.status().pending[0]?.count === 2);

    middleAbort.abort(); // gives up its place in line before ever running
    await expect(middle).rejects.toThrow();
    await waitUntil(() => queue.status().pending[0]?.count === 1);

    holderAbort.abort();
    await expect(holder).rejects.toThrow();
    const result = await last;
    expect(result.value).toBe('last-done'); // "last" got the slot; "middle" never ran
  });

  test('a client aborting mid-run frees the slot within 200ms for the next request', async () => {
    const queue = new OllamaQueue();
    const runningAbort = new AbortController();
    const running = queue.run('batch', 'a', runningAbort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');

    const next = queue.run('batch', 'b', new AbortController().signal, immediate('next-done'));
    await waitUntil(() => queue.status().pending.length === 1);

    const t0 = Date.now();
    runningAbort.abort(); // simulates a closed tab / dropped connection, not a preemption
    await expect(running).rejects.toThrow();

    const result = await next;
    expect(result.value).toBe('next-done');
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test('a disconnect is a plain rejection, not Preempted — callers must be able to tell the two apart', async () => {
    // trip-agent's worker.mjs deliberately does NOT spend a retry attempt on a
    // Preempted yield; a genuine failure is the opposite case, and the two
    // must stay distinguishable through this exact mechanism.
    const queue = new OllamaQueue();
    const abort = new AbortController();
    const run = queue.run('batch', 'a', abort.signal, abortableHang);
    await waitUntil(() => queue.status().slot.kind === 'occupied');
    abort.abort();
    let caught: unknown;
    try {
      await run;
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(Preempted);
  });
});
