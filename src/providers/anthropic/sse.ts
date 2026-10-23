// SSE line-buffering + event framing for an Anthropic streaming response.
// Two small TransformStreams, each independently testable with a synthetic
// ReadableStream. Anthropic's own `data:` lines are never split across
// multiple SSE fields for one event (one `data:` line = one complete JSON
// payload — the same fact src/pricing.ts's extractAnthropicUsage already
// relies on), so the only framing boundary that needs cross-chunk buffering
// is "a complete line," not a full blank-line-terminated SSE record.
import { isRecord, tryParseJson } from '../../json.ts';

export function createLineSplitter(): TransformStream<string, string> {
  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // trailing partial line held across chunk boundaries
      for (const line of lines) controller.enqueue(line.endsWith('\r') ? line.slice(0, -1) : line);
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    },
  });
}

export interface AnthropicSseEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Keys off the JSON payload's own `type` field rather than a `event:` SSE
 * line, matching pricing.ts's existing approach — malformed/non-JSON lines
 * and anything without a string `type` are silently skipped, not fatal. */
export function createAnthropicEventParser(): TransformStream<string, AnthropicSseEvent> {
  return new TransformStream({
    transform(line, controller) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = tryParseJson(trimmed.slice('data:'.length).trim());
      if (isRecord(payload) && typeof payload['type'] === 'string') {
        controller.enqueue({ type: payload['type'], payload });
      }
    },
  });
}
