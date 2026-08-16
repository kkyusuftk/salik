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

## The unified endpoint: registry, dispatch, and fallback

`POST /v1/chat/completions` is Salik's one true interface: every model configured in [`config/models.json`](../config/models.json) is reachable here, and the request/response are always OpenAI's own chat-completions schema — regardless of whether the model is actually backed by Ollama, OpenAI, or Anthropic. This is a deliberate, narrow exception to "passthrough, not normalisation" below, scoped to exactly this one route; the three native surfaces above are untouched.

### The model registry

[`config/models.json`](../config/models.json) replaces the old `upstreams.openai.localModels` string-allowlist with a real registry: each entry names a public `id`, which `provider` (`ollama` | `openai` | `anthropic`) owns it, the real `upstreamModel` string to send, and an optional per-model `fallback`. A single `defaultFallback` covers any model that doesn't name its own. `parseModelRegistry` ([`src/types.ts`](../src/types.ts)) validates this once at startup — the same discipline as `parseSettings`/`parseKeysFile`/`parsePriceTable` — rejecting a dangling or self-referential `fallback` before the server ever starts. It does not chase longer cycles: dispatch only ever takes one hop, so a cycle three nodes deep can never actually be walked into at runtime.

### Dispatch and fallback

[`src/dispatch.ts`](../src/dispatch.ts) resolves the request's `model` against the registry and attempts it:

- `ollama`/`openai`-mapped models are pure passthrough, identical to how this route always worked — byte-exact, provided the registry's `upstreamModel` matches the public `id` (true for every shipped model). Only a configured alias causes a narrow, one-field parse-mutate-reserialize before forwarding, exactly as scoped and justified as `readModelHint`'s exception below.
- `anthropic`-mapped models go through [`src/providers/anthropic/`](../src/providers/anthropic/) (below).

If the attempt fails — a non-2xx response, a network error, a timeout — dispatch tries the model's `fallback` (or `defaultFallback`) exactly **once**, and whatever that produces, success or failure, is final. Two things are explicitly never fallback-eligible, because neither is a failure:

- **`Preempted`** — yielded, not failed. Falling back would silently let a batch-tier job buy cloud capacity instead of waiting its turn, defeating the point of the priority queue above.
- **A client disconnect** — there's no one left to serve.

"Pre-first-byte-only" needs no separate bookkeeping: dispatch only ever hands the route a `Response` once it has committed to it (`fetch()` resolving `.ok`, before any body bytes are read), and Bun/Hono never starts streaming to the real client any earlier than that — so "did we already send bytes" and "did dispatch already commit" are the same question.

A fallback is never silent: the served response's `model` field names whichever model actually answered (the fallback's own id, not the one requested), and every request row in `data/salik.db` carries `requested_model` (what the client asked for) alongside `model` (what actually served it) and a `fell_back` flag — see "Metering and logging" below.

### The Anthropic translator

[`src/providers/anthropic/`](../src/providers/anthropic/) translates both directions, streaming and non-streaming, between OpenAI's chat-completions wire format and Anthropic's Messages API: system messages, multi-turn history (tool results folded into Anthropic's required user/assistant alternation), tool calls, vision content, and — for streaming — a `TransformStream` pipeline that reassembles Anthropic's line-buffered SSE into OpenAI-shaped delta chunks, always terminated by a `[DONE]` sentinel even on a dropped connection. A few OpenAI request fields have no faithful Anthropic equivalent (`logprobs`, `n > 1`, a non-empty `logit_bias`, non-text `response_format`, a non-zero `presence_penalty`/`frequency_penalty`) and are rejected with `400 invalid_request_error` rather than silently approximated; Anthropic's `cache_control` prompt-cache hint has no OpenAI-schema slot to travel in at all and is out of scope here — job-agent's own client-side use of it is unaffected, since it goes through the native `POST /v1/messages` surface instead.

Errors on this endpoint are always reshaped into OpenAI's own envelope (`{"error": {"message", "type", "param", "code"}}`) — including Salik-native conditions like `salik_preempted` — so the endpoint's error contract doesn't shape-shift based on which backend actually served (or failed) the request.

## Type strategy — where types help, and where they stop

Types earn their place on Salik's **own** state — the `Tier`/`Client`/`QueueState`/pricing/config shapes in [`src/types.ts`](../src/types.ts), all `as const` unions rather than `enum`, validated once at startup (`parseKeysFile`, `parseSettings`, `parsePriceTable`) and typed thereafter. Hono's typed context (`Hono<AppEnv>`) makes `c.get('client')` checked instead of `any`.

They stop hard at the request body. Salik never declares an interface for an upstream request or response payload — a typed shape invites `JSON.parse` → object → `JSON.stringify`, which drops whatever field the type doesn't know about. Bodies are `ArrayBuffer` in, `Response` out. The only typed view of a body is a deliberately narrow `{ model?: string }` read (`readModelHint` in [`src/pricing.ts`](../src/pricing.ts)), taken from a copy, used only for routing and pricing.

One more, larger exception lives in [`src/providers/anthropic/`](../src/providers/anthropic/): it types the Anthropic request it *constructs* and the OpenAI response it *constructs* — never a body being forwarded, so there's no byte-exactness between two different wire formats to preserve. Its own types stay narrow (only the fields actually translated), and anything unrecognized is a named, documented drop or a hard `400` — never a silent pass-through of something that wasn't really translated. See "The unified endpoint" above.

`tsconfig.json` runs `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Bun transpiles TypeScript rather than type-checking it at runtime, so `tsc --noEmit` is a separate, mandatory gate — it is not implied by a green test run.

## Passthrough safety

The risk a gateway framework introduces is convenience methods that break byte-exact forwarding. Two rules, both enforced by the test suite:

- **Never call `c.req.json()` on a request being forwarded.** Every route calls `c.req.arrayBuffer()` for the raw bytes, `JSON.parse`s a *copy* purely to read `model` for routing/pricing, then forwards the **original buffer** untouched. Parsing and re-serialising risks reordering keys, reformatting numbers, or dropping a field the code doesn't know about.
- **Return the upstream `Response` directly.** [`src/upstream.ts`](../src/upstream.ts)'s `forward()` hands the upstream's own (possibly still-streaming) body straight through; nothing reads it into a string first, and no compression middleware sits in the path.

Hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, …) are stripped in both directions. One subtlety worth naming: `fetch()` transparently decompresses a gzip-encoded upstream response *before Salik's own code ever sees the bytes* — so the response headers still say `content-encoding: gzip` even though `res.body` is already plain. Forwarding that header unchanged would mislabel the (already-decoded) bytes actually being piped to the client, so `content-encoding`/`content-length` are stripped from the response direction specifically for this reason — the one case where dropping a header is required *for* byte-exactness, not in spite of it.

These two rules hold everywhere except one place: `POST /v1/chat/completions`'s `anthropic`-mapped models, which never forward a body at all — they construct one in a different wire format via [`src/providers/anthropic/`](../src/providers/anthropic/). That route's `ollama`/`openai`-mapped models (and all three native surfaces above) still follow both rules exactly as described — see "The unified endpoint" above for the one narrow, additional exception (a configured model alias) that can also touch a forwarded body's `model` field.

## Metering and logging

Two independent things happen on the way out of every proxied request:

1. **Always:** one row in `requests` (`data/salik.db`) — client, tier, surface, upstream, model, requested model, status, latency, queue wait, whether it was preempted, whether it was served by a fallback, token usage (input/output/cache-read/cache-write), and cost. `requested_model`/`fell_back` exist purely for operator visibility ("my Anthropic key expired and everything's quietly routing through Haiku"), not billing — a pre-first-byte fallback spends nothing on the failed attempt, so there's nothing else to account for. On the three native surfaces, `requested_model` always equals `model` and `fell_back` is always `false`, since neither ever falls back. A timestamped line to stdout (captured to `data/salik.log` under launchd).
2. **Only on request:** the client's own `debug: true` in `config/keys.json`, or the header `X-Salik-Debug: 1`. Writes request + response bodies (base64) to `data/bodies/YYYY-MM-DD.jsonl`, `chmod 600`, pruned after `bodyRetentionDays` (default 3). This is opt-in on purpose — bodies-by-default would turn the metering db into a store of whatever's in the traffic.

Cost comes from [`config/pricing.json`](../config/pricing.json): per-million-token rates, with cache reads priced at 0.1× and cache writes at 1.25× the input rate. A model can carry several chronological rate periods (an introductory price that rolls over to a standing one on a fixed date); the last period for any model must be open-ended. A model with **no** pricing entry gets `cost_usd: null` — deliberately distinct from `0`, so an unpriced cloud model is never silently reported as free the way a genuinely-free local model is.
