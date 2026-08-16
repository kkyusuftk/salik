# Architecture

## The core invariant

Exactly one in-flight request to the local Ollama instance at a time. Ollama serves same-model requests serially — two concurrent calls don't parallelise, the second one just waits behind the first — so anything that queues work locally has to treat the model as a single, exclusive resource rather than something you can fan out against.

Cloud upstreams (Anthropic, OpenAI) are **not** subject to this — they parallelise fine, so requests routed to them never touch the queue at all. The queue in [`src/queue.ts`](../src/queue.ts) exists purely to arbitrate the one thing that can't parallelise.

## Middleware chain

Hono's onion model maps directly onto what a gateway does. The chain, in registration order (see [`src/app.ts`](../src/app.ts)):

```
requestId → logger → auth → budget → route handler → queue (Ollama-bound only) → upstream
                       └──────────── meter (records on the way out) ────────────┘
```

| Middleware | Job |
|---|---|
| `requestId` (`hono/request-id`) | Correlation ID into the log line and the response header |
| `logger` (`hono/logger`, timestamped) | One quick trace line per request, independent of metering |
| `auth` ([`src/middleware/auth.ts`](../src/middleware/auth.ts)) | Resolves a bearer token → `{client, tier}` on the typed context. Accepts both `Authorization: Bearer <token>` and `x-api-key: <token>`, since the Anthropic SDKs default to the latter and the whole point is a base-URL-only client migration |
| `budget` ([`src/middleware/budget.ts`](../src/middleware/budget.ts)) | 402 when the client is over its daily cap. Runs *before* meter, so a refused request is never billed and never gets a `requests` row — there's nothing to meter |
| `meter` ([`src/middleware/meter.ts`](../src/middleware/meter.ts)) | Wraps the route handler: times it, tees the response for usage extraction without buffering the client's own copy, writes one `requests` row always, a debug body only on request |

Auth and budget are scoped to the concrete proxied paths (`/api/chat`, `/v1/chat/completions`, `/v1/messages`, the health probes); `/api/salik/status` gets auth only — checking your own status has to work even when you're over budget, and it isn't a billable model call, so it deliberately skips both budget and meter.

## Priority tiers and preemption

Each client token carries a tier. Only one physical Ollama slot exists; requests to it go through a priority queue, not FIFO.

| Tier | Behaviour |
|---|---|
| `interactive` | Preempts anything running. Never queues behind a lower tier. |
| `chat` | Waits for `interactive`; preempts `batch`. |
| `batch` | Yields to everything. |

When a higher-tier request arrives while a lower-tier one holds the slot, Salik aborts the upstream call in flight and hands the preempted caller a `409`:

```json
HTTP 409
{"error": {"type": "salik_preempted", "message": "preempted by a higher-priority request"}}
```

This is deliberately distinguishable from a genuine failure — callers on the losing end should treat it as "yielded", not "failed", and skip consuming a retry attempt on it.

Mechanically: each running or queued request holds an `AbortController` internal to the queue. A same-or-lower-priority arrival is enqueued (FIFO within its own tier); a strictly-higher-priority arrival aborts whichever `AbortController` the slot currently holds and takes the slot immediately — no queueing. Each route composes that controller's signal with the request's own (client-disconnect) signal via `AbortSignal.any`, and passes the combined signal straight to `fetch`, so either cause frees the slot: a client hanging up mid-stream releases it exactly as fast as a deliberate preemption does.

## Type strategy — where types help, and where they stop

Types earn their place on Salik's **own** state — the `Tier`/`Client`/`QueueState`/pricing/config shapes in [`src/types.ts`](../src/types.ts), all `as const` unions rather than `enum`, validated once at startup (`parseKeysFile`, `parseSettings`, `parsePriceTable`) and typed thereafter. Hono's typed context (`Hono<AppEnv>`) makes `c.get('client')` checked instead of `any`.

They stop hard at the request body. Salik never declares an interface for an upstream request or response payload — a typed shape invites `JSON.parse` → object → `JSON.stringify`, which drops whatever field the type doesn't know about. Bodies are `ArrayBuffer` in, `Response` out. The only typed view of a body is a deliberately narrow `{ model?: string }` read (`readModelHint` in [`src/pricing.ts`](../src/pricing.ts)), taken from a copy, used only for routing and pricing.

`tsconfig.json` runs `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Bun transpiles TypeScript rather than type-checking it at runtime, so `tsc --noEmit` is a separate, mandatory gate — it is not implied by a green test run.

## Passthrough safety

The risk a gateway framework introduces is convenience methods that break byte-exact forwarding. Two rules, both enforced by the test suite:

- **Never call `c.req.json()` on a request being forwarded.** Every route calls `c.req.arrayBuffer()` for the raw bytes, `JSON.parse`s a *copy* purely to read `model` for routing/pricing, then forwards the **original buffer** untouched. Parsing and re-serialising risks reordering keys, reformatting numbers, or dropping a field the code doesn't know about.
- **Return the upstream `Response` directly.** [`src/upstream.ts`](../src/upstream.ts)'s `forward()` hands the upstream's own (possibly still-streaming) body straight through; nothing reads it into a string first, and no compression middleware sits in the path.

Hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, …) are stripped in both directions. One subtlety worth naming: `fetch()` transparently decompresses a gzip-encoded upstream response *before Salik's own code ever sees the bytes* — so the response headers still say `content-encoding: gzip` even though `res.body` is already plain. Forwarding that header unchanged would mislabel the (already-decoded) bytes actually being piped to the client, so `content-encoding`/`content-length` are stripped from the response direction specifically for this reason — the one case where dropping a header is required *for* byte-exactness, not in spite of it.

## Metering and logging

Two independent things happen on the way out of every proxied request:

1. **Always:** one row in `requests` (`data/salik.db`) — client, tier, surface, upstream, model, status, latency, queue wait, whether it was preempted, token usage (input/output/cache-read/cache-write), and cost. A timestamped line to stdout (captured to `data/salik.log` under launchd).
2. **Only on request:** the client's own `debug: true` in `config/keys.json`, or the header `X-Salik-Debug: 1`. Writes request + response bodies (base64) to `data/bodies/YYYY-MM-DD.jsonl`, `chmod 600`, pruned after `bodyRetentionDays` (default 3). This is opt-in on purpose — bodies-by-default would turn the metering db into a store of whatever's in the traffic.

Cost comes from [`config/pricing.json`](../config/pricing.json): per-million-token rates, with cache reads priced at 0.1× and cache writes at 1.25× the input rate. A model can carry several chronological rate periods (an introductory price that rolls over to a standing one on a fixed date); the last period for any model must be open-ended. A model with **no** pricing entry gets `cost_usd: null` — deliberately distinct from `0`, so an unpriced cloud model is never silently reported as free the way a genuinely-free local model is.
