// Wire/domain vocabulary: tiers, surfaces, upstreams, usage shapes, the
// requests-ledger row, and queue-state types. Nothing here describes an
// upstream request or response body; see the note on that in PLAN.md
// ("Type strategy"). Everything is `as const` objects with derived unions
// rather than `enum`, per the same section.

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

export function isUpstreamName(x: unknown): x is UpstreamName {
  return typeof x === 'string' && (UPSTREAMS as readonly string[]).includes(x);
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
  requestedModel: string | null; // the client's own `model` field, before any registry/fallback resolution
  status: number;
  latencyMs: number;
  queueWaitMs: number;
  preempted: boolean;
  fellBack: boolean; // true when the model that served this request wasn't the one requested
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
