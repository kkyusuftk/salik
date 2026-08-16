// Wire-compatible stands-in for Ollama, Anthropic, and OpenAI — and the
// reason the suite is deterministic rather than racing a real model.
// Extends the contract trip-agent/tests/fake-ollama.mjs established: record
// every call (so a test can assert on what was actually SENT, not just the
// outcome — the only way to catch `think:false` or a `format` schema being
// silently dropped), and support hanging responses for the preemption and
// client-abort suites.
export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: Buffer;
}

// Every variant field is required (not optional) so constructing one never
// runs into exactOptionalPropertyTypes friction — see the helper functions
// below for the ergonomic, defaulted way to build one.
export type ScriptedResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'raw'; status: number; headers: Record<string, string>; body: string | Uint8Array }
  | { kind: 'stream'; status: number; headers: Record<string, string>; chunks: (string | Uint8Array)[]; delayMs: number }
  | { kind: 'hang' };

export const jsonResponse = (body: unknown, status = 200): ScriptedResponse => ({ kind: 'json', status, body });

export const rawResponse = (body: string | Uint8Array, opts: { status?: number; headers?: Record<string, string> } = {}): ScriptedResponse => ({
  kind: 'raw',
  status: opts.status ?? 200,
  headers: opts.headers ?? {},
  body,
});

export const streamResponse = (
  chunks: (string | Uint8Array)[],
  opts: { status?: number; headers?: Record<string, string>; delayMs?: number } = {},
): ScriptedResponse => ({
  kind: 'stream',
  status: opts.status ?? 200,
  headers: opts.headers ?? {},
  chunks,
  delayMs: opts.delayMs ?? 5,
});

export const HANG: ScriptedResponse = { kind: 'hang' };

export type Script = (call: RecordedCall) => ScriptedResponse;

export interface FakeUpstream {
  url: string;
  calls: RecordedCall[];
  lastCall: () => RecordedCall | undefined;
  /** Overrides the default response for every subsequent call until reset. */
  setScript: (fn: Script | null) => void;
  setDefaultResponse: (resp: ScriptedResponse) => void;
  stop: () => void;
}

function respond(resp: ScriptedResponse): Response | Promise<Response> {
  switch (resp.kind) {
    case 'hang':
      // Never resolves. The client (Salik, or a test's own fetch) gives up by
      // aborting its own signal — this fake never has to notice on its own.
      return new Promise<Response>(() => {});
    case 'json':
      return Response.json(resp.body, { status: resp.status });
    case 'raw':
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    case 'stream': {
      const encoder = new TextEncoder();
      const { chunks, delayMs } = resp;
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: resp.status, headers: resp.headers });
    }
  }
}

function defaultResponseFor(kind: 'ollama' | 'anthropic' | 'openai'): ScriptedResponse {
  switch (kind) {
    case 'ollama':
      return jsonResponse({
        model: 'gemma4:12b',
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      });
    case 'anthropic':
      return jsonResponse({
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    case 'openai':
      return jsonResponse({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        model: 'gpt-fake',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
  }
}

export function createFakeUpstream(kind: 'ollama' | 'anthropic' | 'openai'): FakeUpstream {
  const calls: RecordedCall[] = [];
  let script: Script | null = null;
  let fallback = defaultResponseFor(kind);

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await req.arrayBuffer());
      const call: RecordedCall = {
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        rawBody,
      };
      calls.push(call);
      return respond(script?.(call) ?? fallback);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    lastCall: () => calls.at(-1),
    setScript: (fn) => {
      script = fn;
    },
    setDefaultResponse: (resp) => {
      fallback = resp;
    },
    stop: () => {
      server.stop(true);
    },
  };
}
