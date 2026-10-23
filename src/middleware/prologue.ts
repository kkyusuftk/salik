// Shared request prologue for every billable/proxied path. One place owns
// what used to be copy-pasted into each route handler:
//
// 1. The seven default context variables meter.ts always reads (set before
//    any await, so even if the body read itself throws, meter records
//    something coherent rather than an unset variable).
// 2. The one-time raw-body read — stored on the context so the route never
//    re-reads the request stream.
// 3. The `model` hint extraction (readModelHint) with its per-surface rule:
//    native passthrough surfaces set both `model` and `requestedModel`; the
//    unified OpenAI surface sets only `requestedModel`, because its `model`
//    is decided later by src/dispatch.ts (and stays null when dispatch
//    rejects the request).
// 4. Debug-body capture — THE single decision point, shared with meter.ts
//    via isDebugRequested(), so the capture side and the write side can
//    never disagree about what "debug on" means.
//
// Registered last of the shared middleware (auth → budget → meter → this):
// it needs auth's `client` for the debug gate, and sitting inside meter's
// timer preserves metering semantics exactly (the body read was always part
// of the measured latency).
import { createMiddleware } from 'hono/factory';
import type { Client } from '../config.ts';
import type { AppEnv } from '../context.ts';
import { readModelHint } from '../pricing.ts';
import type { Surface, UpstreamName } from '../wire.ts';

/** The one definition of "debug logging is active for this request". */
export function isDebugRequested(client: Client, xSalikDebugHeader: string | undefined): boolean {
  return client.debug || xSalikDebugHeader === '1';
}

export interface PrologueOptions {
  surface: Surface;
  upstream: UpstreamName;
  /** True for native passthrough surfaces (model === requestedModel); false for the unified dispatch surface. */
  hintSetsModel: boolean;
}

export function createPrologueMiddleware({ surface, upstream, hintSetsModel }: PrologueOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('surface', surface);
    c.set('upstream', upstream);
    c.set('model', null);
    c.set('requestedModel', null);
    c.set('fellBack', false);
    c.set('queueWaitMs', 0);
    c.set('preempted', false);

    // Health probes are GETs with no body worth parsing or capturing.
    if (c.req.method !== 'POST') {
      await next();
      return;
    }

    const rawBody = await c.req.arrayBuffer();
    c.set('rawRequestBody', rawBody);

    const hint = readModelHint(rawBody);
    if (hintSetsModel) c.set('model', hint);
    c.set('requestedModel', hint);

    const client = c.get('client');
    if (isDebugRequested(client, c.req.header('x-salik-debug'))) c.set('debugRequestBody', rawBody);

    await next();
  });
}
