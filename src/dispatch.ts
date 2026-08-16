// Model-registry lookup + per-provider attempt + one-hop fallback for
// POST /v1/chat/completions.
//
// A Preempted and a client disconnect are both explicitly NOT
// fallback-eligible (the first is "yielded, not failed"; the second has no
// one left to serve) — runAttempt() classifies exactly those two into
// `not_fallback_eligible`, rethrown unchanged so the route's existing
// Preempted/abort handling (see src/routes/openai.ts) is untouched.
// Everything else (a non-2xx response, a network error, a non-abort
// timeout) is `failed` and gets exactly one fallback hop.
//
// "Pre-first-byte" needs no separate bookkeeping: dispatch only ever hands
// the route a Response once it has committed to it — fetch() resolving with
// `.ok`, before any body bytes are read — and Bun/Hono never starts
// streaming to the real client any earlier than that. So "did we already
// send bytes" and "did dispatch already commit to this attempt" are the
// same question.
import { Buffer } from 'node:buffer';
import { tryParseJson } from './pricing.ts';
import {
  requestErrorToResponse,
  translateErrorResponse,
  translateNonStreamingResponse,
  translateRequest,
  translateStreamingResponse,
} from './providers/anthropic/index.ts';
import { Preempted, type OllamaQueue } from './queue.ts';
import { forward } from './upstream.ts';
import { isRecord, type ModelEntry, type ModelRegistry, type Tier, type UpstreamName } from './types.ts';

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`unknown model "${model}"`);
    this.name = 'UnknownModelError';
  }
}

export interface DispatchDeps {
  registry: ModelRegistry;
  queue: OllamaQueue;
  ollama: { url: string; timeoutMs: number };
  anthropic: { url: string; timeoutMs: number; apiKey: string; defaultVersion: string };
  openai: { url: string; timeoutMs: number; apiKey: string };
}

export interface DispatchOutcome {
  response: Response;
  servedBy: { provider: UpstreamName; upstreamModel: string };
  fellBack: boolean;
  queueWaitMs: number;
}

interface RawAttempt {
  response: Response;
  queueWaitMs: number;
}

/**
 * Rewrites just the `model` key when the registry names an upstream model
 * different from the client-facing id (aliasing) — a narrow, deliberate
 * parse-mutate-reserialize, scoped to this one field, exactly as justified
 * as src/pricing.ts's readModelHint() exception. When there's no alias (the
 * common case — every seed config/models.json entry maps to itself), this
 * is a true no-op and the original bytes are forwarded untouched.
 */
function rewriteModelField(rawBody: ArrayBuffer, currentModel: string, upstreamModel: string): ArrayBuffer {
  if (upstreamModel === currentModel) return rawBody;
  const parsed = tryParseJson(Buffer.from(rawBody).toString('utf8'));
  const rewritten = isRecord(parsed) ? { ...parsed, model: upstreamModel } : { model: upstreamModel };
  return new TextEncoder().encode(JSON.stringify(rewritten)).buffer;
}

async function attemptOllama(
  deps: DispatchDeps,
  entry: ModelEntry,
  requestedModelId: string,
  rawBody: ArrayBuffer,
  headers: Headers,
  tier: Tier,
  clientName: string,
  clientSignal: AbortSignal,
): Promise<RawAttempt> {
  const body = rewriteModelField(rawBody, requestedModelId, entry.upstreamModel);
  const outHeaders = new Headers(headers);
  outHeaders.set('authorization', 'Bearer local');
  outHeaders.set('content-type', 'application/json');
  const { value, queueWaitMs } = await deps.queue.run(tier, clientName, clientSignal, (signal) =>
    forward({
      method: 'POST',
      url: `${deps.ollama.url}/v1/chat/completions`,
      headers: outHeaders,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.ollama.timeoutMs)]),
    }),
  );
  return { response: value, queueWaitMs };
}

async function attemptOpenAi(
  deps: DispatchDeps,
  entry: ModelEntry,
  requestedModelId: string,
  rawBody: ArrayBuffer,
  headers: Headers,
  clientSignal: AbortSignal,
): Promise<RawAttempt> {
  const body = rewriteModelField(rawBody, requestedModelId, entry.upstreamModel);
  const outHeaders = new Headers(headers);
  outHeaders.set('authorization', `Bearer ${deps.openai.apiKey}`);
  outHeaders.set('content-type', 'application/json');
  const response = await forward({
    method: 'POST',
    url: `${deps.openai.url}/v1/chat/completions`,
    headers: outHeaders,
    body,
    signal: AbortSignal.any([clientSignal, AbortSignal.timeout(deps.openai.timeoutMs)]),
  });
  return { response, queueWaitMs: 0 };
}

async function attemptAnthropic(
  deps: DispatchDeps,
  entry: ModelEntry,
  rawBody: ArrayBuffer,
  headers: Headers,
  clientSignal: AbortSignal,
): Promise<RawAttempt> {
  const translated = translateRequest(rawBody, entry.upstreamModel);
  if (!translated.ok) return { response: requestErrorToResponse(translated.error), queueWaitMs: 0 };

  const outHeaders = new Headers(headers);
  outHeaders.set('x-api-key', deps.anthropic.apiKey);
  outHeaders.set('content-type', 'application/json');
  outHeaders.set('anthropic-version', deps.anthropic.defaultVersion);

  const anthropicRes = await fetch(`${deps.anthropic.url}/v1/messages`, {
    method: 'POST',
    headers: outHeaders,
    body: JSON.stringify(translated.value.body),
    signal: AbortSignal.any([clientSignal, AbortSignal.timeout(deps.anthropic.timeoutMs)]),
  });

  if (!anthropicRes.ok) return { response: await translateErrorResponse(anthropicRes), queueWaitMs: 0 };
  if (translated.value.stream) {
    return { response: translateStreamingResponse(anthropicRes, { servedModelId: entry.id }).response, queueWaitMs: 0 };
  }
  const json = await anthropicRes.json();
  const { response } = translateNonStreamingResponse(isRecord(json) ? json : {}, entry.id);
  return { response: Response.json(response), queueWaitMs: 0 };
}

type AttemptOutcome =
  | { kind: 'success'; response: Response; queueWaitMs: number }
  | { kind: 'failed'; response: Response; queueWaitMs: number }
  | { kind: 'not_fallback_eligible'; cause: unknown };

async function runAttempt(
  deps: DispatchDeps,
  entry: ModelEntry,
  requestedModelId: string,
  rawBody: ArrayBuffer,
  headers: Headers,
  tier: Tier,
  clientName: string,
  clientSignal: AbortSignal,
): Promise<AttemptOutcome> {
  try {
    const raw =
      entry.provider === 'ollama'
        ? await attemptOllama(deps, entry, requestedModelId, rawBody, headers, tier, clientName, clientSignal)
        : entry.provider === 'openai'
          ? await attemptOpenAi(deps, entry, requestedModelId, rawBody, headers, clientSignal)
          : await attemptAnthropic(deps, entry, rawBody, headers, clientSignal);
    return raw.response.ok
      ? { kind: 'success', response: raw.response, queueWaitMs: raw.queueWaitMs }
      : { kind: 'failed', response: raw.response, queueWaitMs: raw.queueWaitMs };
  } catch (thrown) {
    if (thrown instanceof Preempted || clientSignal.aborted) return { kind: 'not_fallback_eligible', cause: thrown };
    // A genuine failure (network error, non-abort timeout): fallback-eligible.
    // Not toOpenAiErrorResponse() here deliberately — that helper treats any
    // AbortError as "client disconnected", which would be wrong in this
    // branch specifically (we've just confirmed the client is still there).
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      kind: 'failed',
      response: Response.json({ error: { message, type: 'api_error', param: null, code: null } }, { status: 502 }),
      queueWaitMs: 0,
    };
  }
}

function servedBy(entry: ModelEntry): { provider: UpstreamName; upstreamModel: string } {
  return { provider: entry.provider, upstreamModel: entry.upstreamModel };
}

export async function dispatch(
  deps: DispatchDeps,
  requestedModelId: string,
  rawBody: ArrayBuffer,
  headers: Headers,
  tier: Tier,
  clientName: string,
  clientSignal: AbortSignal,
): Promise<DispatchOutcome> {
  const entry = deps.registry.byId.get(requestedModelId);
  if (entry === undefined) throw new UnknownModelError(requestedModelId);

  const primary = await runAttempt(deps, entry, requestedModelId, rawBody, headers, tier, clientName, clientSignal);
  if (primary.kind === 'not_fallback_eligible') throw primary.cause;
  if (primary.kind === 'success') {
    return { response: primary.response, servedBy: servedBy(entry), fellBack: false, queueWaitMs: primary.queueWaitMs };
  }

  const fallbackId = entry.fallback ?? deps.registry.defaultFallback;
  const fallbackEntry = fallbackId === entry.id ? undefined : deps.registry.byId.get(fallbackId);
  if (fallbackEntry === undefined) {
    // No usable fallback (self-referential default, or none configured):
    // surface the primary's own failure as final.
    return { response: primary.response, servedBy: servedBy(entry), fellBack: false, queueWaitMs: primary.queueWaitMs };
  }

  const fallback = await runAttempt(deps, fallbackEntry, requestedModelId, rawBody, headers, tier, clientName, clientSignal);
  if (fallback.kind === 'not_fallback_eligible') throw fallback.cause;
  // Whatever the fallback produced — success or failed — is final. One hop, full stop.
  return { response: fallback.response, servedBy: servedBy(fallbackEntry), fellBack: true, queueWaitMs: fallback.queueWaitMs };
}
