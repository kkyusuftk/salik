// Anthropic surface: POST /v1/messages, straight through to api.anthropic.com
// — Ollama has no Anthropic-shaped endpoint, so unlike src/routes/openai.ts
// there is no local branch here and no queue involvement; the cloud upstream
// parallelises fine per PLAN.md's "core invariant".
import { Hono } from 'hono';
import { readModelHint } from '../pricing.ts';
import { forward, prepareRequestHeaders, toErrorResponse } from '../upstream.ts';
import type { AppEnv } from '../types.ts';

export interface AnthropicRouteDeps {
  url: string;
  timeoutMs: number;
  apiKey: string;
  defaultVersion: string;
}

export function createAnthropicRoutes({ url, timeoutMs, apiKey, defaultVersion }: AnthropicRouteDeps) {
  const app = new Hono<AppEnv>();

  app.post('/v1/messages', async (c) => {
    c.set('surface', 'anthropic');
    c.set('upstream', 'anthropic');
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
    headers.set('x-api-key', apiKey);
    headers.set('content-type', 'application/json');
    // The client's own version header (if the SDK sent one) wins; Salik only
    // fills the gap so a raw-fetch caller without one still works.
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', defaultVersion);

    try {
      return await forward({
        method: 'POST',
        url: `${url}/v1/messages`,
        headers,
        body: rawBody,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (err) {
      return toErrorResponse(err);
    }
  });

  return app;
}
