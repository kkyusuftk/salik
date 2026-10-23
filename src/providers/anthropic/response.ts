// Anthropic Messages response (non-streaming) -> OpenAI chat-completion response.
import { usageFromAnthropicObject } from '../../pricing.ts';
import { isRecord } from '../../json.ts';
import type { ExtractedUsage } from '../../wire.ts';
import type { OpenAiChatResponse, OpenAiToolCall, OpenAiUsage } from './types.ts';

export interface AnthropicToOpenAiResult {
  response: OpenAiChatResponse;
  usage: ExtractedUsage;
}

const FINISH_REASON: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop', // no OpenAI concept of a resumable server-tool pause — best-effort
};

function mapFinishReason(stopReason: string | null): string {
  return stopReason === null ? 'stop' : (FINISH_REASON[stopReason] ?? 'stop');
}

function toOpenAiUsage(promptTokens: number, completionTokens: number, cacheReadTokens: number): OpenAiUsage {
  const usage: OpenAiUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  if (cacheReadTokens > 0) usage.prompt_tokens_details = { cached_tokens: cacheReadTokens };
  return usage;
}

export function translateNonStreamingResponse(anthropicBody: Record<string, unknown>, servedModelId: string): AnthropicToOpenAiResult {
  // Reuses the same Anthropic-usage parsing pricing.ts already relies on for
  // the native /v1/messages surface — cache reads/writes are disjoint from
  // input_tokens on Anthropic's side (unlike OpenAI, which folds them in).
  const extracted = usageFromAnthropicObject(anthropicBody);
  const promptTokens = extracted.inputTokens + extracted.cacheReadTokens + extracted.cacheWriteTokens;

  const contentRaw = Array.isArray(anthropicBody['content']) ? anthropicBody['content'] : [];
  let text = '';
  const toolCalls: OpenAiToolCall[] = [];
  for (const block of contentRaw) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      text += block['text'];
    } else if (block['type'] === 'tool_use') {
      const id = block['id'];
      const name = block['name'];
      if (typeof id === 'string' && typeof name === 'string') {
        toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(block['input'] ?? {}) } });
      }
    }
    // `thinking` / `redacted_thinking` blocks: dropped — OpenAI's schema has no slot for them.
  }

  const stopReason = typeof anthropicBody['stop_reason'] === 'string' ? anthropicBody['stop_reason'] : null;
  const anthropicId = typeof anthropicBody['id'] === 'string' ? anthropicBody['id'] : 'unknown';

  const response: OpenAiChatResponse = {
    id: `chatcmpl-${anthropicId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    // The public registry id of whichever model actually served this call —
    // the primary's id on a normal call, the fallback's own id when it
    // served instead. Never the raw upstream model string (an aliasing/
    // fallback config detail the client shouldn't need to know about).
    model: servedModelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(stopReason),
      },
    ],
    usage: toOpenAiUsage(promptTokens, extracted.outputTokens, extracted.cacheReadTokens),
  };

  const usage: ExtractedUsage = {
    model: servedModelId,
    inputTokens: extracted.inputTokens,
    outputTokens: extracted.outputTokens,
    cacheReadTokens: extracted.cacheReadTokens,
    cacheWriteTokens: extracted.cacheWriteTokens,
  };

  return { response, usage };
}
