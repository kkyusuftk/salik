// Pure unit tests for the Anthropic SSE -> OpenAI SSE streaming state
// machine. No HTTP layer — feeds a synthetic ReadableStream directly into
// translateStreamingResponse() and inspects the resulting SSE text.
import { describe, expect, test } from 'bun:test';
import { translateStreamingResponse } from '../../src/providers/anthropic/stream.ts';

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function fakeStreamFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function fakeStreamFromEvents(events: unknown[]): Response {
  return fakeStreamFromChunks(events.map((e) => sseChunk(e)));
}

/** Raw `data: ` payload strings, in arrival order — `[DONE]` included verbatim, everything else still JSON text. */
async function collectDataPayloads(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice('data: '.length));
}

const messageStart = {
  type: 'message_start',
  message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 50, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 0 } },
};
const textBlockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const blockStop = { type: 'content_block_stop', index: 0 };
const messageDelta = (stopReason: string, outputTokens: number) => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason },
  usage: { output_tokens: outputTokens },
});
const messageStop = { type: 'message_stop' };

describe('translateStreamingResponse: plain text', () => {
  test('emits a role-delta first chunk, then content deltas, then finish + usage chunks, then [DONE]', async () => {
    const events = [messageStart, textBlockStart, textDelta('Hel'), textDelta('lo'), blockStop, messageDelta('end_turn', 7), messageStop];
    const { response } = translateStreamingResponse(fakeStreamFromEvents(events), { servedModelId: 'my-alias' });
    const payloads = await collectDataPayloads(response);

    expect(payloads).toHaveLength(6); // role, "Hel", "lo", finish, usage, [DONE]
    expect(payloads[5]).toBe('[DONE]');

    const parsed = payloads.slice(0, 5).map((p) => JSON.parse(p));
    expect(parsed[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(parsed[0].model).toBe('my-alias');
    expect(parsed[1].choices[0].delta).toEqual({ content: 'Hel' });
    expect(parsed[2].choices[0].delta).toEqual({ content: 'lo' });
    expect(parsed[3].choices[0].finish_reason).toBe('stop');
    expect(parsed[4].choices).toEqual([]);
    expect(parsed[4].usage).toEqual({
      prompt_tokens: 57, // 50 input + 5 cache-read + 2 cache-write
      completion_tokens: 7,
      total_tokens: 64,
      prompt_tokens_details: { cached_tokens: 5 },
    });
  });

  test('a single data: line split across two physical stream chunks is still correctly reassembled', async () => {
    const line = sseChunk(textDelta('Hel'));
    const mid = Math.floor(line.length / 2); // well inside the JSON body, not at a newline
    const response = fakeStreamFromChunks([sseChunk(messageStart), sseChunk(textBlockStart), line.slice(0, mid), line.slice(mid)]);
    const { response: translated } = translateStreamingResponse(response, { servedModelId: 'x' });
    const payloads = await collectDataPayloads(translated);
    const contentPayload = payloads.map((p) => (p === '[DONE]' ? null : JSON.parse(p))).find((p) => p?.choices?.[0]?.delta?.content === 'Hel');
    expect(contentPayload).toBeDefined();
  });
});

describe('translateStreamingResponse: tool calls', () => {
  test('tool_use block start sends id/name once; subsequent input_json_delta fragments repeat only index+arguments', async () => {
    const toolBlockStart = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'getWeather' } };
    const argsDelta = (partial: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } });
    const events = [messageStart, toolBlockStart, argsDelta('{"city":'), argsDelta('"Dubai"}'), blockStop, messageDelta('tool_use', 3), messageStop];
    const { response } = translateStreamingResponse(fakeStreamFromEvents(events), { servedModelId: 'x' });
    const payloads = (await collectDataPayloads(response)).filter((p) => p !== '[DONE]').map((p) => JSON.parse(p));

    const toolStartChunk = payloads[1];
    expect(toolStartChunk.choices[0].delta.tool_calls).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'getWeather', arguments: '' } },
    ]);
    const firstFragment = payloads[2];
    expect(firstFragment.choices[0].delta.tool_calls).toEqual([{ index: 0, function: { arguments: '{"city":' } }]);
    const secondFragment = payloads[3];
    expect(secondFragment.choices[0].delta.tool_calls).toEqual([{ index: 0, function: { arguments: '"Dubai"}' } }]);
    expect(payloads[4].choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('translateStreamingResponse: mid-stream failure', () => {
  test('an explicit Anthropic error event becomes a salik_stream_error line, followed by [DONE] — never a fake "stop"', async () => {
    const errorEvent = { type: 'error', error: { type: 'overloaded_error', message: 'overloaded, try again' } };
    const events = [messageStart, textBlockStart, textDelta('partial'), errorEvent];
    const { response } = translateStreamingResponse(fakeStreamFromEvents(events), { servedModelId: 'x' });
    const payloads = await collectDataPayloads(response);

    expect(payloads[payloads.length - 1]).toBe('[DONE]');
    const errorPayload = JSON.parse(payloads[payloads.length - 2]!);
    expect(errorPayload).toEqual({ error: { type: 'salik_stream_error', message: 'overloaded, try again' } });
    // No finish_reason chunk was ever sent — the stream never claimed a clean stop.
    expect(payloads.some((p) => p !== '[DONE]' && JSON.parse(p).choices?.[0]?.finish_reason)).toBe(false);
  });

  test('a silent disconnect (stream just ends, no message_delta or error) also produces an honest error line, not a fake "stop"', async () => {
    const events = [messageStart, textBlockStart, textDelta('hi')];
    const { response } = translateStreamingResponse(fakeStreamFromEvents(events), { servedModelId: 'x' });
    const payloads = await collectDataPayloads(response);

    expect(payloads[payloads.length - 1]).toBe('[DONE]');
    const errorPayload = JSON.parse(payloads[payloads.length - 2]!);
    expect(errorPayload.error.type).toBe('salik_stream_error');
    expect(errorPayload.error.message).toMatch(/unexpectedly/);
  });

  test('[DONE] is always the last line, even on a totally empty stream', async () => {
    const { response } = translateStreamingResponse(fakeStreamFromEvents([]), { servedModelId: 'x' });
    const payloads = await collectDataPayloads(response);
    expect(payloads[payloads.length - 1]).toBe('[DONE]');
  });
});

describe('translateStreamingResponse: usage promise', () => {
  test('resolves the exact same usage numbers once the stream fully drains', async () => {
    const events = [messageStart, textBlockStart, textDelta('hi'), blockStop, messageDelta('end_turn', 9), messageStop];
    const { response, usage } = translateStreamingResponse(fakeStreamFromEvents(events), { servedModelId: 'my-alias' });
    await response.text(); // drain fully so flush() runs and resolves `usage`
    expect(await usage).toEqual({ model: 'my-alias', inputTokens: 50, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 2 });
  });
});
