// Pure unit tests for Anthropic error responses -> OpenAI's own error
// envelope. No HTTP layer.
import { describe, expect, test } from 'bun:test';
import { requestErrorToResponse, toOpenAiErrorResponse, translateErrorResponse } from '../../src/providers/anthropic/errors.ts';

describe('translateErrorResponse', () => {
  test('maps type/message through unchanged, same status, into the OpenAI envelope', async () => {
    const anthropicRes = Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }, { status: 400 });
    const res = await translateErrorResponse(anthropicRes);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: 'bad request', type: 'invalid_request_error', param: null, code: null } });
  });

  test('529 overloaded_error remaps the HTTP status to 503 but keeps the type string', async () => {
    const anthropicRes = Response.json({ error: { type: 'overloaded_error', message: 'overloaded' } }, { status: 529 });
    const res = await translateErrorResponse(anthropicRes);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { type: string } }).toMatchObject({ error: { type: 'overloaded_error' } });
  });

  test('forwards a retry-after header when Anthropic sent one', async () => {
    const anthropicRes = new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }), {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    const res = await translateErrorResponse(anthropicRes);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  test('a malformed (non-JSON) error body falls back to a generic api_error rather than throwing', async () => {
    const anthropicRes = new Response('not json', { status: 500 });
    const res = await translateErrorResponse(anthropicRes);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'unknown upstream error', type: 'api_error', param: null, code: null } });
  });
});

describe('toOpenAiErrorResponse', () => {
  test('an AbortError maps to 499 salik_client_closed', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    const res = toOpenAiErrorResponse(abortErr);
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: { message: 'client disconnected', type: 'salik_client_closed', param: null, code: null } });
  });

  test('any other error maps to 502 api_error with its message', async () => {
    const res = toOpenAiErrorResponse(new Error('network unreachable'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: 'network unreachable', type: 'api_error', param: null, code: null } });
  });

  test('a non-Error thrown value is stringified rather than crashing', async () => {
    const res = toOpenAiErrorResponse('just a string');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('just a string');
  });
});

describe('requestErrorToResponse', () => {
  test('always a 400 invalid_request_error carrying the translator error message', async () => {
    const res = requestErrorToResponse({ type: 'unsupported_param', message: 'logprobs has no Anthropic equivalent' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: 'logprobs has no Anthropic equivalent', type: 'invalid_request_error', param: null, code: null },
    });
  });
});
