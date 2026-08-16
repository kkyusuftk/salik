// Ollama-native surface: POST /api/chat (queued — this is the surface the
// whole gateway exists to serialise) plus three GET health probes, which
// bypass the queue entirely. They're metadata reads that don't touch the
// model, so they don't compete for the slot — see PLAN.md's "core invariant".
import { Hono } from 'hono';
import { readModelHint } from '../pricing.ts';
import { Preempted, type OllamaQueue } from '../queue.ts';
import { forward, prepareRequestHeaders, toErrorResponse } from '../upstream.ts';
import type { AppEnv } from '../types.ts';

export interface OllamaRouteDeps {
  queue: OllamaQueue;
  url: string;
  timeoutMs: number;
}

const HEALTH_PATHS = ['/api/tags', '/api/ps', '/api/version'] as const;

export function createOllamaRoutes({ queue, url, timeoutMs }: OllamaRouteDeps) {
  const app = new Hono<AppEnv>();

  app.post('/api/chat', async (c) => {
    // Set before any await: if arrayBuffer() itself throws, meter still has
    // something coherent to record rather than an unset context variable.
    c.set('surface', 'ollama');
    c.set('upstream', 'ollama');
    c.set('model', null);
    c.set('requestedModel', null);
    c.set('fellBack', false);
    c.set('queueWaitMs', 0);
    c.set('preempted', false);

    const rawBody = await c.req.arrayBuffer();
    const model = readModelHint(rawBody);
    c.set('model', model);
    c.set('requestedModel', model);

    const client = c.get('client');
    if (client.debug || c.req.header('x-salik-debug') === '1') c.set('debugRequestBody', rawBody);

    const headers = prepareRequestHeaders(c.req.raw.headers);
    headers.set('authorization', 'Bearer local'); // Ollama ignores auth; kept for parity with existing clients
    headers.set('content-type', 'application/json');

    try {
      const { value, queueWaitMs } = await queue.run(c.get('tier'), client.name, c.req.raw.signal, (signal) =>
        forward({
          method: 'POST',
          url: `${url}/api/chat`,
          headers,
          body: rawBody,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        }),
      );
      c.set('queueWaitMs', queueWaitMs);
      return value;
    } catch (err) {
      if (err instanceof Preempted) {
        c.set('preempted', true);
        return c.json({ error: { type: 'salik_preempted', message: err.message } }, 409);
      }
      // Converted here, not rethrown — see toErrorResponse()'s own comment
      // for why relying on Hono's onError for this is not safe enough.
      return toErrorResponse(err);
    }
  });

  for (const p of HEALTH_PATHS) {
    app.get(p, async (c) => {
      c.set('surface', 'ollama');
      c.set('upstream', 'ollama');
      c.set('model', null);
      c.set('requestedModel', null);
      c.set('fellBack', false);
      c.set('queueWaitMs', 0);
      c.set('preempted', false);

      const headers = prepareRequestHeaders(c.req.raw.headers);
      try {
        return await forward({
          method: 'GET',
          url: `${url}${p}`,
          headers,
          body: null,
          signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (err) {
        return toErrorResponse(err);
      }
    });
  }

  return app;
}
