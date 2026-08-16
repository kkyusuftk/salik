// Anthropic SSE -> OpenAI SSE, streaming. A TransformStream pipeline —
// TextDecoderStream -> line-splitter -> event-parser -> this chunk state
// machine -> TextEncoderStream — using Bun's native WHATWG streams: correct
// backpressure and multi-byte-UTF-8-boundary handling for free, no new
// dependency, and each stage independently testable with a synthetic
// ReadableStream.
import { numberOr } from '../../pricing.ts';
import { isRecord, type ExtractedUsage } from '../../types.ts';
import { createAnthropicEventParser, createLineSplitter, type AnthropicSseEvent } from './sse.ts';

const FINISH_REASON: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

function mapFinishReason(stopReason: string | undefined): string {
  return stopReason === undefined ? 'stop' : (FINISH_REASON[stopReason] ?? 'stop');
}

type BlockState = { kind: 'text' } | { kind: 'tool_use'; openaiIndex: number } | { kind: 'drop' };

interface StreamState {
  id: string;
  created: number;
  servedModelId: string;
  nextToolCallIndex: number;
  blocks: Map<number, BlockState>;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  finishReasonSent: boolean;
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunkLine(state: StreamState, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return sseLine({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.servedModelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function emitErrorLine(message: string): string {
  return sseLine({ error: { type: 'salik_stream_error', message } });
}

function handleEvent(event: AnthropicSseEvent, state: StreamState, controller: TransformStreamDefaultController<string>): void {
  const { type, payload } = event;

  if (type === 'message_start') {
    const message = payload['message'];
    if (isRecord(message)) {
      const usage = message['usage'];
      if (isRecord(usage)) {
        state.inputTokens = numberOr(usage['input_tokens'], state.inputTokens);
        state.cacheReadTokens = numberOr(usage['cache_read_input_tokens'], state.cacheReadTokens);
        state.cacheWriteTokens = numberOr(usage['cache_creation_input_tokens'], state.cacheWriteTokens);
      }
    }
    // OpenAI clients expect a role delta in the very first chunk.
    controller.enqueue(chunkLine(state, { role: 'assistant', content: '' }));
    return;
  }

  if (type === 'content_block_start') {
    const index = numberOr(payload['index'], -1);
    const block = payload['content_block'];
    const blockType = isRecord(block) ? block['type'] : undefined;
    if (blockType === 'text') {
      state.blocks.set(index, { kind: 'text' });
    } else if (blockType === 'tool_use' && isRecord(block)) {
      const openaiIndex = state.nextToolCallIndex++;
      state.blocks.set(index, { kind: 'tool_use', openaiIndex });
      const id = typeof block['id'] === 'string' ? block['id'] : '';
      const name = typeof block['name'] === 'string' ? block['name'] : '';
      // id/name sent once here — matches real OpenAI streaming convention of
      // only repeating `index` + argument fragments in subsequent chunks.
      controller.enqueue(
        chunkLine(state, { tool_calls: [{ index: openaiIndex, id, type: 'function', function: { name, arguments: '' } }] }),
      );
    } else {
      // thinking/redacted_thinking/anything future: dropped, not fatal.
      state.blocks.set(index, { kind: 'drop' });
    }
    return;
  }

  if (type === 'content_block_delta') {
    const index = numberOr(payload['index'], -1);
    const block = state.blocks.get(index);
    const delta = payload['delta'];
    if (!isRecord(delta) || block === undefined) return;
    if (block.kind === 'text' && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
      controller.enqueue(chunkLine(state, { content: delta['text'] }));
    } else if (block.kind === 'tool_use' && delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
      // Forwarded verbatim, per-chunk — matches real OpenAI streaming tool
      // calls, where the client already concatenates argument fragments and
      // parses only once complete. No server-side JSON buffering needed.
      controller.enqueue(chunkLine(state, { tool_calls: [{ index: block.openaiIndex, function: { arguments: delta['partial_json'] } }] }));
    }
    return;
  }

  if (type === 'message_delta') {
    const usage = payload['usage'];
    if (isRecord(usage)) state.outputTokens = numberOr(usage['output_tokens'], state.outputTokens);
    const delta = payload['delta'];
    const stopReason = isRecord(delta) && typeof delta['stop_reason'] === 'string' ? delta['stop_reason'] : undefined;

    controller.enqueue(chunkLine(state, {}, mapFinishReason(stopReason)));
    // Always sent (not gated on stream_options.include_usage): the real
    // numbers are already in hand at zero extra cost, a choices:[] chunk is
    // inert to any spec-compliant client that isn't looking for it, and it's
    // what lets meter.ts extract correct usage unmodified.
    const promptTokens = state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens;
    controller.enqueue(
      sseLine({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.servedModelId,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: state.outputTokens,
          total_tokens: promptTokens + state.outputTokens,
          ...(state.cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: state.cacheReadTokens } } : {}),
        },
      }),
    );
    state.finishReasonSent = true;
    return;
  }

  if (type === 'error') {
    const error = payload['error'];
    const message = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : 'upstream stream error';
    controller.enqueue(emitErrorLine(message));
    state.finishReasonSent = true;
    return;
  }

  // content_block_stop, message_stop, ping, and anything unrecognized:
  // no-op — forward-compatible by design.
}

export interface StreamTranslationResult {
  response: Response;
  /** Resolves once the stream fully drains. meter.ts doesn't need this — it
   * extracts usage from the OpenAI-shaped bytes exactly as today — but it's
   * a free, exact channel if a future caller wants it. */
  usage: Promise<ExtractedUsage>;
}

export function translateStreamingResponse(anthropicResponse: Response, ctx: { servedModelId: string }): StreamTranslationResult {
  const state: StreamState = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    servedModelId: ctx.servedModelId,
    nextToolCallIndex: 0,
    blocks: new Map(),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    finishReasonSent: false,
  };

  let resolveUsage: (u: ExtractedUsage) => void = () => {};
  const usage = new Promise<ExtractedUsage>((resolve) => {
    resolveUsage = resolve;
  });

  const chunkTransform = new TransformStream<AnthropicSseEvent, string>({
    transform(event, controller) {
      try {
        handleEvent(event, state, controller);
      } catch {
        // A hand-rolled parser over external SSE input must never let a
        // throw here tear down the client's connection — drop the one
        // malformed event and keep going.
      }
    },
    flush(controller) {
      // Neither a clean message_delta nor an explicit `error` event fired —
      // a true silent disconnect. Same code path as an explicit error: an
      // honest error line, never a fake `finish_reason:"stop"`.
      if (!state.finishReasonSent) controller.enqueue(emitErrorLine('upstream stream ended unexpectedly'));
      // Unconditional, whatever caused the stream to end — OpenAI client
      // SDKs commonly loop until they see this literal line; a stream that
      // never sends it can hang a naive parser indefinitely.
      controller.enqueue('data: [DONE]\n\n');
      resolveUsage({
        model: state.servedModelId,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
      });
    },
  });

  const upstreamBody = anthropicResponse.body ?? new ReadableStream({ start: (c) => c.close() });
  const body = upstreamBody
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(createLineSplitter())
    .pipeThrough(createAnthropicEventParser())
    .pipeThrough(chunkTransform)
    .pipeThrough(new TextEncoderStream());

  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  return { response, usage };
}
