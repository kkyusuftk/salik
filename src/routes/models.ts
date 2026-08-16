// Salik's own model catalog: GET /v1/models, in OpenAI's own response shape.
// Mounted with auth only (see src/app.ts) — a pure local-config read, no
// upstream call, so there's nothing to budget-gate or meter.
import { Hono } from 'hono';
import type { AppEnv, ModelRegistry } from '../types.ts';

export interface ModelsRouteDeps {
  registry: ModelRegistry;
}

export function createModelsRoutes({ registry }: ModelsRouteDeps) {
  const app = new Hono<AppEnv>();
  // Computed once at route-factory time (server startup) rather than per
  // request — it's cosmetic (OpenAI's own field for "when this model became
  // available"), not a claim about the model itself.
  const createdAt = Math.floor(Date.now() / 1000);

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: registry.models.map((m) => ({
        id: m.id,
        object: 'model' as const,
        created: createdAt,
        owned_by: m.provider,
      })),
    }),
  );

  return app;
}
