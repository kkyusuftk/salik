# Salik — self-hosted LLM gateway

## Context

Five projects on this Mac mini call language models, and each has independently reinvented the same infrastructure — badly, because none of them can see the others:

- **`trip-agent/src/gate.mjs`** infers whether the portfolio agent is using Ollama by shelling out to `lsof -nP -iTCP@127.0.0.1:11434 -sTCP:ESTABLISHED`, tailing `~/Library/Logs/portfolio/caddy.log`, and firing a 1-token canary probe. It exists because Ollama serves same-model requests serially (measured 2.01× for two concurrent calls) and the portfolio agent has a 90s user-facing budget.
- **`job-agent/src/llm.mjs`** implements Anthropic↔Ollama provider fallback for itself; **`portfolio/.../AgentService.java`** implements local↔OpenAI↔Anthropic fallback separately, in Java.
- `ANTHROPIC_API_KEY` lives in at least three places (`portfolio/backend/.env.local`, `job-agent/config/keys.json`, the ambient environment). Only the portfolio backend counts tokens, and nothing anywhere records cost.

The `lsof` heuristic is also on a countdown: `gate.mjs:75` `otherClients()` discriminates callers by PID, which stops working the moment every project shares one connection pool. Any gateway makes the current signal actively wrong, so this is a replace-not-add change.

**Salik** (Dubai's toll-gate system; Arabic *sālik*, "passing through") is the single barrier every model request passes under: one endpoint, priority-aware access to the serial local model, centralised cloud keys, and per-request cost metering.

## Decisions taken

| Decision | Choice |
|---|---|
| API surface | All three, passthrough: OpenAI-compat, Ollama-native, Anthropic. Clients migrate by changing one base URL. |
| Cloud keys | Salik holds them; clients get scoped Salik tokens. |
| Priority | Salik owns the queue and preempts; `gate.mjs` is deleted. |
| Logging | Metadata + tokens + cost always; bodies only on an explicit debug flag. |
| Runtime | **Bun** + **Hono**, in **TypeScript** under `strict`. Bun runs `.ts` natively, serves Hono through `Bun.serve()` with no adapter, and ships `bun:sqlite` — so no build step and one runtime dependency. |
| Port | **4749**, next in the established 474x block (4747 job-agent, 4748 trip-agent). Bind `0.0.0.0` so Tailscale clients work, with token auth mandatory on every request. |

## Architecture

```
portfolio (Java)  ─┐
job-agent  (Node) ─┤
trip-agent (Node) ─┼──► Salik :4749 ──┬──► Ollama 127.0.0.1:11434  (serial, 1 slot, preemptible)
receipt-analyzer ─┘   auth → route →  ├──► api.anthropic.com       (parallel, budget-capped)
                      queue → meter   └──► api.openai.com          (parallel, budget-capped)
                                       │
                                       └──► data/salik.db (requests, spend)
```

**The core invariant:** exactly one in-flight request to Ollama at a time. Cloud upstreams are not queued — they parallelise fine — but every request of any kind is authenticated, metered, and logged.

### Middleware chain

Hono's onion model maps cleanly onto what a gateway does, and gives the later auth/session work somewhere to land:

```
requestId → logger → auth → budget → route handler → queue → upstream
                       └──────── meter (records on the way out) ────────┘
```

| Middleware | Source | Job |
|---|---|---|
| `requestId` | `hono/request-id` | Correlation ID into the log line, the DB row, and the response header |
| `logger` | `hono/logger` | Timestamped line to `data/salik.log` |
| `auth` | ours, over `hono/bearer-auth` | Resolves token → `{ client, tier, budget }` onto `c.set()` |
| `budget` | ours | 402 when the client is over its daily cap |
| `meter` | ours | Wraps the handler; writes the `requests` row after the response resolves |

Ours are ~30 lines each. The point of adopting Hono is that when session auth or a browser-facing status dashboard arrives, they slot into this chain instead of being retrofitted into a `switch` statement — `hono/jwt`, `hono/cookie`, and `hono/cors` are first-party and drop straight in.

### Type strategy — where types help, and where they must stop

Types earn their place on Salik's **own** state, which is where the subtle bugs live:

- `Tier` and the queue state machine as discriminated unions, so an unhandled preemption case is a compile error rather than a stuck slot.
- Hono's typed context: `new Hono<{ Variables: { client: Client; tier: Tier; requestId: string } }>()` makes `c.get('client')` checked instead of `any`. This is the main reason Hono + TS is better than either alone.
- Row shapes out of `bun:sqlite` (whose `query<T>()` is generic, so rows come back typed rather than `any`), price-table entries, and the parsed `config/*.json` — all validated once at startup and typed thereafter.

**And they stop hard at the request body.** Salik must never declare an interface for an upstream request or response payload. A typed `ChatRequest` is a *liability*: it invites `JSON.parse` → object → `JSON.stringify`, which drops the fields the type doesn't know about — precisely the `format`, `think:false`, `reasoning_effort` fields your own code warns not to touch. Bodies are `Buffer` in, `Response` out. The only typed view of a body is a deliberately narrow `{ model?: unknown }` read for routing and pricing, taken from a **copy**.

`tsconfig.json` runs `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, with `types: ["bun-types"]`. Bun transpiles rather than strips, so there's no `erasableSyntaxOnly` restriction — `enum` and parameter properties would work. We still avoid them and use `as const` objects with derived union types, both because it's the better pattern and because it keeps the code portable if Salik ever has to run somewhere without Bun. Bun does **not** type-check on execution, so `tsc --noEmit` remains a separate gate.

### Passthrough safety under Hono

The one real risk Hono introduces is convenience methods that break byte-exact forwarding. Two rules, both enforced by tests:

- **Never call `c.req.json()` on a request being forwarded.** Use `await c.req.arrayBuffer()` to get the raw bytes, `JSON.parse` a *copy* purely to read `model` for routing and pricing, then forward the **original buffer**. Parsing and re-serialising reorders keys and reformats numbers, and risks dropping fields Salik doesn't know about — the exact failure `trip-agent/src/llm.mjs:16-21` warns against.
- **Return the upstream `Response` directly.** Hono hands the `Response` to `Bun.serve()`, which pipes the body without buffering. Do not read it into a string first, and do not add compression middleware — that is the same class of bug that made `portfolio-ops/Caddyfile` need `flush_interval -1`.

Hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`) are stripped in both directions by a small shared helper, and `c.req.raw.signal` is composed with the queue's abort signal via `AbortSignal.any` — so a client disconnect aborts the upstream call and frees the Ollama slot instead of leaving it held by a closed tab.

### Priority and preemption

Each client token carries a tier. Only one local slot exists; the queue is a priority queue, not FIFO.

| Tier | Clients | Behaviour |
|---|---|---|
| `interactive` | portfolio agent | Preempts anything running. Never queued behind batch work. |
| `chat` | trip-agent web, receipt-analyzer | Waits for interactive; preempts batch. |
| `batch` | trip-agent worker, job-agent triage/scoring | Yields to everything. |

When a higher-tier request arrives while a lower-tier one holds the slot, Salik aborts the upstream `fetch` to Ollama (which frees the model in ~50ms, per `trip-agent/src/llm.mjs:9-12`) and returns to the preempted client:

```
HTTP 409  {"error": {"type": "salik_preempted", "message": "..."}}
```

This is the wire form of trip-agent's existing `Preempted` class (`src/llm.mjs:27`). It matters that it is distinguishable from a genuine failure: `worker.mjs:362` deliberately does **not** consume a retry attempt on a yield, and that behaviour has to survive the migration.

### API surfaces — passthrough, not normalisation

Three routers over one core. Salik does not translate between formats; it authenticates, queues, forwards the body largely intact, and records usage from the response.

| Path | Format | Notes |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI-compat | Must preserve `tools`, `image_url` data URLs, `reasoning_effort`, `max_completion_tokens`. Used by trip-agent vision, receipt-analyzer, portfolio's `OpenAiRunner`. |
| `POST /api/chat` | Ollama-native | Must preserve `format` (JSON-schema) and `think: false` verbatim. |
| `GET /api/tags`, `/api/ps`, `/api/version` | Ollama-native | Health probes — `job-agent/src/cli.mjs:180`, `trip-agent/src/llm.mjs:130`, `portfolio-ops/install-hybrid.sh`. |
| `POST /v1/messages` | Anthropic | So `@anthropic-ai/sdk` and `anthropic-java` work with only a `baseURL` change. |
| `GET /api/salik/status` | Salik's own | Queue depth, current holder, today's spend, per-client totals. |

Two constraints are non-negotiable and both are documented in your own code:

1. **`think: false` / `reasoning_effort: "none"` is a correctness fix, not a speed knob.** `trip-agent/src/llm.mjs:55-64` records a truncated figure (`AED 474.` vs the correct `AED 474.01`) without it. Salik must pass these through untouched, never strip them as vendor noise.
2. **The vision path's exact shape is load-bearing.** `trip-agent/src/llm.mjs:16-21` says *"Don't 'improve' this for the vision path"* — it was measured at 10/10 in `receipt-analyzer/spike-vision-accuracy.py`. Passthrough, byte for byte.

### Auth

Per-client bearer tokens in `config/keys.json` (gitignored, `chmod 600`, with a committed `.example`), following the `job-agent`/`trip-agent` convention:

```json
{ "clients": [
  { "token": "…", "name": "portfolio",        "tier": "interactive", "dailyBudgetUsd": 2.00 },
  { "token": "…", "name": "trip-agent-web",   "tier": "chat",        "dailyBudgetUsd": 0.50 },
  { "token": "…", "name": "trip-agent-worker","tier": "batch",       "dailyBudgetUsd": 0.50 },
  { "token": "…", "name": "job-agent",        "tier": "batch",       "dailyBudgetUsd": 1.00 }
]}
```

Every client already sends a placeholder `Authorization: Bearer local` (trip-agent `llm.mjs:41`, receipt-analyzer line 95) or `"ollama-local"` (`portfolio-ops/bench-model.sh`), so real tokens drop into an existing slot with zero code restructuring.

### Metering

SQLite at `data/salik.db` (`node:sqlite`, built into Node 26 — no dependency):

- `requests` — id, ts, client, tier, surface, upstream, model, status, latency_ms, queue_wait_ms, preempted, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
- `daily_spend` — client, date, cost_usd (for budget enforcement; 402 when a client exceeds its cap)

Cost comes from a table in `config/pricing.json`, per million tokens, verified against Anthropic's current published rates:

| Model | Input | Output |
|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 |
| `claude-opus-4-8` | $5.00 | $25.00 |
| `claude-sonnet-5` | $3.00 | $15.00 |
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `claude-fable-5` | $10.00 | $50.00 |
| local (`gemma4:12b` etc.) | $0.00 | $0.00 — metered in tokens and seconds only |

⚠️ `claude-sonnet-5` is on introductory pricing of **$2.00/$10.00 through 2026-08-31** — sixteen days from now. Pricing entries carry an optional `until` date and Salik falls back to the standard rate after it, so the table doesn't silently under-report from September.

Cache tokens price differently (reads ~0.1×, writes 1.25×) and `job-agent/src/llm.mjs` already uses `cache_control`, so the cost function reads `cache_read_input_tokens` / `cache_creation_input_tokens` rather than folding them into plain input.

### Logging

- **Always:** one row per request in SQLite (metadata above). Timestamped stdout line to `data/salik.log`, matching `trip-agent/src/worker.mjs:31`.
- **Bodies only on request:** client config `debug: true`, or the header `X-Salik-Debug: 1`. Written to `data/bodies/YYYY-MM-DD.jsonl`, `chmod 600`, pruned after `bodyRetentionDays` (default 3).

This default is deliberate: your traffic carries passport, visa, and receipt images (trip-agent extract paths) and job-application text. Bodies-by-default would turn `data/salik.db` into a store of your identity documents.

## Files

New repo `~/Projects/salik`, following the Gen-2 agent convention (ops inside the repo, data gitignored) rather than the older split-out `portfolio-ops` pattern:

```
salik/
  server/server.ts           entry: Hono app, serve(), pidfile
  src/types.ts               Tier, Client, QueueState, PriceEntry, RequestRow
  src/routes/openai.ts       /v1/chat/completions
  src/routes/ollama.ts       /api/chat, /api/tags, /api/ps, /api/version
  src/routes/anthropic.ts    /v1/messages
  src/routes/status.ts       /api/salik/status
  src/middleware/auth.ts     token → client/tier/budget on the typed context
  src/middleware/budget.ts   daily cap enforcement (402)
  src/middleware/meter.ts    writes the requests row on the way out
  src/queue.ts               priority queue + single local slot + preemption
  src/upstream.ts            forward + abort plumbing + hop-by-hop header stripping
  src/pricing.ts             usage extraction per surface, cost with `until` dates
  src/db.ts                  bun:sqlite schema + migrations
  tsconfig.json              strict, bun-types
  bunfig.toml                test config
  config/settings.json       port, upstreams, tiers, timeouts, retention  (committed)
  config/pricing.json        price table with `until` dates              (committed)
  config/keys.json           client tokens                     (gitignored, 600)
  config/keys.json.example                                      (committed)
  ops/com.yusufkhan.salik.gateway.plist
  ops/install.sh             copied from trip-agent/ops/install.sh
  data/                      salik.db, salik.log, bodies/, salik.lock  (gitignored)
  tests/fake-upstreams.ts    extends trip-agent/tests/fake-ollama.mjs
```

`package.json` carries **one runtime dependency** — `hono`, which has none of its own — plus `typescript` and `bun-types` as devDependencies. Everything else is built into Bun: `bun:sqlite` for the database, `Bun.serve()` for the listener, native `fetch` for upstreams, `bun test` for tests. Bun also ships `Bun.password` (argon2id), which is what the coming session work will hash against — no bcrypt dependency later.

**No build step, and no `dist/`.** launchd runs `bun server/server.ts` directly. This preserves the property that makes your other services easy to operate — what's on disk is what runs, so there's no stale-artifact failure mode of the kind `portfolio-ops/deploy.sh` documents for the JVM.

Conventions carried over verbatim from what already works here:

- `ops/install.sh` is modelled on `trip-agent/ops/install.sh` — including its poll loop after `launchctl bootout`, which is asynchronous and otherwise fails the immediate `bootstrap` with "Input/output error 5".
- The plist uses absolute paths throughout — `/opt/homebrew/bin` is not on launchd's PATH — and sets `EnvironmentVariables.PATH` the same way the trip-agent plists do. `ProgramArguments` is `/opt/homebrew/bin/bun server/server.ts`.
- Bun brings its own version-pinning problem, and it's worth naming: unlike Node there's no `node@26`-style versioned keg, so `brew upgrade` moves Bun under a running Salik. Mitigation is `brew pin bun`, recorded in `ops/install.sh` so it isn't lost. Since Salik becomes the chokepoint for every model call on this machine, an unattended runtime upgrade is the one failure that takes everything down at once.
- `KeepAlive true`, `RunAtLoad true`, `ProcessType Interactive`, heavy XML comments explaining each key, matching your existing plists.
- A pidfile at `data/salik.lock` so a stray manual run exits instead of competing with the launchd copy.

## Build order

**Phase 1 — Salik standalone.** First step: create `~/Projects/salik/` and copy this plan into it as `PLAN.md`, so it's a durable project doc rather than a plan-mode scratch file. Then Bun — **not currently installed** on this machine (`which bun` → not found) — so `brew install oven-sh/bun/bun` followed by `brew pin bun`. Then `bun add hono` and `bun add -d typescript bun-types`, and build and run Salik alongside the existing setup; nothing migrates yet.

This adds a second JavaScript runtime to the mini — trip-agent, job-agent, and the portfolio tunnel scripts all stay on Node 26. That's an accepted cost rather than an oversight: Salik is self-contained, shares no code with them, and the two runtimes never load the same process. Worth revisiting only if a future service wants to share modules across the boundary. Verify against `tests/fake-upstreams.mjs` and by hand against the real Ollama. Add a newsyslog drop-in for `data/*.log` modelled on `portfolio-ops/newsyslog-portfolio.conf` (5 MB, keep 7, `GN`) — neither job-agent nor trip-agent rotates its logs today and both just grow.

**Phase 2 — migrate clients, one per step, verifying each before the next.** Order chosen so the riskiest change lands last:

1. **receipt-analyzer** — one constant (`spike-vision-accuracy.py:20`). Throwaway spike; safest possible smoke test of the OpenAI-compat surface.
2. **trip-agent** — point `config/settings.json` `ollama.url` at Salik, add the token, **delete `src/gate.mjs`** and its callers in `worker.mjs`, map `Preempted` onto the 409. This is where the real win lands: three fragile signals replaced by one authoritative queue.
3. **job-agent** — `config/settings.json` `llm.ollamaUrl` and `triage.url`; move `anthropicApiKey` out of `config/keys.json` and set the SDK `baseURL` to Salik.
4. **portfolio** — `AGENT_LOCAL_BASE_URL` in `portfolio-ops/run-backend.sh`, plus `OPENAI_BASE_URL`; note `AgentService.java:187` hardcodes `"https://api.openai.com"` on the fallback path and needs a real edit, not just an env change. Highest risk (public-facing, `deploy.sh` restart dance) — do it last, once Salik has proven itself on the other three.

`fare-dash` makes no model calls at all and is out of scope.

## Two things to decide before Phase 2

1. **`portfolio-ops/com.yusuf.ollama.plist` was written but never installed.** It is absent from `/Library/LaunchDaemons/` and `launchctl print system/com.yusuf.ollama` reports NOT LOADED. Ollama is instead running under the Homebrew agent without `OLLAMA_KEEP_ALIVE=-1`, so `curl 127.0.0.1:11434/api/ps` currently returns `{"models":[]}` — nothing resident, and the next caller pays a cold 7.6 GB load. Salik's preemption assumes a warm model; preempting a request that is mostly model-load time wastes the load rather than freeing the GPU. I'd install that daemon before Phase 2, but it replaces the brew agent and restarts Ollama, so it's your call.
2. **`portfolio/app.js:223` says `claude-opus-5` while `AgentService.java:31` and `index.html:188,205` say `claude-sonnet-5`.** Cosmetic today; once Salik meters per model it becomes a visible discrepancy between the badge and the bill. Worth fixing during step 4.

## Verification

**Phase 1, before any client moves:**

```bash
cd ~/Projects/salik && bunx tsc --noEmit && bun test
```

Type-checking is a separate step from running — Bun transpiles without verifying types, so `tsc --noEmit` has to gate the tests rather than being implied by them.

Covers: token rejection (401), tier ordering, preemption returning 409 with `salik_preempted`, cost arithmetic including cache tokens and the Sonnet 5 `until` date rollover, and budget cap returning 402.

**The load-bearing test is byte-exactness through the Hono layer.** `tests/fake-upstreams.mjs` (extending the existing `trip-agent/tests/fake-ollama.mjs` contract) captures the raw request body it receives and asserts it is byte-identical to what the client sent — for an Ollama `format` schema, `think:false`, a `reasoning_effort` vision call, and a multi-megabyte base64 `image_url`. This is the regression test that catches anyone reaching for `c.req.json()` later. A second test asserts a streamed SSE response arrives in multiple chunks rather than one buffered blob, and a third asserts a client abort mid-stream releases the queue slot within 200 ms.

**Against the real service:**

```bash
curl -s -H "Authorization: Bearer $SALIK_TOKEN" http://127.0.0.1:4749/api/tags
```

```bash
curl -s -H "Authorization: Bearer $SALIK_TOKEN" http://127.0.0.1:4749/api/salik/status
```

**Preemption end-to-end** — start a long batch-tier generation, fire an interactive-tier request while it runs, and confirm the batch call returns 409 `salik_preempted` within ~1s while the interactive one completes normally. Then check `/api/salik/status` shows the preemption recorded and `data/salik.db` has both rows with correct `queue_wait_ms`.

**Per-client verification during Phase 2** — after each client moves, run that project's own suite (`trip-agent` and `job-agent` both have one) and confirm `/api/salik/status` shows traffic under the expected client name and tier. Specifically for trip-agent: run the worker against a real document and confirm a preemption does **not** increment `attempts`, matching the pre-migration `worker.mjs:362` behaviour.

**Restart safety:**

```bash
launchctl kickstart -k gui/$(id -u)/com.yusufkhan.salik.gateway
```

Then re-run the status curl and confirm the in-flight queue drained cleanly and the pidfile was replaced rather than duplicated.
