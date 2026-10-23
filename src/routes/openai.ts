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
import { openAiErrorBody, salikErrorBody } from '../errors.ts';
import { dispatch, UnknownModelError, type DispatchDeps } from '../dispatch.ts';
import { toOpenAiErrorResponse } from '../providers/anthropic/index.ts';
import { Preempted } from '../queue.ts';
import { prepareRequestHeaders } from '../upstream.ts';
import type { AppEnv } from '../context.ts';

export function createOpenAiRoutes(deps: DispatchDeps) {
  const app = new Hono<AppEnv>();

  app.post('/v1/chat/completions', async (c) => {
    // Context defaults, raw-body read, and requestedModel are owned by the
    // shared prologue middleware (src/middleware/prologue.ts); this surface
    // deliberately leaves `model` alone — dispatch decides it.
    const rawBody = c.get('rawRequestBody');
    const requestedModel = c.get('requestedModel');

    if (requestedModel === null) {
      return Response.json(openAiErrorBody('"model" is required', 'invalid_request_error', 'model'), { status: 400 });
    }

    const headers = prepareRequestHeaders(c.req.raw.headers);

    try {
      const outcome = await dispatch(deps, requestedModel, rawBody, headers, c.get('tier'), c.get('client').name, c.req.raw.signal);
      c.set('upstream', outcome.servedBy.provider);
      c.set('model', outcome.servedBy.upstreamModel);
      c.set('fellBack', outcome.fellBack);
      c.set('queueWaitMs', outcome.queueWaitMs);
      return outcome.response;
    } catch (err) {
      if (err instanceof Preempted) {
        c.set('preempted', true);
        return Response.json(salikErrorBody('salik_preempted', err.message), { status: 409 });
      }
      if (err instanceof UnknownModelError) {
        return Response.json(openAiErrorBody(err.message, 'salik_unknown_model'), { status: 404 });
      }
      return toOpenAiErrorResponse(err);
    }
  });

  return app;
}
