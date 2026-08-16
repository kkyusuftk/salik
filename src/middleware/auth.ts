// Token -> {client, tier} on the typed context. Not built on hono/bearer-auth
// directly: that helper only ever looks at `Authorization: Bearer`, but the
// Anthropic SDKs Salik has to be a drop-in for (see PLAN.md's API-surfaces
// table — "@anthropic-ai/sdk and anthropic-java work with only a baseURL
// change") send `x-api-key` by default, and zero other code is supposed to
// change. So this checks both headers against the same client table.
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Client } from '../types.ts';

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1] ?? null;
}

export function createAuthMiddleware(clients: readonly Client[]) {
  const byToken = new Map(clients.map((client) => [client.token, client]));

  return createMiddleware<AppEnv>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization')) ?? c.req.header('x-api-key') ?? null;
    const client = token ? byToken.get(token) : undefined;

    if (!client) {
      return c.json({ error: { type: 'salik_invalid_api_key', message: 'missing or unrecognised token' } }, 401);
    }

    c.set('client', client);
    c.set('tier', client.tier);
    await next();
  });
}
