// The single Ollama slot: priority queue + preemption. Cloud upstreams never
// touch this class — they parallelise fine (PLAN.md's "core invariant") — so
// this exists purely to serialise access to the one thing that can't.
import { TIER_RANK, TIERS, type QueueState, type QueueStatus, type Tier } from './wire.ts';

/**
 * Thrown when a higher-tier request took the slot away mid-flight. The wire
 * form is HTTP 409 `salik_preempted` (see src/routes/ollama.ts) — the direct
 * descendant of trip-agent's `Preempted` class (src/llm.mjs), which callers
 * there rely on to skip a retry attempt on a yield. That contract carries
 * over: this is a name for "we stood aside", not "this failed".
 */
export class Preempted extends Error {
  constructor(message = 'preempted by a higher-priority request') {
    super(message);
    this.name = 'Preempted';
  }
}

/** A queued (never-started) entry whose caller went away before its turn. */
class ClientDisconnected extends Error {
  constructor() {
    super('client disconnected while queued');
    this.name = 'ClientDisconnected';
  }
}

interface RunningEntry {
  tier: Tier;
  client: string;
  startedAt: number;
  preemptController: AbortController;
}

type SettleOutcome = { ok: true; queueWaitMs: number } | { ok: false; error: Error };

interface PendingEntry {
  tier: Tier;
  client: string;
  enqueuedAt: number;
  // The SAME controller the waiting run() call is holding — reused (not
  // recreated) when the entry is later granted the slot, so a preemption
  // aimed at "whoever holds the slot" reaches the right AbortController.
  preemptController: AbortController;
  settle: (outcome: SettleOutcome) => void;
}

export class OllamaQueue {
  private slot: RunningEntry | null = null;
  private readonly pending: Record<Tier, PendingEntry[]> = {
    interactive: [],
    chat: [],
    batch: [],
  };

  /**
   * Run `task` against the single local slot, waiting or preempting per
   * PLAN.md's tier table. `task` receives one signal that is `clientSignal`
   * composed with Salik's own preemption controller via `AbortSignal.any` —
   * pass it straight to `fetch` (see src/upstream.ts) so either cause aborts
   * the upstream call and frees the slot.
   *
   * Throws `Preempted` if a higher-tier request preempted this one while it
   * was running. Rethrows anything else — including a plain AbortError from
   * `clientSignal` itself — unchanged.
   */
  async run<T>(
    tier: Tier,
    client: string,
    clientSignal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T; queueWaitMs: number }> {
    const enqueuedAt = Date.now();
    const preemptController = new AbortController();
    try {
      const queueWaitMs = await this.acquireSlot(tier, client, clientSignal, enqueuedAt, preemptController);
      const composed = AbortSignal.any([clientSignal, preemptController.signal]);
      try {
        const value = await task(composed);
        return { value, queueWaitMs };
      } catch (err) {
        if (preemptController.signal.aborted) throw new Preempted();
        throw err;
      }
    } finally {
      // No-op if this entry never actually held the slot (e.g. it was
      // dropped while still queued) — release() checks identity first.
      this.release(preemptController);
    }
  }

  private acquireSlot(
    tier: Tier,
    client: string,
    clientSignal: AbortSignal,
    enqueuedAt: number,
    preemptController: AbortController,
  ): Promise<number> {
    if (this.slot === null) {
      this.slot = { tier, client, startedAt: Date.now(), preemptController };
      return Promise.resolve(Date.now() - enqueuedAt);
    }

    if (TIER_RANK[tier] < TIER_RANK[this.slot.tier]) {
      // Strictly higher priority than the current holder: preempt now
      // instead of queueing. Aborting here is what turns the holder's own
      // run() into a Preempted rejection — see the catch above.
      this.slot.preemptController.abort();
      this.slot = { tier, client, startedAt: Date.now(), preemptController };
      return Promise.resolve(Date.now() - enqueuedAt);
    }

    // Equal or lower priority than the current holder: wait in line. Merely
    // being queued never preempts anything — only a *running* entry can be,
    // which is why a queued PendingEntry carries no logic to abort others.
    return new Promise<number>((resolve, reject) => {
      const entry: PendingEntry = {
        tier,
        client,
        enqueuedAt,
        preemptController,
        settle: (outcome) => (outcome.ok ? resolve(outcome.queueWaitMs) : reject(outcome.error)),
      };
      this.pending[tier].push(entry);

      clientSignal.addEventListener(
        'abort',
        () => {
          const list = this.pending[tier];
          const i = list.indexOf(entry);
          // Already dequeued (granted the slot) — it's running now, and its
          // own task()'s abort handling takes over from here instead.
          if (i === -1) return;
          list.splice(i, 1);
          entry.settle({ ok: false, error: new ClientDisconnected() });
        },
        { once: true },
      );
    });
  }

  /** Highest-priority non-empty tier — the one served next when the slot frees. */
  private nextTier(): Tier | null {
    for (const tier of TIERS) {
      if (this.pending[tier].length > 0) return tier;
    }
    return null;
  }

  private release(preemptController: AbortController): void {
    // Only the entry still holding the slot may release it. An entry that
    // was itself preempted has already had `this.slot` reassigned to its
    // preemptor by the time its own finally block runs this.
    if (this.slot?.preemptController !== preemptController) return;
    this.slot = null;

    const tier = this.nextTier();
    if (tier === null) return;
    const next = this.pending[tier].shift();
    if (!next) return;

    this.slot = { tier: next.tier, client: next.client, startedAt: Date.now(), preemptController: next.preemptController };
    next.settle({ ok: true, queueWaitMs: Date.now() - next.enqueuedAt });
  }

  status(): QueueStatus {
    const slot: QueueState = this.slot
      ? { kind: 'occupied', tier: this.slot.tier, client: this.slot.client, startedAt: this.slot.startedAt }
      : { kind: 'idle' };
    const pending = TIERS.filter((t) => this.pending[t].length > 0).map((t) => ({ tier: t, count: this.pending[t].length }));
    return { slot, pending };
  }
}
