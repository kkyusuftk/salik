// Pure unit tests for OpenAI request -> Anthropic request translation. No
// HTTP layer — these exercise src/providers/anthropic/request.ts directly.
import { describe, expect, test } from 'bun:test';
import { translateRequest, DEFAULT_MAX_TOKENS } from '../../src/providers/anthropic/request.ts';
import type { AnthropicMessagesRequestBody } from '../../src/providers/anthropic/types.ts';

function toRaw(obj: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(obj)).buffer;
}

function translate(obj: unknown, model = 'claude-sonnet-5'): AnthropicMessagesRequestBody {
  const result = translateRequest(toRaw(obj), model);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.type}: ${result.error.message}`);
  return result.value.body;
}

function translateErr(obj: unknown, model = 'claude-sonnet-5') {
  const result = translateRequest(toRaw(obj), model);
  if (result.ok) throw new Error('expected an error, got ok');
  return result.error;
}

describe('translateRequest: basics', () => {
  test('a plain system + user message becomes a top-level system field plus a user message', () => {
    const body = translate({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(body.model).toBe('claude-sonnet-5'); // the RESOLVED upstream model, not whatever the client sent
  });

  test('multiple system messages, in any position, are concatenated in order', () => {
    const body = translate({
      messages: [
        { role: 'system', content: 'first' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'second' },
      ],
    });
    expect(body.system).toBe('first\n\nsecond');
  });

  test('defaults max_tokens when the client sent neither max_tokens nor max_completion_tokens', () => {
    const body = translate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  test('prefers max_completion_tokens over max_tokens when both are present', () => {
    const body = translate({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, max_completion_tokens: 20 });
    expect(body.max_tokens).toBe(20);
  });

  test('a bare string "stop" becomes a one-element stop_sequences array', () => {
    const body = translate({ messages: [{ role: 'user', content: 'hi' }], stop: 'STOP' });
    expect(body.stop_sequences).toEqual(['STOP']);
  });

  test('an array "stop" passes through as stop_sequences', () => {
    const body = translate({ messages: [{ role: 'user', content: 'hi' }], stop: ['A', 'B'] });
    expect(body.stop_sequences).toEqual(['A', 'B']);
  });

  test('rejects an empty messages array', () => {
    expect(translateErr({ messages: [] }).type).toBe('invalid_request');
  });

  test('rejects a conversation that does not start with a user message', () => {
    expect(translateErr({ messages: [{ role: 'assistant', content: 'hi' }] }).type).toBe('invalid_request');
  });

  test('a "developer" role message is rejected, not silently folded into system', () => {
    const err = translateErr({ messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }] });
    expect(err.type).toBe('unsupported_param');
  });

  test('a legacy "function" role message is rejected', () => {
    const err = translateErr({ messages: [{ role: 'user', content: 'hi' }, { role: 'function', name: 'f', content: '{}' }] });
    expect(err.type).toBe('unsupported_param');
  });
});

describe('translateRequest: vision', () => {
  test('a data: image URL becomes a base64 image source with the media type extracted', () => {
    const body = translate({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    expect(body.messages[0]!.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
  });

  test('a plain http(s) image URL becomes an Anthropic url-type source', () => {
    const body = translate({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }],
    });
    expect(body.messages[0]!.content).toEqual([{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }]);
  });

  test('rejects an image media type Anthropic does not support', () => {
    const err = translateErr({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/bmp;base64,AAAA' } }] }],
    });
    expect(err.type).toBe('unsupported_content');
  });

  test('rejects a content part type with no Anthropic equivalent, rather than silently dropping it', () => {
    const err = translateErr({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] });
    expect(err.type).toBe('unsupported_content');
  });
});

describe('translateRequest: tool calls', () => {
  test('an assistant tool_calls entry becomes a tool_use content block with parsed JSON input', () => {
    const body = translate({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"Dubai"}' } }],
        },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'getWeather', input: { city: 'Dubai' } }],
    });
  });

  test('a tool-role message becomes a user message with a tool_result block', () => {
    const body = translate({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }],
    });
  });

  test('consecutive tool-result messages (parallel calls) are coalesced into one user turn', () => {
    const body = translate({
      messages: [
        { role: 'user', content: 'weather in two cities?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
        { role: 'tool', tool_call_id: 'call_2', content: 'rainy' },
      ],
    });
    expect(body.messages).toHaveLength(3); // user, assistant, ONE coalesced user turn (not two)
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'rainy' },
      ],
    });
  });

  test('tool_choice "none" omits tools from the Anthropic request entirely', () => {
    const body = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'none',
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test('tool_choice "required" maps to {type:"any"}', () => {
    const body = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'required',
    });
    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  test('a named function tool_choice maps to {type:"tool", name}', () => {
    const body = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'f' });
  });

  test('parallel_tool_calls:false sets disable_parallel_tool_use even with the default (auto) choice', () => {
    const body = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      parallel_tool_calls: false,
    });
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });
});

describe('translateRequest: rejected params (no silent approximation)', () => {
  test('non-zero presence_penalty is rejected', () => {
    expect(translateErr({ messages: [{ role: 'user', content: 'hi' }], presence_penalty: 0.5 }).type).toBe('unsupported_param');
  });

  test('presence_penalty of exactly 0 is a no-op, not rejected', () => {
    expect(() => translate({ messages: [{ role: 'user', content: 'hi' }], presence_penalty: 0 })).not.toThrow();
  });

  test('logprobs:true is rejected', () => {
    expect(translateErr({ messages: [{ role: 'user', content: 'hi' }], logprobs: true }).type).toBe('unsupported_param');
  });

  test('n > 1 is rejected', () => {
    expect(translateErr({ messages: [{ role: 'user', content: 'hi' }], n: 2 }).type).toBe('unsupported_param');
  });

  test('a non-empty logit_bias is rejected', () => {
    expect(translateErr({ messages: [{ role: 'user', content: 'hi' }], logit_bias: { '123': 1 } }).type).toBe('unsupported_param');
  });

  test('response_format other than "text" is rejected', () => {
    expect(translateErr({ messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } }).type).toBe(
      'unsupported_param',
    );
  });

  test('a malformed tool-call arguments string is rejected rather than sent as garbage input', () => {
    const err = translateErr({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'not json' } }] },
      ],
    });
    expect(err.type).toBe('unsupported_content');
  });
});
