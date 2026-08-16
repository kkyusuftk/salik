// Forward + abort plumbing + hop-by-hop header stripping. This is the one
// module allowed to touch bytes on their way to/from an upstream, and even it
// never parses or re-serialises the body — see PLAN.md's "Passthrough safety
// under Hono".

const REQUEST_HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'host', // fetch() sets this correctly for the upstream URL
  'content-length', // let fetch() derive it from the actual body we pass
];

const RESPONSE_HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  // fetch() transparently decompresses the wire body before this process
  // ever sees it, so `res.body` is already plain bytes even when the
  // upstream sent gzip. Forwarding content-encoding/content-length unchanged
  // would mislabel those already-decoded bytes and break the client's own
  // decoding — this is the one case where dropping a header is required
  // FOR byte-exactness, not in spite of it.
  'content-encoding',
  'content-length',
];

function withoutHeaders(headers: Headers, drop: readonly string[]): Headers {
  const out = new Headers(headers);
  for (const h of drop) out.delete(h);
  return out;
}

/**
 * Strips hop-by-hop headers plus the client's own inbound credential
 * (`authorization` / `x-api-key`) — that credential was Salik's own auth,
 * already consumed by middleware/auth.ts, and each route sets the real
 * upstream credential explicitly afterwards rather than forwarding it.
 */
export function prepareRequestHeaders(headers: Headers): Headers {
  return withoutHeaders(headers, [...REQUEST_HOP_BY_HOP, 'authorization', 'x-api-key']);
}

export function prepareResponseHeaders(headers: Headers): Headers {
  return withoutHeaders(headers, RESPONSE_HOP_BY_HOP);
}

export interface ForwardRequest {
  method: string;
  url: string;
  /** Already run through prepareRequestHeaders() by the caller, with the real upstream credential added. */
  headers: Headers;
  /** The exact bytes the client sent — never a re-serialised object. `null`/undefined for bodyless requests (GET health probes). */
  body: ArrayBuffer | null | undefined;
  signal: AbortSignal;
}

/**
 * Byte-exact forward. The returned Response's body is the upstream's own
 * (possibly still-streaming) body — do not `.text()` or `.json()` it here,
 * and do not buffer it; Bun.serve() pipes it straight through once a route
 * returns it (or meter.ts tees it for metering — see src/middleware/meter.ts).
 */
export async function forward(req: ForwardRequest): Promise<Response> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body ?? null,
    signal: req.signal,
  });
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: prepareResponseHeaders(res.headers),
  });
}

function isAbortError(err: unknown): boolean {
  // Real fetch() aborts throw a DOMException, which — unlike the errors most
  // of this codebase throws — does not reliably extend Error in every
  // engine, so this checks `.name` directly rather than `instanceof Error`.
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Every route calls this from its own catch block rather than rethrowing —
 * see PLAN.md's queue/preemption section for why a plain rethrow is the
 * wrong move here: Hono's compose() only hands an error to `app.onError` when
 * it's `instanceof Error`, which a DOMException is not guaranteed to be, so a
 * client-disconnect abort rethrown from a route can silently fall through to
 * Hono's own generic 500 instead of the 499 this gateway means to report.
 * Converting it to a Response here, at the point the error is caught, sidesteps
 * that uncertainty entirely.
 */
export function toErrorResponse(err: unknown): Response {
  if (isAbortError(err)) {
    return Response.json({ error: { type: 'salik_client_closed', message: 'client disconnected' } }, { status: 499 });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: { type: 'salik_upstream_error', message } }, { status: 502 });
}
