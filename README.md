# salik

A self-hosted LLM gateway. One HTTP endpoint in front of a local Ollama instance and your Anthropic/OpenAI accounts, so every project on a machine shares one authenticated, metered, priority-aware door instead of each reinventing its own.

**Salik** — Dubai's toll-gate system; Arabic *sālik*, "passing through."

## Why

Run more than one LLM-backed project against a single local model and you hit the same wall every time: Ollama serves one model's requests **serially** — two concurrent calls don't parallelise, one just waits behind the other. Left alone, every project ends up growing its own ad-hoc fix: a heuristic to guess whether the model is busy, its own copy of the cloud API keys, no shared view of what anything actually costs.

Salik centralises that instead of letting it multiply:

- **One endpoint, three wire formats** — OpenAI-compatible, Ollama-native, and Anthropic passthrough. Point an existing client at Salik's base URL and nothing else about its request/response code has to change.
- **A real priority queue over the one local slot** — every client is tagged with a tier; a higher-tier request preempts a lower-tier one instead of queueing behind it, and the preempted caller gets an unambiguous `409` back, not a stall.
- **Centralised cloud credentials** — Salik holds the real Anthropic/OpenAI keys; every client gets its own scoped Salik token instead.
- **Metering by default** — every request lands one row in SQLite: client, tier, model, tokens, latency, and cost. Bodies are never logged unless a client explicitly opts in.

## Architecture

```
client A (any language) ─┐
client B                 ─┼──► Salik ──┬──► Ollama         (serial, 1 slot, preemptible)
client C                 ─┘  auth →    ├──► api.anthropic.com   (parallel, budget-capped)
                             route →   └──► api.openai.com      (parallel, budget-capped)
                             queue →
                             meter          data/salik.db (requests, spend)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the middleware chain, the tier/preemption design, and the passthrough-safety rules that keep byte-exact request bodies byte-exact all the way to the upstream. See [docs/API.md](docs/API.md) for the full endpoint reference.

## Setup

Needs **[Bun](https://bun.sh) 1.3+** — no build step, no `dist/`, Bun runs the TypeScript entry directly.

```bash
git clone https://github.com/kkyusuftk/salik && cd salik
bun install
cp config/keys.json.example config/keys.json   # add client tokens + your real cloud keys
chmod 600 config/keys.json
```

Generate a token per client:

```bash
openssl rand -hex 32
```

Edit `config/settings.json` for your own upstream URLs/ports if they differ from the defaults (`http://127.0.0.1:11434` for Ollama), and `config/pricing.json` for the models you actually bill against — see its own comment for why unpriced models are left out rather than guessed at.

```bash
bun server/server.ts          # foreground, for a first run
# or
./ops/install.sh              # installs the launchd LaunchAgent (macOS) and starts it
```

Verify:

```bash
curl -s -H "Authorization: Bearer <a client token>" http://127.0.0.1:4749/api/tags
curl -s -H "Authorization: Bearer <a client token>" http://127.0.0.1:4749/api/salik/status
```

## Testing

```bash
bunx tsc --noEmit   # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes — a separate gate,
                     # since Bun transpiles without type-checking on execution
bun test            # fake upstreams only — never touches a real model or a real cloud account
```

The test suite's centrepiece is byte-exactness through the Hono layer: every forwarded request is asserted against the *raw bytes* the fake upstream received, not a parsed/deep-equal comparison — the failure mode this guards against (a dropped `think:false`, a reformatted number, a silently-dropped field) passes a deep-equal check while still corrupting the wire body.

## Layout

```
server/server.ts       entry point: load config, open the db, wire the app, serve
src/app.ts             the Hono app assembly — which paths get auth/budget/meter
src/routes/            one file per wire surface (openai, ollama, anthropic, status)
src/middleware/         auth, budget, meter
src/queue.ts            the single Ollama slot: priority queue + preemption
src/upstream.ts         byte-exact forward + header hygiene
src/pricing.ts          usage extraction per surface + cost from config/pricing.json
src/db.ts               bun:sqlite schema
src/types.ts            Salik's own state — Tier, Client, QueueState, config validation
config/                 settings, pricing, and (gitignored) keys
ops/                    launchd plist, install script, log rotation
tests/                  fake upstreams + the full suite
```

## Config

Two files are gitignored and yours alone — real client tokens and real cloud API keys:

- [config/keys.json](config/keys.json.example) — `upstreamKeys` (Salik's own Anthropic/OpenAI credentials) and `clients` (per-client token, tier, daily budget).
- `data/` — SQLite db, logs, and (only if a client opts into debug logging) request/response bodies. Never committed.

Everything else — `config/settings.json`, `config/pricing.json` — is committed; both are validated at startup, so a malformed edit fails loudly on the next restart instead of running with a silently-wrong config.
