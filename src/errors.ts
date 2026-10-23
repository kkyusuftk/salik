// The two error-envelope families Salik emits, in one place.
//
// - `salik*`: Salik's own namespace (`salik_*` types), used wherever Salik is
//   speaking as itself — native passthrough surfaces, auth/budget middleware.
// - `openAi*`: OpenAI's own error envelope. Deliberately NOT the salik shape:
//   the whole point of "one interface" is that /v1/chat/completions' error
//   contract shouldn't shape-shift based on which backend served the request,
//   so everything on that surface — including Salik-originated conditions —
//   uses OpenAI's envelope.
//
// Both families are body-builders plus thin Response wrappers so call sites
// never hand-assemble JSON.

export interface SalikErrorBody {
  error: { type: string; message: string };
}

export interface OpenAiErrorBody {
  error: { message: string; type: string; param: string | null; code: null };
}

export function salikErrorBody(type: string, message: string): SalikErrorBody {
  return { error: { type, message } };
}

export function salikErrorResponse(type: string, message: string, status: number): Response {
  return Response.json(salikErrorBody(type, message), { status });
}

export function openAiErrorBody(message: string, type: string, param: string | null = null): OpenAiErrorBody {
  return { error: { message, type, param, code: null } };
}

export function openAiErrorResponse(message: string, type: string, status: number): Response {
  return Response.json(openAiErrorBody(message, type), { status });
}
