// OpenAI chat-completion request -> Anthropic Messages request.
//
// This module reads the incoming body as `unknown` and pulls fields
// defensively (isRecord/typeof), the same idiom src/pricing.ts already uses
// for external JSON — it never declares a type for the OpenAI request shape
// and parses into it. What IS typed is the Anthropic body this constructs
// (src/providers/anthropic/types.ts's AnthropicMessagesRequestBody and
// friends), because that's a shape this code owns and wants checked.
import { Buffer } from 'node:buffer';
import { isRecord, numberOr, tryParseJson } from '../../json.ts';
import type {
  AnthropicImageBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicMessagesRequestBody,
  AnthropicRequestContentBlock,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
} from './types.ts';

export const DEFAULT_MAX_TOKENS = 4096;

export type RequestTranslationError =
  | { type: 'invalid_request'; message: string }
  | { type: 'unsupported_content'; message: string }
  | { type: 'unsupported_param'; message: string };

export interface TranslatedAnthropicRequest {
  body: AnthropicMessagesRequestBody;
  stream: boolean;
}

export type RequestTranslationResult = { ok: true; value: TranslatedAnthropicRequest } | { ok: false; error: RequestTranslationError };

function err(type: RequestTranslationError['type'], message: string): { ok: false; error: RequestTranslationError } {
  return { ok: false, error: { type, message } };
}

const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function translateImageUrl(url: string): { ok: true; value: AnthropicImageSource } | { ok: false; error: RequestTranslationError } {
  const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (dataUrlMatch) {
    const mediaType = dataUrlMatch[1];
    const data = dataUrlMatch[2];
    if (mediaType === undefined || data === undefined) return err('unsupported_content', 'malformed data: image URL');
    if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return err('unsupported_content', `image media type "${mediaType}" has no Anthropic equivalent`);
    }
    return { ok: true, value: { type: 'base64', media_type: mediaType, data } };
  }
  if (/^https?:\/\//.test(url)) return { ok: true, value: { type: 'url', url } };
  return err('unsupported_content', 'image_url is neither a data: URL nor an http(s) URL');
}

type ContentResult =
  | { ok: true; value: string | Array<AnthropicTextBlock | AnthropicImageBlock> }
  | { ok: false; error: RequestTranslationError };

/** Handles both OpenAI's plain-string content and its content-part-array form. */
function translateContent(content: unknown): ContentResult {
  if (typeof content === 'string') return { ok: true, value: content };
  if (content === null || content === undefined) return { ok: true, value: '' };
  if (!Array.isArray(content)) return err('invalid_request', 'message content must be a string or array of parts');

  const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
  for (const part of content) {
    if (!isRecord(part)) return err('invalid_request', 'content part must be an object');
    if (part['type'] === 'text') {
      if (typeof part['text'] !== 'string') return err('invalid_request', 'text content part missing "text"');
      blocks.push({ type: 'text', text: part['text'] });
    } else if (part['type'] === 'image_url') {
      const imageUrl = part['image_url'];
      const url = isRecord(imageUrl) ? imageUrl['url'] : undefined;
      if (typeof url !== 'string') return err('invalid_request', 'image_url content part missing image_url.url');
      const source = translateImageUrl(url);
      if (!source.ok) return source;
      blocks.push({ type: 'image', source: source.value });
    } else {
      return err('unsupported_content', `content part type "${String(part['type'])}" has no Anthropic equivalent`);
    }
  }
  return { ok: true, value: blocks };
}

type MessageResult = { ok: true; value: AnthropicMessage[] } | { ok: false; error: RequestTranslationError };

function translateMessage(m: Record<string, unknown>): MessageResult {
  const role = m['role'];

  if (role === 'user') {
    const content = translateContent(m['content']);
    if (!content.ok) return content;
    return { ok: true, value: [{ role: 'user', content: content.value }] };
  }

  if (role === 'assistant') {
    const blocks: AnthropicRequestContentBlock[] = [];
    const content = translateContent(m['content']);
    if (!content.ok) return content;
    if (typeof content.value === 'string') {
      if (content.value.length > 0) blocks.push({ type: 'text', text: content.value });
    } else {
      blocks.push(...content.value);
    }

    const toolCalls = m['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!isRecord(call) || !isRecord(call['function'])) {
          return err('invalid_request', 'malformed tool_calls entry');
        }
        const id = call['id'];
        const fn = call['function'];
        const name = fn['name'];
        const argsText = fn['arguments'];
        if (typeof id !== 'string' || typeof name !== 'string' || typeof argsText !== 'string') {
          return err('invalid_request', 'tool_calls entry missing id/function.name/function.arguments');
        }
        const input = tryParseJson(argsText);
        if (input === null && argsText.trim() !== 'null') {
          return err('unsupported_content', `tool call arguments for "${name}" are not valid JSON`);
        }
        blocks.push({ type: 'tool_use', id, name, input });
      }
    }
    return { ok: true, value: [{ role: 'assistant', content: blocks }] };
  }

  if (role === 'tool') {
    const toolCallId = m['tool_call_id'];
    if (typeof toolCallId !== 'string' || !toolCallId) return err('invalid_request', 'tool message missing tool_call_id');
    const content = m['content'] === null || m['content'] === undefined ? { ok: true as const, value: '' } : translateContent(m['content']);
    if (!content.ok) return content;
    return {
      ok: true,
      value: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content: content.value }] }],
    };
  }

  // "function" (legacy pre-tool-calls format) and "developer" both fall
  // through here — neither has a faithful Anthropic equivalent, and neither
  // is silently absorbed into `system` (developer is NOT treated as system).
  return err('unsupported_param', `message role "${String(role)}" has no Anthropic equivalent`);
}

/** Anthropic requires strict user/assistant alternation; this also folds
 * consecutive OpenAI `tool` messages (one per parallel call) into the single
 * `user` turn Anthropic expects for parallel tool results. */
function coalesceAdjacentSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    const blocks = toBlockArray(m.content);
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === m.role) {
      prev.content = toBlockArray(prev.content).concat(blocks);
    } else {
      out.push({ role: m.role, content: blocks });
    }
  }
  return out;
}

function toBlockArray(content: string | AnthropicRequestContentBlock[]): AnthropicRequestContentBlock[] {
  if (typeof content !== 'string') return content;
  return content.length > 0 ? [{ type: 'text', text: content }] : [];
}

function applyParallelFlag(choice: AnthropicToolChoice, parallelToolCalls: unknown): AnthropicToolChoice {
  return parallelToolCalls === false ? { ...choice, disable_parallel_tool_use: true } : choice;
}

function translateTools(toolsRaw: unknown): { ok: true; value: AnthropicTool[] } | { ok: false; error: RequestTranslationError } {
  if (!Array.isArray(toolsRaw)) return err('invalid_request', '"tools" must be an array');
  const tools: AnthropicTool[] = [];
  for (const t of toolsRaw) {
    if (!isRecord(t) || t['type'] !== 'function' || !isRecord(t['function'])) {
      return err('unsupported_param', 'each tool must be {type:"function", function:{...}}');
    }
    const fn = t['function'];
    const name = fn['name'];
    if (typeof name !== 'string' || !name) return err('invalid_request', 'tool.function.name must be a non-empty string');
    const description = typeof fn['description'] === 'string' ? fn['description'] : undefined;
    tools.push({
      name,
      input_schema: fn['parameters'] ?? { type: 'object', properties: {} },
      ...(description !== undefined ? { description } : {}),
    });
  }
  return { ok: true, value: tools };
}

export function translateRequest(rawBody: ArrayBuffer, anthropicModel: string): RequestTranslationResult {
  const parsed = tryParseJson(Buffer.from(rawBody).toString('utf8'));
  if (!isRecord(parsed)) return err('invalid_request', 'request body is not a JSON object');

  const messagesRaw = parsed['messages'];
  if (!Array.isArray(messagesRaw) || messagesRaw.length === 0) {
    return err('invalid_request', '"messages" must be a non-empty array');
  }

  // System message(s), any position, possibly plural — Anthropic's `system`
  // is orthogonal to message position, not a special case of it.
  const systemParts: string[] = [];
  const rest: Record<string, unknown>[] = [];
  for (const m of messagesRaw) {
    if (!isRecord(m)) return err('invalid_request', 'every message must be an object');
    if (m['role'] === 'system') {
      const content = translateContent(m['content']);
      if (!content.ok) return content;
      if (typeof content.value !== 'string') return err('unsupported_content', 'system message content must be text-only');
      systemParts.push(content.value);
    } else {
      rest.push(m);
    }
  }

  const translatedMessages: AnthropicMessage[] = [];
  for (const m of rest) {
    const result = translateMessage(m);
    if (!result.ok) return result;
    translatedMessages.push(...result.value);
  }

  const coalesced = coalesceAdjacentSameRole(translatedMessages);
  if (coalesced.length === 0) return err('invalid_request', 'no user/assistant content after translation');
  const first: AnthropicMessage | undefined = coalesced[0];
  if (first === undefined || first.role !== 'user') return err('invalid_request', 'conversation must start with a user message');

  // tools / tool_choice
  const toolsRaw = parsed['tools'];
  let tools: AnthropicTool[] | undefined;
  if (toolsRaw !== undefined) {
    const result = translateTools(toolsRaw);
    if (!result.ok) return result;
    tools = result.value;
  }

  const parallelToolCalls = parsed['parallel_tool_calls'];
  const toolChoiceRaw = parsed['tool_choice'];
  let toolChoice: AnthropicToolChoice | undefined;
  let dropTools = false;
  if (toolChoiceRaw === 'none') {
    dropTools = true;
  } else if (toolChoiceRaw === 'required') {
    toolChoice = applyParallelFlag({ type: 'any' }, parallelToolCalls);
  } else if (isRecord(toolChoiceRaw) && toolChoiceRaw['type'] === 'function' && isRecord(toolChoiceRaw['function'])) {
    const name = toolChoiceRaw['function']['name'];
    if (typeof name !== 'string' || !name) return err('invalid_request', 'tool_choice.function.name must be a non-empty string');
    toolChoice = applyParallelFlag({ type: 'tool', name }, parallelToolCalls);
  } else if (toolChoiceRaw === 'auto' || toolChoiceRaw === undefined) {
    if (parallelToolCalls === false) toolChoice = applyParallelFlag({ type: 'auto' }, parallelToolCalls);
  } else {
    return err('unsupported_param', `unsupported tool_choice: ${JSON.stringify(toolChoiceRaw)}`);
  }

  // sampling params
  const maxTokens = numberOr(parsed['max_completion_tokens'], numberOr(parsed['max_tokens'], DEFAULT_MAX_TOKENS));
  const temperature = typeof parsed['temperature'] === 'number' ? parsed['temperature'] : undefined;
  const topP = typeof parsed['top_p'] === 'number' ? parsed['top_p'] : undefined;

  const stopRaw = parsed['stop'];
  let stopSequences: string[] | undefined;
  if (typeof stopRaw === 'string') stopSequences = [stopRaw];
  else if (Array.isArray(stopRaw) && stopRaw.every((s) => typeof s === 'string')) stopSequences = stopRaw as string[];
  else if (stopRaw !== undefined && stopRaw !== null) return err('invalid_request', '"stop" must be a string or an array of strings');

  const stream = parsed['stream'] === true;
  const user = typeof parsed['user'] === 'string' ? parsed['user'] : undefined;

  // Reject what can't be honored rather than silently approximate it.
  const presence = parsed['presence_penalty'];
  if (typeof presence === 'number' && presence !== 0) return err('unsupported_param', 'presence_penalty has no Anthropic equivalent');
  const frequency = parsed['frequency_penalty'];
  if (typeof frequency === 'number' && frequency !== 0) return err('unsupported_param', 'frequency_penalty has no Anthropic equivalent');
  if (parsed['logprobs'] === true) return err('unsupported_param', 'logprobs has no Anthropic equivalent');
  if (parsed['top_logprobs'] !== undefined) return err('unsupported_param', 'top_logprobs has no Anthropic equivalent');
  const n = parsed['n'];
  if (typeof n === 'number' && n > 1) return err('unsupported_param', 'n > 1 is not supported');
  const logitBias = parsed['logit_bias'];
  if (isRecord(logitBias) && Object.keys(logitBias).length > 0) return err('unsupported_param', 'logit_bias has no Anthropic equivalent');
  const responseFormat = parsed['response_format'];
  if (isRecord(responseFormat) && responseFormat['type'] !== 'text') {
    return err('unsupported_param', 'response_format other than "text" is not supported');
  }
  // `seed`: silently dropped — a best-effort determinism hint even on real OpenAI, not a contract.

  const body: AnthropicMessagesRequestBody = {
    model: anthropicModel,
    messages: coalesced,
    max_tokens: maxTokens,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    ...(!dropTools && tools !== undefined ? { tools } : {}),
    ...(!dropTools && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(stopSequences !== undefined ? { stop_sequences: stopSequences } : {}),
    ...(stream ? { stream: true } : {}),
    ...(user !== undefined ? { metadata: { user_id: user } } : {}),
  };

  return { ok: true, value: { body, stream } };
}
