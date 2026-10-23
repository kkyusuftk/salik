// Config-file parsing and validation: keys.json, pricing.json, models.json,
// settings.json. Each parse* runs once at startup so no later code ever sees
// an unvalidated JSON.parse result — a gateway that starts with silently-wrong
// config is worse than one that refuses to start.
import { isRecord } from './json.ts';
import { isTier, TIERS, type Tier, UPSTREAMS, type UpstreamName, isUpstreamName } from './wire.ts';

// -------------------------------------------------------------- keys.json

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

/**
 * Throws with a field-specific message — see the file-header note on
 * refusing to start with bad config.
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

// -------------------------------------------------------------- pricing.json

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

// -------------------------------------------------------------- models.json

// Models Salik serves through POST /v1/chat/completions — see config/models.json
// and src/dispatch.ts. `provider` reuses UpstreamName rather than a parallel
// enum: "which backend serves this" is the same concept whether it's decided
// by the registry (here) or observed after the fact (RequestRow.upstream).
export interface ModelEntry {
  id: string;
  provider: UpstreamName;
  upstreamModel: string;
  fallback?: string;
}

export interface ModelRegistry {
  defaultFallback: string;
  models: readonly ModelEntry[];
  byId: ReadonlyMap<string, ModelEntry>;
}

/**
 * Every `fallback` (including `defaultFallback`) must resolve to a real
 * model id — a dangling reference is a startup error, not a runtime
 * surprise, matching parseKeysFile/parsePriceTable's discipline. Only
 * self-reference is rejected, not longer cycles: src/dispatch.ts only ever
 * takes one hop, so a longer cycle can never actually be walked into at
 * runtime. A model with no `fallback` that happens to BE `defaultFallback`
 * itself is valid config — it just has no further fallback when it fails.
 */
export function parseModelRegistry(raw: unknown, sourcePath: string): ModelRegistry {
  if (!isRecord(raw)) throw new Error(`${sourcePath}: expected a JSON object`);

  const defaultFallback = raw['defaultFallback'];
  if (typeof defaultFallback !== 'string' || !defaultFallback) {
    throw new Error(`${sourcePath}: "defaultFallback" must be a non-empty string`);
  }

  const modelsRaw = raw['models'];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error(`${sourcePath}: "models" must be a non-empty array`);
  }

  const seen = new Set<string>();
  const models = modelsRaw.map((entry, i): ModelEntry => {
    if (!isRecord(entry)) throw new Error(`${sourcePath}: models[${i}] is not an object`);
    const id = entry['id'];
    const provider = entry['provider'];
    const upstreamModel = entry['upstreamModel'];
    const fallback = entry['fallback'];
    if (typeof id !== 'string' || !id) throw new Error(`${sourcePath}: models[${i}].id must be a non-empty string`);
    if (seen.has(id)) throw new Error(`${sourcePath}: duplicate model id "${id}" at models[${i}]`);
    seen.add(id);
    if (!isUpstreamName(provider)) {
      throw new Error(`${sourcePath}: models[${i}].provider must be one of ${UPSTREAMS.join(', ')}`);
    }
    if (typeof upstreamModel !== 'string' || !upstreamModel) {
      throw new Error(`${sourcePath}: models[${i}].upstreamModel must be a non-empty string`);
    }
    if (fallback !== undefined && (typeof fallback !== 'string' || !fallback)) {
      throw new Error(`${sourcePath}: models[${i}].fallback must be a non-empty string if present`);
    }
    if (fallback === id) throw new Error(`${sourcePath}: models[${i}] ("${id}") names itself as its own fallback`);
    return fallback === undefined ? { id, provider, upstreamModel } : { id, provider, upstreamModel, fallback };
  });

  const byId = new Map(models.map((m) => [m.id, m]));

  if (!byId.has(defaultFallback)) {
    throw new Error(`${sourcePath}: "defaultFallback" ("${defaultFallback}") is not the id of any model in "models"`);
  }
  for (const m of models) {
    if (m.fallback !== undefined && !byId.has(m.fallback)) {
      throw new Error(`${sourcePath}: "${m.id}".fallback ("${m.fallback}") is not the id of any model in "models"`);
    }
  }

  return { defaultFallback, models, byId };
}

// -------------------------------------------------------------- settings.json

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
    openai: UpstreamSettings;
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

  const openai = parseUpstream(upstreams['openai'], `${sourcePath}: upstreams.openai`);

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
      openai,
    },
  };
}
