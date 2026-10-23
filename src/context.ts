// The Hono context contract — the main reason Hono + TS earns its place over
// either alone: c.get('client') is checked against this shape instead of
// coming back `any`. Every field is set unconditionally and early by whoever
// owns it, so a later `c.get()` is never reading a value nobody wrote.
import type { Client } from './config.ts';
import type { Surface, Tier, UpstreamName } from './wire.ts';

export interface AppVariables {
  client: Client;
  tier: Tier;
  requestId: string;
  surface: Surface;
  upstream: UpstreamName;
  model: string | null;
  // The client's own `model` field, set once before any registry/fallback
  // resolution and never overwritten — always equal to `model` on the three
  // native passthrough routes, since only src/dispatch.ts can ever diverge them.
  requestedModel: string | null;
  // True only when src/dispatch.ts actually served a fallback model instead
  // of the one requested. Always false on the native passthrough routes.
  fellBack: boolean;
  queueWaitMs: number;
  preempted: boolean;
  // The exact bytes the client sent, read once by the shared prologue
  // middleware (src/middleware/prologue.ts) on every proxied path and never
  // re-read — routes get it from here so the request stream is consumed
  // exactly once.
  rawRequestBody: ArrayBuffer;
  // Only ever set when debug logging is actually active for this request
  // (see src/middleware/meter.ts) — genuinely absent otherwise, unlike the
  // fields above which are always given a default.
  debugRequestBody?: ArrayBuffer;
}

export interface AppEnv {
  Variables: AppVariables;
}
