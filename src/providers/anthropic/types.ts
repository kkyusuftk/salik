// Narrow, OUTPUT-side wire types only — what request.ts/response.ts *construct*
// and want type-checked. Inputs (an incoming OpenAI request, an incoming
// Anthropic response) are read defensively via Record<string, unknown> +
// isRecord/typeof guards, the same idiom src/pricing.ts already uses for
// external JSON — there is no pre-declared "OpenAiChatRequest" input type to
// parse into, on purpose. See the module-level note in index.ts for why
// typing bodies here doesn't violate the passthrough invariant that governs
// src/routes/*.ts and src/upstream.ts.

// ---------------------------------------------------------------- Anthropic request (constructed)

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageSourceBase64 {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface AnthropicImageSourceUrl {
  type: 'url';
  url: string;
}

export type AnthropicImageSource = AnthropicImageSourceBase64 | AnthropicImageSourceUrl;

export interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
}

export type AnthropicRequestContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export type AnthropicRole = 'user' | 'assistant';

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicRequestContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicMessagesRequestBody {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id: string };
}

// ---------------------------------------------------------------- OpenAI response (constructed)

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export interface OpenAiChatResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}

export interface OpenAiChatResponseChoice {
  index: 0;
  message: OpenAiChatResponseMessage;
  finish_reason: string;
}

export interface OpenAiChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [OpenAiChatResponseChoice];
  usage: OpenAiUsage;
}
