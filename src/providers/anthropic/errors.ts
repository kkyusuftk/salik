// Anthropic error responses -> OpenAI's own error envelope. Deliberately NOT
// Salik's `salik_upstream_error` shape (src/upstream.ts): the whole point of
// "one interface" is that /v1/chat/completions' error contract shouldn't
// shape-shift based on which backend served the request.
import { Buffer } from 'node:buffer';
import { tryParseJson } from '../../pricing.ts';
import { isRecord } from '../../types.ts';
import { isAbortError } from '../../upstream.ts';
import type { RequestTranslationError } from './request.ts';

interface OpenAiErrorBody {
  error: { message: string; type: string; param: null; code: null };
}

function openAiError(message: string, type: string): OpenAiErrorBody {
  return { error: { message, type, param: null, code: null } };
}

function stringField(obj: Record<string, unknown> | null, key: string, fallback: string): string {
  const v = obj?.[key];
  return typeof v === 'string' ? v : fallback;
}

// 529 keeps its Anthropic `type` string (overloaded_error) but remaps to the
// HTTP status real proxies/clients actually retry on.
const STATUS_OVERRIDES: Partial<Record<number, number>> = { 529: 503 };

/** For a non-2xx response actually received from Anthropic. */
export async function translateErrorResponse(anthropicResponse: Response): Promise<Response> {
  const raw = await anthropicResponse.arrayBuffer();
  const parsed = tryParseJson(Buffer.from(raw).toString('utf8'));
  const anthropicError = isRecord(parsed) && isRecord(parsed['error']) ? parsed['error'] : null;
  const type = stringField(anthropicError, 'type', 'api_error');
  const message = stringField(anthropicError, 'message', 'unknown upstream error');
  const status = STATUS_OVERRIDES[anthropicResponse.status] ?? anthropicResponse.status;

  const headers = new Headers({ 'content-type': 'application/json' });
  const retryAfter = anthropicResponse.headers.get('retry-after');
  if (retryAfter !== null) headers.set('retry-after', retryAfter);

  return new Response(JSON.stringify(openAiError(message, type)), { status, headers });
}

/** For a condition Salik itself hit on this route (network failure, client
 * disconnect) — mirrors src/upstream.ts's toErrorResponse but OpenAI-enveloped. */
export function toOpenAiErrorResponse(err: unknown): Response {
  if (isAbortError(err)) return Response.json(openAiError('client disconnected', 'salik_client_closed'), { status: 499 });
  const message = err instanceof Error ? err.message : String(err);
  return Response.json(openAiError(message, 'api_error'), { status: 502 });
}

/** For translateRequest()'s own rejections — always a client-side 400. */
export function requestErrorToResponse(error: RequestTranslationError): Response {
  return Response.json(openAiError(error.message, 'invalid_request_error'), { status: 400 });
}
