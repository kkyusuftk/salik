# API reference

Base URL: `http://<host>:4749` (port and bind address are `config/settings.json`'s `port`/`host`).

## Auth

Every endpoint requires a bearer token, checked against `config/keys.json`'s `clients` list — including the health probes and `/api/salik/status`, which are exempt from budget enforcement and metering, but not from auth. Either header works:

```
Authorization: Bearer <token>
x-api-key: <token>
```

(`x-api-key` exists because the Anthropic SDKs send that by default — the goal is a client migration that's a base-URL change and nothing else.)

**401** `salik_invalid_api_key` — missing or unrecognised token:

```json
{"error": {"type": "salik_invalid_api_key", "message": "missing or unrecognised token"}}
```

**402** `salik_budget_exceeded` — the client's `dailyBudgetUsd` cap is already spent for the current UTC day:

```json
{"error": {"type": "salik_budget_exceeded", "message": "daily budget of $0.50 exceeded ($0.52 spent today)"}}
```

## The unified endpoint

### `POST /v1/chat/completions`

The one interface: always OpenAI's chat-completions request/response schema (streaming included), regardless of which backend actually serves the request. Which models exist and which backend each maps to is config, not code — see `config/models.json`.

**Model resolution.** The request's `model` field is looked up in the registry:

- Unrecognised → `404 salik_unknown_model`.
- Missing entirely → `400 invalid_request_error`.
- `provider: "ollama"` or `"openai"` → forwarded to that upstream. If the registry's `upstreamModel` for this entry is the same string as the public `id` (true for every model in the shipped `config/models.json`), this is a byte-exact passthrough, identical to how this endpoint behaved before the registry existed. Only a configured *alias* (`upstreamModel` different from `id`) causes Salik to rewrite the `model` field before forwarding — a narrow, deliberate exception scoped to that one field.
- `provider: "anthropic"` → translated to and from Anthropic's Messages API (`src/providers/anthropic/`): system message(s), multi-turn history, tool calls, vision content, and both streaming and non-streaming responses are mapped in both directions. A few OpenAI request fields have no Anthropic equivalent and are rejected outright rather than silently ignored — `logprobs`, `n > 1`, a non-empty `logit_bias`, `response_format` other than `text`, and a non-zero `presence_penalty`/`frequency_penalty` — as a `400 invalid_request_error`. Anthropic's prompt-cache hint (`cache_control`) has no OpenAI-schema field to travel in and is out of scope here; use the native `POST /v1/messages` surface below if you need it.

**Fallback.** Each model may name its own `fallback`; anything that doesn't falls back to `config/models.json`'s single `defaultFallback`. If the primary attempt fails — a non-2xx response, a network error, a timeout — Salik retries **once** against the fallback and returns whatever that produces, success or failure. Two things are never fallback-eligible, because they aren't failures: a `409 salik_preempted` (the request yielded its turn, it didn't fail) and a client disconnect (there's no one left to serve). Fallback also only ever happens before any response bytes reach the client — once a streaming response has actually started, a downstream failure surfaces in-stream, not as a silent provider swap. A response served by the fallback is otherwise ordinary: its `model` field names the fallback's own id (whichever model actually answered), and `GET /api/salik/status`-adjacent tooling can see it happened via the `fell_back`/`requested_model` columns in `data/salik.db`'s `requests` table.

**Errors on this endpoint** are always OpenAI's own envelope shape (`{"error": {"message", "type", "param", "code"}}`), even for Salik-native conditions like `salik_preempted` or `salik_client_closed` — one endpoint, one error contract, regardless of which backend or which failure mode produced it.

### `GET /v1/models`

Lists the configured registry in OpenAI's own `/v1/models` shape:

```json
{
  "object": "list",
  "data": [
    { "id": "claude-sonnet-5", "object": "model", "created": 1786828600, "owned_by": "anthropic" },
    { "id": "gemma4:12b", "object": "model", "created": 1786828600, "owned_by": "ollama" }
  ]
}
```

Auth required; like `/api/salik/status`, not budget-gated and not metered — it's a pure local-config read, not a billable model call.

## Native passthrough surfaces

These three do **not** translate between wire formats — each authenticates, queues (Ollama-bound requests only), forwards the body byte-for-byte, and records usage from the response. Every field a client sends (`tools`, `format`, `think`, `reasoning_effort`, `stream`, image data URLs, …) reaches the upstream untouched. They exist for clients that need a specific provider's own dialect verbatim, and are unaffected by anything above.

### `POST /api/chat`

Ollama-native. Always goes through the priority queue against the local Ollama instance. Preserves `format` (a JSON-schema Ollama enforces) and `think: false` exactly as sent.

On preemption:

```
HTTP 409
{"error": {"type": "salik_preempted", "message": "preempted by a higher-priority request"}}
```

### `GET /api/tags` · `GET /api/ps` · `GET /api/version`

Ollama-native health/metadata probes. Forwarded directly to Ollama — these bypass the queue entirely, since they're metadata reads that never touch the model.

### `POST /v1/messages`

Anthropic. Always forwarded to `https://api.anthropic.com` (or whatever `config/settings.json`'s `upstreams.anthropic.url` says) with Salik's own key attached via `x-api-key`. `anthropic-version` is filled in with a default (`config/settings.json`'s `upstreams.anthropic.defaultVersion`) only if the client didn't send one — a client's own header always wins.

## Salik's own endpoint

### `GET /api/salik/status`

Auth required; **not** budget-gated and **not** metered (checking your own status has to work even over budget, and it isn't a billable call).

```json
{
  "queue": {
    "slot": {"kind": "occupied", "tier": "interactive", "client": "portfolio", "startedAt": 1786828600000},
    "pending": [{"tier": "batch", "count": 2}]
  },
  "today": "2026-08-16",
  "spend": {"totalUsd": 0.0431, "byClient": {"portfolio": 0.0104, "job-agent": 0.0327}},
  "requestsToday": 42
}
```

`queue.slot.kind` is `"idle"` when nothing is running. `spend.byClient` lists every client that made at least one *priced* request today (a genuinely free local model still shows up at `0`; a request with no resolvable model — a health probe — does not appear at all, since there's nothing to attribute).

### `GET /api/salik/usage`

Tokens by hour, read back off the `requests` ledger. Auth required; like `/api/salik/status`, **not** budget-gated and **not** metered — a usage report you can't read once you're over your cap is a report you can't use to find out why, and metering it would make the ledger a record of itself.

| query param | default | meaning |
|---|---|---|
| `hours` | `24` | how far back, 1 to 744 (31 days) |
| `client` | all | only this client's rows |
| `by` | — | `by=client` splits each hour by client instead of totalling it |
| `tz` | `utc` | hour boundaries: `utc`, `local` (the *server's* zone), `+04:00`, `-0530`, or plain minutes east of UTC |

```json
{
  "window": {"hours": 24, "since": "2026-08-17T18:00:00.000Z", "tz": "+04:00", "offsetMinutes": 240},
  "client": null,
  "groupedBy": ["hour"],
  "buckets": [
    {
      "hour": "2026-08-17T20:00", "client": null, "requests": 34,
      "inputTokens": 42012, "cacheReadTokens": 0, "cacheWriteTokens": 0,
      "promptTokens": 42012, "outputTokens": 1194, "totalTokens": 43206,
      "costUsd": 0.0
    }
  ],
  "totals": {"requests": 232, "inputTokens": 251820, "cacheReadTokens": 0, "cacheWriteTokens": 0,
             "promptTokens": 251820, "outputTokens": 12766, "totalTokens": 264586, "costUsd": 0.0}
}
```

- **`promptTokens` is everything the upstream read**: `inputTokens` (fresh) + `cacheReadTokens` (served from its cache) + `cacheWriteTokens`. The three are disjoint — `src/pricing.ts` backs OpenAI's `cached_tokens` out of `prompt_tokens` precisely so they can be priced apart — and they're reported apart because a cached token costs a tenth of a fresh one but is not a tenth of a token. `totalTokens` is `promptTokens + outputTokens`.
- **`hour` is `YYYY-MM-DDTHH:00` in the zone `window.tz` names**, never a bare local guess. An offset moves the boundaries, not just the labels: a 23:30 UTC request files under `03:00` the next day at `tz=+04:00`.
- **Hours with no traffic are absent**, not zero-filled — a gap is silence, and a caller drawing a chart can fill it knowing that.
- **A request whose model has no `pricing.json` entry still counts its tokens**; only its cost is missing, and it contributes `0` to `costUsd`.
- **`hours` or `tz` that can't be honoured is a `400`** (`salik_invalid_request`), never a silent fallback to UTC — a report labelled with the wrong hours looks right, which is the dangerous kind of wrong.

The same numbers on this machine, without a token and without the server running:

```bash
bun run tokens --days 7 --by-client
```

## Errors that aren't specific to one endpoint

| Status | Type | When |
|---|---|---|
| 401 | `salik_invalid_api_key` | Missing/unrecognised token |
| 402 | `salik_budget_exceeded` | Client is over its daily cap |
| 404 | `salik_unknown_model` | `POST /v1/chat/completions` only — the requested `model` isn't in `config/models.json` |
| 409 | `salik_preempted` | A higher-tier request took the local Ollama slot |
| 499 | `salik_client_closed` | The caller disconnected before the upstream responded |
| 502 | `salik_upstream_error` | The upstream call failed for any other reason (network error, timeout, non-2xx surfaced as a thrown error) |

On the three native passthrough surfaces (and `/api/salik/status`), every error body shares the same shape: `{"error": {"type": "...", "message": "..."}}`. On `POST /v1/chat/completions`, errors instead use OpenAI's own envelope — `{"error": {"message", "type", "param", "code"}}`, with `param`/`code` typically `null` — including for the Salik-native `type`s above, so the endpoint's error contract stays uniform regardless of cause (see "The unified endpoint" above).
