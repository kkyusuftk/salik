// Pure unit tests for Anthropic response -> OpenAI response translation
// (non-streaming). No HTTP layer.
import { describe, expect, test } from 'bun:test';
import { translateNonStreamingResponse } from '../../src/providers/anthropic/response.ts';

describe('translateNonStreamingResponse', () => {
  test('a plain text response maps content, model, and finish_reason', () => {
    const { response } = translateNonStreamingResponse(
      {
        id: 'msg_abc',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      'my-alias',
    );
    expect(response.id).toBe('chatcmpl-msg_abc');
    expect(response.model).toBe('my-alias'); // echoes the SERVED registry id, not Anthropic's own internal model string
    expect(response.choices[0].message).toEqual({ role: 'assistant', content: 'hello' });
    expect(response.choices[0].finish_reason).toBe('stop');
  });

  test('a tool_use block becomes an OpenAI tool_calls entry with stringified arguments', () => {
    const { response } = translateNonStreamingResponse(
      {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'call_1', name: 'getWeather', input: { city: 'Dubai' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'x',
    );
    expect(response.choices[0].message.content).toBeNull();
    expect(response.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"Dubai"}' } },
    ]);
    expect(response.choices[0].finish_reason).toBe('tool_calls');
  });

  test('thinking blocks are dropped, not surfaced as content', () => {
    const { response } = translateNonStreamingResponse(
      {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'the answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'x',
    );
    expect(response.choices[0].message.content).toBe('the answer');
  });

  test.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
    ['pause_turn', 'stop'],
    ['some_future_reason', 'stop'],
  ])('maps stop_reason %s to finish_reason %s', (stopReason, finishReason) => {
    const { response } = translateNonStreamingResponse(
      { id: 'msg_1', content: [{ type: 'text', text: 'x' }], stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } },
      'x',
    );
    expect(response.choices[0].finish_reason).toBe(finishReason);
  });

  test('cache reads/writes fold into prompt_tokens (disjoint on the Anthropic side, folded on the OpenAI side)', () => {
    const { response, usage } = translateNonStreamingResponse(
      {
        id: 'msg_1',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
      },
      'x',
    );
    expect(response.usage).toEqual({
      prompt_tokens: 140, // 100 + 30 + 10
      completion_tokens: 20,
      total_tokens: 160,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(usage).toEqual({ model: 'x', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 });
  });

  test('no cache tokens: prompt_tokens_details is omitted entirely, not zeroed', () => {
    const { response } = translateNonStreamingResponse(
      { id: 'msg_1', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
      'x',
    );
    expect(response.usage.prompt_tokens_details).toBeUndefined();
  });
});
