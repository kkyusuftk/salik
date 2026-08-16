// Usage extraction per surface, and cost from config/pricing.json.
//
// Deliberately the only place Salik looks *inside* an upstream body. It reads
// a handful of well-known fields to meter and price a request; it never
// reconstructs or re-emits the body itself (that stays byte-exact — see
// src/upstream.ts and PLAN.md's "Passthrough safety under Hono").
import { Buffer } from 'node:buffer';
import { isRecord, type ExtractedUsage, type PriceEntry, type PriceTable, type Surface, type Usage, ZERO_USAGE } from './types.ts';

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberOr(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

// ---------------------------------------------------------------- anthropic

function usageFromAnthropicObject(obj: Record<string, unknown>): ExtractedUsage {
  const model = typeof obj['model'] === 'string' ? obj['model'] : null;
  const usage = obj['usage'];
  if (!isRecord(usage)) return { model, ...ZERO_USAGE };
  return {
    model,
    inputTokens: numberOr(usage['input_tokens'], 0),
    outputTokens: numberOr(usage['output_tokens'], 0),
    cacheReadTokens: numberOr(usage['cache_read_input_tokens'], 0),
    cacheWriteTokens: numberOr(usage['cache_creation_input_tokens'], 0),
  };
}

/**
 * Non-streaming: one JSON object with a `usage` block. Streaming: an SSE
 * sequence where `message_start` carries input/cache tokens and the model,
 * and the closing `message_delta` carries the cumulative output tokens — so
 * both events have to be read to get a complete count.
 */
export function extractAnthropicUsage(raw: Buffer): ExtractedUsage {
  const text = raw.toString('utf8');
  const direct = tryParseJson(text);
  if (isRecord(direct)) return usageFromAnthropicObject(direct);

  let model: string | null = null;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = tryParseJson(trimmed.slice('data:'.length).trim());
    if (!isRecord(payload)) continue;

    if (payload['type'] === 'message_start') {
      const message = payload['message'];
      if (isRecord(message)) {
        if (typeof message['model'] === 'string') model = message['model'];
        const usage = message['usage'];
        if (isRecord(usage)) {
          inputTokens = numberOr(usage['input_tokens'], inputTokens);
          cacheReadTokens = numberOr(usage['cache_read_input_tokens'], cacheReadTokens);
          cacheWriteTokens = numberOr(usage['cache_creation_input_tokens'], cacheWriteTokens);
          outputTokens = numberOr(usage['output_tokens'], outputTokens);
        }
      }
    } else if (payload['type'] === 'message_delta') {
      const usage = payload['usage'];
      if (isRecord(usage)) outputTokens = numberOr(usage['output_tokens'], outputTokens);
    }
  }
  return { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// ------------------------------------------------------------------ openai

function usageFromOpenAiObject(obj: Record<string, unknown>): ExtractedUsage {
  const model = typeof obj['model'] === 'string' ? obj['model'] : null;
  const usage = obj['usage'];
  if (!isRecord(usage)) return { model, ...ZERO_USAGE };
  const details = usage['prompt_tokens_details'];
  const cachedTokens = isRecord(details) ? numberOr(details['cached_tokens'], 0) : 0;
  const promptTokens = numberOr(usage['prompt_tokens'], 0);
  return {
    model,
    // OpenAI folds cached tokens into prompt_tokens instead of reporting a
    // separate write count, so back them out of the plain figure — the cost
    // formula expects cache reads and regular input to be disjoint counts.
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: numberOr(usage['completion_tokens'], 0),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
  };
}

/**
 * Non-streaming: one JSON object. Streaming: usage only appears at all if the
 * client requested `stream_options.include_usage` — Salik never injects that
 * itself (it would violate byte-exact passthrough), so a stream without it
 * legitimately has no token count to report.
 */
export function extractOpenAiUsage(raw: Buffer): ExtractedUsage {
  const text = raw.toString('utf8');
  const direct = tryParseJson(text);
  if (isRecord(direct)) return usageFromOpenAiObject(direct);

  let model: string | null = null;
  let usage: ExtractedUsage = { model: null, ...ZERO_USAGE };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payloadText = trimmed.slice('data:'.length).trim();
    if (payloadText === '[DONE]') continue;
    const payload = tryParseJson(payloadText);
    if (!isRecord(payload)) continue;
    if (typeof payload['model'] === 'string') model = payload['model'];
    if (isRecord(payload['usage'])) usage = usageFromOpenAiObject(payload);
  }
  return { ...usage, model: usage.model ?? model };
}

// ------------------------------------------------------------------ ollama

function usageFromOllamaObject(obj: Record<string, unknown>): ExtractedUsage {
  const model = typeof obj['model'] === 'string' ? obj['model'] : null;
  return {
    model,
    inputTokens: numberOr(obj['prompt_eval_count'], 0),
    outputTokens: numberOr(obj['eval_count'], 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Non-streaming: one JSON object. Streaming: NDJSON, one object per line (no
 * `data:` prefix, unlike SSE) — the final line (`done: true`) carries the
 * cumulative counts, matching Ollama's own documented contract.
 */
export function extractOllamaUsage(raw: Buffer): ExtractedUsage {
  const text = raw.toString('utf8');
  const direct = tryParseJson(text);
  if (isRecord(direct)) return usageFromOllamaObject(direct);

  let last: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const payload = tryParseJson(line);
    if (isRecord(payload)) last = payload;
  }
  return last ? usageFromOllamaObject(last) : { model: null, ...ZERO_USAGE };
}

export function extractUsage(surface: Surface, raw: Buffer): ExtractedUsage {
  switch (surface) {
    case 'anthropic':
      return extractAnthropicUsage(raw);
    case 'openai':
      return extractOpenAiUsage(raw);
    case 'ollama':
      return extractOllamaUsage(raw);
  }
}

// -------------------------------------------------------------------- cost

/**
 * The rate period covering `at` (defaults to now). Entries are chronological;
 * the first one whose `until` hasn't passed wins, so an introductory rate
 * rolls over to the standing one the day after it ends. `at` is a parameter
 * (not always `new Date()`) so the 2026-08-31 Sonnet 5 rollover is a
 * deterministic, testable date rather than a race against the wall clock.
 */
export function priceFor(table: PriceTable, model: string, at: Date = new Date()): PriceEntry | null {
  const entries = table[model];
  if (!entries || entries.length === 0) return null;
  const atDay = at.toISOString().slice(0, 10);
  for (const entry of entries) {
    if (entry.until === undefined || atDay <= entry.until) return entry;
  }
  // Unreachable if parsePriceTable's invariant held at load time (last entry
  // open-ended) — kept as a safe fallback rather than trusting that forever.
  return entries[entries.length - 1] ?? null;
}

const CACHE_READ_MULTIPLIER = 0.1; // reads are cheaper than a fresh prompt
const CACHE_WRITE_MULTIPLIER = 1.25; // writes cost more than a fresh prompt

export function costFor(entry: PriceEntry, usage: Usage): number {
  const perInputToken = entry.input / 1_000_000;
  const perOutputToken = entry.output / 1_000_000;
  return (
    usage.inputTokens * perInputToken +
    usage.cacheWriteTokens * perInputToken * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * perInputToken * CACHE_READ_MULTIPLIER +
    usage.outputTokens * perOutputToken
  );
}

/**
 * `null` means "no pricing entry for this model" — kept distinct from `0` so
 * a local (genuinely free) model and an un-priced cloud model never look the
 * same in `data/salik.db`.
 */
export function computeCost(table: PriceTable, model: string | null, usage: Usage, at: Date = new Date()): number | null {
  if (model === null) return null;
  const entry = priceFor(table, model, at);
  if (entry === null) return null;
  return costFor(entry, usage);
}

// -------------------------------------------------------------- routing

/**
 * The one deliberately narrow read of a REQUEST body, taken from a *copy* —
 * see PLAN.md's "Type strategy". Every route parses this from its own
 * `await c.req.arrayBuffer()` result and then forwards that same original
 * buffer untouched; this function never sees or influences what gets sent.
 * Malformed/non-JSON bodies (e.g. a health-probe GET with no body at all)
 * quietly read as "no model" rather than throwing — routing and pricing
 * degrade gracefully; only forwarding correctness is load-bearing.
 */
export function readModelHint(raw: ArrayBuffer): string | null {
  const parsed = tryParseJson(Buffer.from(raw).toString('utf8'));
  if (!isRecord(parsed)) return null;
  return typeof parsed['model'] === 'string' ? parsed['model'] : null;
}
