// OpenAI-compat surface: POST /v1/chat/completions. Routes to one of two
// upstreams by `model` — Ollama's own OpenAI-compat endpoint for local model
// names (trip-agent vision, receipt-analyzer), real api.openai.com for
// everything else (portfolio's OpenAiRunner fallback). Both are the SAME
// wire format, unlike src/routes/anthropic.ts, which is why one route
// handles both destinations.
//
// The local branch goes through the exact same OllamaQueue instance
// src/routes/ollama.ts uses — there is only one physical Ollama slot,
// regardless of which surface a request arrived on.
import { Hono } from 'hono';
import { readModelHint } from '../pricing.ts';
import { Preempted, type OllamaQueue } from '../queue.ts';
import { forward, prepareRequestHeaders, toErrorResponse } from '../upstream.ts';
import type { AppEnv } from '../types.ts';

export interface OpenAiRouteDeps {
  queue: OllamaQueue;
  ollama: { url: string; timeoutMs: number };
  openai: { url: string; timeoutMs: number; localModels: readonly string[]; apiKey: string };
}

export function createOpenAiRoutes({ queue, ollama, openai }: OpenAiRouteDeps) {
  const app = new Hono<AppEnv>();

  app.post('/v1/chat/completions', async (c) => {
    c.set('surface', 'openai');
    c.set('upstream', 'openai'); // placeholder; corrected below once the model is known
    c.set('model', null);
    c.set('queueWaitMs', 0);
    c.set('preempted', false);

    const rawBody = await c.req.arrayBuffer();
    const model = readModelHint(rawBody);
    c.set('model', model);

    const client = c.get('client');
    if (client.debug || c.req.header('x-salik-debug') === '1') c.set('debugRequestBody', rawBody);

    const headers = prepareRequestHeaders(c.req.raw.headers);
    headers.set('content-type', 'application/json');

    const isLocal = model !== null && openai.localModels.includes(model);
    c.set('upstream', isLocal ? 'ollama' : 'openai');

    if (isLocal) {
      headers.set('authorization', 'Bearer local');
      try {
        const { value, queueWaitMs } = await queue.run(c.get('tier'), client.name, c.req.raw.signal, (signal) =>
          forward({
            method: 'POST',
            url: `${ollama.url}/v1/chat/completions`,
            headers,
            body: rawBody,
            signal: AbortSignal.any([signal, AbortSignal.timeout(ollama.timeoutMs)]),
          }),
        );
        c.set('queueWaitMs', queueWaitMs);
        return value;
      } catch (err) {
        if (err instanceof Preempted) {
          c.set('preempted', true);
          return c.json({ error: { type: 'salik_preempted', message: err.message } }, 409);
        }
        return toErrorResponse(err);
      }
    }

    headers.set('authorization', `Bearer ${openai.apiKey}`);
    try {
      return await forward({
        method: 'POST',
        url: `${openai.url}/v1/chat/completions`,
        headers,
        body: rawBody,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(openai.timeoutMs)]),
      });
    } catch (err) {
      return toErrorResponse(err);
    }
  });

  return app;
}
