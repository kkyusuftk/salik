# API reference

Base URL: `http://<host>:4749` (port and bind address are `config/settings.json`'s `port`/`host`).

## Auth

Every endpoint except the health probes and status requires a bearer token, checked against `config/keys.json`'s `clients` list. Either header works:

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

## Passthrough surfaces

Salik does not translate between wire formats — it authenticates, queues (Ollama-bound requests only), forwards the body byte-for-byte, and records usage from the response. Every field a client sends (`tools`, `format`, `think`, `reasoning_effort`, `stream`, image data URLs, …) reaches the upstream untouched.

### `POST /v1/chat/completions`

OpenAI-compatible. Routes to one of two upstreams based on the request's `model` field:

- A name listed in `config/settings.json`'s `upstreams.openai.localModels` → forwarded to the local Ollama instance's own OpenAI-compat endpoint, through the priority queue.
- Anything else → forwarded to the real OpenAI API with Salik's own `OPENAI_API_KEY`-equivalent (`config/keys.json`'s `upstreamKeys.openai`) attached.

Request body: whatever your OpenAI client sends — `messages`, `tools`, `stream`, `reasoning_effort`, `max_completion_tokens`, image `image_url` data URLs, etc. Response: the upstream's response, forwarded as-is (streamed if the upstream streams).

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

## Errors that aren't specific to one endpoint

| Status | Type | When |
|---|---|---|
| 401 | `salik_invalid_api_key` | Missing/unrecognised token |
| 402 | `salik_budget_exceeded` | Client is over its daily cap |
| 409 | `salik_preempted` | A higher-tier request took the local Ollama slot |
| 499 | `salik_client_closed` | The caller disconnected before the upstream responded |
| 502 | `salik_upstream_error` | The upstream call failed for any other reason (network error, timeout, non-2xx surfaced as a thrown error) |

All error bodies share the same shape: `{"error": {"type": "...", "message": "..."}}`.
