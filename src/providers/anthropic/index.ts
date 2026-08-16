// Public surface of the OpenAI <-> Anthropic translator — the only file
// src/dispatch.ts imports from. Everything else in this directory is a
// private implementation detail of these five functions.
//
// Why typing bodies here doesn't violate PLAN.md's passthrough invariant:
// that rule guards against a typed shape silently dropping a field on its
// way back out to the *same* wire format (src/routes/*.ts's byte-exact
// forwarding). This module never forwards a body — it constructs a
// genuinely different protocol's body, so there's no byte-exactness between
// OpenAI-in and Anthropic-out to preserve. It stays disciplined by keeping
// its types narrow (only fields actually translated) and by treating every
// unrecognized input field as either a named, documented drop or a hard 400
// — never a silent pass-through of something that wasn't really translated.
export { translateRequest, DEFAULT_MAX_TOKENS } from './request.ts';
export type { RequestTranslationError, RequestTranslationResult, TranslatedAnthropicRequest } from './request.ts';
export { translateNonStreamingResponse } from './response.ts';
export type { AnthropicToOpenAiResult } from './response.ts';
export { translateStreamingResponse } from './stream.ts';
export type { StreamTranslationResult } from './stream.ts';
export { requestErrorToResponse, translateErrorResponse, toOpenAiErrorResponse } from './errors.ts';
