// What "tokens consumed" means, defined once.
//
// The ledger stores the four counts an upstream actually reports (fresh prompt,
// cached prompt, cache-write, completion) and src/db.ts hands them back
// untouched. Adding them up is a separate decision, and it is made here rather
// than in the route or the CLI so that the number on a terminal and the number
// in a JSON response can never drift apart.
//
// THE SUM THAT MATTERS: everything the model read (fresh + cached + written to
// cache) plus everything it wrote. Cache reads are billed at a tenth and cache
// writes at 1.25x (src/pricing.ts), so they are worth a fraction of a fresh
// token in money — but they are not worth a fraction of a token in TOKENS, and
// this is the token report. Cost is carried alongside, already computed, for
// anyone who wants the other question answered.
import type { UsageBucket } from './db.ts';

export interface UsageTotals {
  requests: number;
  /** Prompt tokens read fresh. */
  inputTokens: number;
  /** Prompt tokens served from cache. Disjoint from inputTokens. */
  cacheReadTokens: number;
  /** Prompt tokens written into cache (Anthropic only). */
  cacheWriteTokens: number;
  /** Everything read in: inputTokens + cacheReadTokens + cacheWriteTokens. */
  promptTokens: number;
  /** Everything written out. */
  outputTokens: number;
  /** promptTokens + outputTokens. */
  totalTokens: number;
  costUsd: number;
}

const ZERO: UsageTotals = {
  requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  promptTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
};

export function totalsOf(bucket: UsageBucket): UsageTotals {
  const promptTokens = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
  return {
    requests: bucket.requests,
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    promptTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: promptTokens + bucket.outputTokens,
    costUsd: bucket.costUsd,
  };
}

export function sumTotals(buckets: readonly UsageBucket[]): UsageTotals {
  return buckets.reduce<UsageTotals>((acc, b) => {
    const t = totalsOf(b);
    return {
      requests: acc.requests + t.requests,
      inputTokens: acc.inputTokens + t.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + t.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + t.cacheWriteTokens,
      promptTokens: acc.promptTokens + t.promptTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      totalTokens: acc.totalTokens + t.totalTokens,
      costUsd: acc.costUsd + t.costUsd,
    };
  }, ZERO);
}

/** The UTC ISO instant `hours` before `now` — the window's oldest included timestamp. */
export function since(hours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/**
 * How the caller wants hours bucketed, as minutes east of UTC.
 *
 * Accepts `utc`, `local` (the SERVER's own offset — the process reading the
 * database, which for the CLI is the machine you typed on), an ISO-style
 * `+04:00` / `-0530` / `+4`, or plain minutes (`240`). Returns null on anything
 * else rather than silently falling back to UTC: a report labelled with the
 * wrong hours is worse than one that refused to run.
 */
export function parseTzOffsetMinutes(raw: string | null | undefined, now: Date = new Date()): number | null {
  if (raw === null || raw === undefined || raw === '' || raw.toLowerCase() === 'utc') return 0;
  // getTimezoneOffset() counts minutes WEST of UTC; every other offset here is east.
  if (raw.toLowerCase() === 'local') return -now.getTimezoneOffset();

  const iso = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(raw.trim());
  if (iso) {
    const [, sign, hh, mm] = iso;
    const minutes = Number(hh) * 60 + Number(mm ?? 0);
    return Math.abs(minutes) > 14 * 60 ? null : (sign === '-' ? -minutes : minutes);
  }
  const plain = Number(raw);
  if (Number.isInteger(plain) && Math.abs(plain) <= 14 * 60) return plain;
  return null;
}

/** '+04:00' — how a bucket's zone is reported back, so a row is never ambiguous. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
