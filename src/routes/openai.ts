// OpenAI-compat surface: POST /v1/chat/completions — the one unified
// interface. Every configured model (config/models.json) is reachable here
// regardless of which backend actually serves it; src/dispatch.ts resolves
// the model, dispatches to the right provider (translating for Anthropic-
// backed models), and falls back once if the primary attempt fails.
//
// The route itself stays thin: read enough to look the model up, call
// dispatch(), map its outcome (or thrown Preempted/UnknownModelError) onto
// the response and the metering context vars.
import { Hono } from 'hono';
import { dispatch, UnknownModelError, type DispatchDeps } from '../dispatch.ts';
import { readModelHint } from '../pricing.ts';
import { toOpenAiErrorResponse } from '../providers/anthropic/index.ts';
import { Preempted } from '../queue.ts';
import { prepareRequestHeaders } from '../upstream.ts';
import type { AppEnv } from '../types.ts';

export function createOpenAiRoutes(deps: DispatchDeps) {
  const app = new Hono<AppEnv>();

  app.post('/v1/chat/completions', async (c) => {
    c.set('surface', 'openai');
    c.set('upstream', 'openai'); // placeholder; corrected below once dispatch resolves
    c.set('model', null);
    c.set('requestedModel', null);
    c.set('fellBack', false);
    c.set('queueWaitMs', 0);
    c.set('preempted', false);

    const rawBody = await c.req.arrayBuffer();
    const requestedModel = readModelHint(rawBody);
    c.set('requestedModel', requestedModel);

    const client = c.get('client');
    if (client.debug || c.req.header('x-salik-debug') === '1') c.set('debugRequestBody', rawBody);

    if (requestedModel === null) {
      return Response.json(
        { error: { message: '"model" is required', type: 'invalid_request_error', param: 'model', code: null } },
        { status: 400 },
      );
    }

    const headers = prepareRequestHeaders(c.req.raw.headers);

    try {
      const outcome = await dispatch(deps, requestedModel, rawBody, headers, c.get('tier'), client.name, c.req.raw.signal);
      c.set('upstream', outcome.servedBy.provider);
      c.set('model', outcome.servedBy.upstreamModel);
      c.set('fellBack', outcome.fellBack);
      c.set('queueWaitMs', outcome.queueWaitMs);
      return outcome.response;
    } catch (err) {
      if (err instanceof Preempted) {
        c.set('preempted', true);
        return c.json({ error: { type: 'salik_preempted', message: err.message } }, 409);
      }
      if (err instanceof UnknownModelError) {
        return Response.json({ error: { message: err.message, type: 'salik_unknown_model', param: null, code: null } }, { status: 404 });
      }
      return toOpenAiErrorResponse(err);
    }
  });

  return app;
}
