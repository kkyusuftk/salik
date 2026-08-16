// Salik's own state — the one place types earn their keep. Nothing here
// describes an upstream request or response body; see the note on that in
// PLAN.md ("Type strategy"). Everything is `as const` objects with derived
// unions rather than `enum`, per the same section.

export const TIERS = ['interactive', 'chat', 'batch'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(x: unknown): x is Tier {
  return typeof x === 'string' && (TIERS as readonly string[]).includes(x);
}

// Lower rank = higher priority. A Record over a finite literal union is a
// fixed set of required properties, not an index signature, so this stays
// `number` (not `number | undefined`) under noUncheckedIndexedAccess.
export const TIER_RANK: Record<Tier, number> = {
  interactive: 0,
  chat: 1,
  batch: 2,
};

// The wire surface a request arrived on.
export const SURFACES = ['openai', 'ollama', 'anthropic'] as const;
export type Surface = (typeof SURFACES)[number];

// Which real backend a request was actually forwarded to. Distinct from
// Surface: the `openai` surface can land on either `ollama` (local models) or
// `openai` (everything else) depending on the `model` field.
export const UPSTREAMS = ['ollama', 'anthropic', 'openai'] as const;
export type UpstreamName = (typeof UPSTREAMS)[number];

export interface Client {
  token: string;
  name: string;
  tier: Tier;
  dailyBudgetUsd: number;
  debug: boolean;
}

export interface KeysFile {
  upstreamKeys: {
    anthropic: string;
    openai: string;
  };
  clients: Client[];
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Validated once at startup so every later `c.get('client')` is a real
 * Client, not `any` off a JSON.parse. Throws with a field-specific message —
 * a gateway that starts with a silently-wrong client list is worse than one
 * that refuses to start.
 */
export function parseKeysFile(raw: unknown, sourcePath: string): KeysFile {
  if (!isRecord(raw)) throw new Error(`${sourcePath}: expected a JSON object`);

  const upstreamKeysRaw = raw['upstreamKeys'];
  if (!isRecord(upstreamKeysRaw)) {
    throw new Error(`${sourcePath}: missing "upstreamKeys" object`);
  }
  const anthropicKey = upstreamKeysRaw['anthropic'];
  const openaiKey = upstreamKeysRaw['openai'];
  if (typeof anthropicKey !== 'string' || typeof openaiKey !== 'string') {
    throw new Error(`${sourcePath}: upstreamKeys.anthropic and upstreamKeys.openai must be strings (empty string is fine if unused)`);
  }

  const clientsRaw = raw['clients'];
  if (!Array.isArray(clientsRaw)) throw new Error(`${sourcePath}: missing "clients" array`);

  const seen = new Set<string>();
  const clients = clientsRaw.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`${sourcePath}: clients[${i}] is not an object`);
    const token = entry['token'];
    const name = entry['name'];
    const tier = entry['tier'];
    const dailyBudgetUsd = entry['dailyBudgetUsd'];
    const debug = entry['debug'] ?? false;
    if (typeof token !== 'string' || !token) throw new Error(`${sourcePath}: clients[${i}].token must be a non-empty string`);
    if (typeof name !== 'string' || !name) throw new Error(`${sourcePath}: clients[${i}].name must be a non-empty string`);
    if (!isTier(tier)) throw new Error(`${sourcePath}: clients[${i}].tier must be one of ${TIERS.join(', ')}`);
    if (typeof dailyBudgetUsd !== 'number' || !Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
      throw new Error(`${sourcePath}: clients[${i}].dailyBudgetUsd must be a non-negative number`);
    }
    if (typeof debug !== 'boolean') throw new Error(`${sourcePath}: clients[${i}].debug must be a boolean`);
    if (seen.has(token)) throw new Error(`${sourcePath}: duplicate client token at clients[${i}] (name "${name}")`);
    seen.add(token);
    const client: Client = { token, name, tier, dailyBudgetUsd, debug };
    return client;
  });

  return { upstreamKeys: { anthropic: anthropicKey, openai: openaiKey }, clients };
}

// -------------------------------------------------------------- pricing

export interface PriceEntry {
  input: number; // $ per million input tokens
  output: number; // $ per million output tokens
  until?: string; // ISO date (YYYY-MM-DD); this entry stops applying after it
}

// One model can have several chronological entries — an introductory rate
// followed by the standing one. The last entry in the array must be
// open-ended (no `until`) so lookup always terminates.
export type PriceTable = Record<string, PriceEntry[]>;

export function parsePriceTable(raw: unknown, sourcePath: string): PriceTable {
  if (!isRecord(raw)) throw new Error(`${sourcePath}: expected a JSON object`);
  const table: PriceTable = {};
  for (const [model, entriesRaw] of Object.entries(raw)) {
    if (model.startsWith('_')) continue; // "_comment" etc.
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
      throw new Error(`${sourcePath}: "${model}" must be a non-empty array of rate periods`);
    }
    const entries = entriesRaw.map((e, i): PriceEntry => {
      if (!isRecord(e)) throw new Error(`${sourcePath}: ${model}[${i}] is not an object`);
      const input = e['input'];
      const output = e['output'];
      const until = e['until'];
      if (typeof input !== 'number' || typeof output !== 'number') {
        throw new Error(`${sourcePath}: ${model}[${i}].input and .output must be numbers`);
      }
      if (until !== undefined && typeof until !== 'string') {
        throw new Error(`${sourcePath}: ${model}[${i}].until must be a string date if present`);
      }
      return until === undefined ? { input, output } : { input, output, until };
    });
    if (entries[entries.length - 1]?.until !== undefined) {
      throw new Error(`${sourcePath}: "${model}"'s last rate period must have no "until" (it is the standing rate)`);
    }
    table[model] = entries;
  }
  return table;
}

// -------------------------------------------------------------- usage / cost

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export interface ExtractedUsage extends Usage {
  model: string | null;
}

// -------------------------------------------------------------- requests log

export interface RequestRow {
  ts: string;
  client: string;
  tier: Tier;
  surface: Surface;
  upstream: UpstreamName;
  model: string | null;
  status: number;
  latencyMs: number;
  queueWaitMs: number;
  preempted: boolean;
  usage: Usage;
  costUsd: number | null; // null when the model has no pricing.json entry
}

// -------------------------------------------------------------- queue state

// The observable state of the single Ollama slot. A discriminated union so a
// switch over `kind` that forgets a case is a compile error, not a stuck slot.
export type QueueState =
  | { kind: 'idle' }
  | { kind: 'occupied'; tier: Tier; client: string; startedAt: number };

export interface QueuePendingSummary {
  tier: Tier;
  count: number;
}

export interface QueueStatus {
  slot: QueueState;
  pending: QueuePendingSummary[];
}

// -------------------------------------------------------------- Hono context
//
// The main reason Hono + TS earns its place over either alone: c.get('client')
// is checked against this shape instead of coming back `any`. Every field is
// set unconditionally and early by whichever route/middleware owns it, so a
// later `c.get()` is never reading a value nobody wrote.
export interface AppVariables {
  client: Client;
  tier: Tier;
  requestId: string;
  surface: Surface;
  upstream: UpstreamName;
  model: string | null;
  queueWaitMs: number;
  preempted: boolean;
  // Only ever set when debug logging is actually active for this request
  // (see src/middleware/meter.ts) — genuinely absent otherwise, unlike the
  // fields above which are always given a default.
  debugRequestBody?: ArrayBuffer;
}

export interface AppEnv {
  Variables: AppVariables;
}

// -------------------------------------------------------------- settings

export interface UpstreamSettings {
  url: string;
  timeoutMs: number;
}

export interface Settings {
  port: number;
  host: string;
  dbPath: string;
  logPath: string;
  bodiesDir: string;
  bodyRetentionDays: number;
  upstreams: {
    ollama: UpstreamSettings;
    anthropic: UpstreamSettings & { defaultVersion: string };
    // Model names in `localModels` route the OpenAI-compat surface to Ollama
    // instead of to the real OpenAI API — see src/routes/openai.ts.
    openai: UpstreamSettings & { localModels: string[] };
  };
}

export function parseSettings(raw: unknown, sourcePath: string): Settings {
  if (!isRecord(raw)) throw new Error(`${sourcePath}: expected a JSON object`);

  const port = raw['port'];
  const host = raw['host'];
  const dbPath = raw['dbPath'];
  const logPath = raw['logPath'];
  const bodiesDir = raw['bodiesDir'];
  const bodyRetentionDays = raw['bodyRetentionDays'];
  const upstreams = raw['upstreams'];

  if (typeof port !== 'number') throw new Error(`${sourcePath}: "port" must be a number`);
  if (typeof host !== 'string') throw new Error(`${sourcePath}: "host" must be a string`);
  if (typeof dbPath !== 'string') throw new Error(`${sourcePath}: "dbPath" must be a string`);
  if (typeof logPath !== 'string') throw new Error(`${sourcePath}: "logPath" must be a string`);
  if (typeof bodiesDir !== 'string') throw new Error(`${sourcePath}: "bodiesDir" must be a string`);
  if (typeof bodyRetentionDays !== 'number') throw new Error(`${sourcePath}: "bodyRetentionDays" must be a number`);
  if (!isRecord(upstreams)) throw new Error(`${sourcePath}: "upstreams" must be an object`);

  const ollama = parseUpstream(upstreams['ollama'], `${sourcePath}: upstreams.ollama`);
  const anthropicRaw = upstreams['anthropic'];
  const anthropic = parseUpstream(anthropicRaw, `${sourcePath}: upstreams.anthropic`);
  const defaultVersion = isRecord(anthropicRaw) ? anthropicRaw['defaultVersion'] : undefined;
  if (typeof defaultVersion !== 'string') {
    throw new Error(`${sourcePath}: upstreams.anthropic.defaultVersion must be a string`);
  }

  const openaiRaw = upstreams['openai'];
  const openai = parseUpstream(openaiRaw, `${sourcePath}: upstreams.openai`);
  const localModelsRaw = isRecord(openaiRaw) ? openaiRaw['localModels'] : undefined;
  if (!Array.isArray(localModelsRaw) || !localModelsRaw.every((m) => typeof m === 'string')) {
    throw new Error(`${sourcePath}: upstreams.openai.localModels must be a string array`);
  }

  return {
    port,
    host,
    dbPath,
    logPath,
    bodiesDir,
    bodyRetentionDays,
    upstreams: {
      ollama,
      anthropic: { ...anthropic, defaultVersion },
      openai: { ...openai, localModels: localModelsRaw as string[] },
    },
  };
}

function parseUpstream(raw: unknown, label: string): UpstreamSettings {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  const url = raw['url'];
  const timeoutMs = raw['timeoutMs'];
  if (typeof url !== 'string') throw new Error(`${label}.url must be a string`);
  if (typeof timeoutMs !== 'number') throw new Error(`${label}.timeoutMs must be a number`);
  return { url, timeoutMs };
}
