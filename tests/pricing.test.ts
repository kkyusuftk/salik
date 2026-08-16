// Pure logic, no server involved: usage extraction per surface and cost
// arithmetic, including the cache-token multipliers and the Sonnet 5
// introductory-rate rollover PLAN.md calls out by date.
import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'bun:test';
import {
  computeCost,
  costFor,
  extractAnthropicUsage,
  extractOllamaUsage,
  extractOpenAiUsage,
  priceFor,
  readModelHint,
} from '../src/pricing.ts';
import type { PriceTable, Usage } from '../src/types.ts';

const PRICES: PriceTable = {
  'claude-sonnet-5': [
    { until: '2026-08-31', input: 2.0, output: 10.0 },
    { input: 3.0, output: 15.0 },
  ],
  'claude-opus-5': [{ input: 5.0, output: 25.0 }],
  'gemma4:12b': [{ input: 0, output: 0 }],
};

describe('priceFor — Sonnet 5 introductory-rate rollover', () => {
  test('the day of the deadline still gets the introductory rate', () => {
    const entry = priceFor(PRICES, 'claude-sonnet-5', new Date('2026-08-31T23:00:00Z'));
    expect(entry).toEqual({ until: '2026-08-31', input: 2.0, output: 10.0 });
  });

  test('the day after rolls over to the standing rate', () => {
    const entry = priceFor(PRICES, 'claude-sonnet-5', new Date('2026-09-01T00:30:00Z'));
    expect(entry).toEqual({ input: 3.0, output: 15.0 });
  });

  test('well before the deadline still gets the introductory rate', () => {
    const entry = priceFor(PRICES, 'claude-sonnet-5', new Date('2026-08-01T00:00:00Z'));
    expect(entry?.input).toBe(2.0);
  });

  test('a model with a single open-ended entry ignores the date entirely', () => {
    const entry = priceFor(PRICES, 'claude-opus-5', new Date('2099-01-01T00:00:00Z'));
    expect(entry).toEqual({ input: 5.0, output: 25.0 });
  });

  test('an unknown model has no price', () => {
    expect(priceFor(PRICES, 'gpt-mystery-model')).toBeNull();
  });
});

describe('costFor — cache tokens price differently from plain input', () => {
  const entry = { input: 3.0, output: 15.0 }; // $/M tokens

  test('plain input and output at the listed rate', () => {
    const usage: Usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costFor(entry, usage)).toBeCloseTo(3.0 + 15.0, 6);
  });

  test('cache reads are priced at 0.1x the input rate', () => {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
    expect(costFor(entry, usage)).toBeCloseTo(0.3, 6);
  });

  test('cache writes are priced at 1.25x the input rate', () => {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
    expect(costFor(entry, usage)).toBeCloseTo(3.75, 6);
  });

  test('a mixed realistic request sums all four components independently', () => {
    // job-agent's llm.mjs pattern: a large cached system prompt, a small fresh
    // user turn, cache hits on every subsequent call in the run.
    const usage: Usage = { inputTokens: 200, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 0 };
    const expected = 200 * (3.0 / 1e6) + 4000 * (3.0 / 1e6) * 0.1 + 50 * (15.0 / 1e6);
    expect(costFor(entry, usage)).toBeCloseTo(expected, 10);
  });
});

describe('computeCost', () => {
  test('null model means no cost, not zero cost', () => {
    expect(computeCost(PRICES, null, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  test('an unpriced model means no cost, not zero cost', () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(computeCost(PRICES, 'gpt-5-mini', usage)).toBeNull();
  });

  test('a genuinely free local model is zero, distinctly from null', () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(computeCost(PRICES, 'gemma4:12b', usage)).toBe(0);
  });

  test('the rollover date is honoured end to end, not just in priceFor', () => {
    const usage: Usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(computeCost(PRICES, 'claude-sonnet-5', usage, new Date('2026-08-31T00:00:00Z'))).toBeCloseTo(2.0, 6);
    expect(computeCost(PRICES, 'claude-sonnet-5', usage, new Date('2026-09-01T00:00:00Z'))).toBeCloseTo(3.0, 6);
  });
});

describe('extractAnthropicUsage', () => {
  test('non-streaming: reads usage straight off the response object', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
      }),
    );
    expect(extractAnthropicUsage(body)).toEqual({
      model: 'claude-sonnet-5',
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
  });

  test('streaming: input/cache tokens come from message_start, output tokens from the closing message_delta', () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
        },
      })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');

    expect(extractAnthropicUsage(Buffer.from(sse))).toEqual({
      model: 'claude-sonnet-5',
      inputTokens: 50,
      outputTokens: 25, // the closing total, not message_start's placeholder of 1
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
    });
  });

  test('garbage input degrades to zeroed usage rather than throwing', () => {
    expect(extractAnthropicUsage(Buffer.from('not json at all'))).toEqual({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('extractOpenAiUsage', () => {
  test('non-streaming: cached tokens are backed out of prompt_tokens, not double-counted', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-fake',
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
      }),
    );
    expect(extractOpenAiUsage(body)).toEqual({
      model: 'gpt-fake',
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
  });

  test('streaming with stream_options.include_usage: usage rides the final chunk', () => {
    const sse = [
      `data: ${JSON.stringify({ id: 'c1', model: 'gpt-fake', choices: [{ index: 0, delta: { content: 'Hi' } }] })}`,
      `data: ${JSON.stringify({ id: 'c1', model: 'gpt-fake', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    expect(extractOpenAiUsage(Buffer.from(sse))).toEqual({
      model: 'gpt-fake',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test('streaming WITHOUT stream_options.include_usage: no usage anywhere is an honest zero, not a guess', () => {
    const sse = [
      `data: ${JSON.stringify({ id: 'c1', model: 'gpt-fake', choices: [{ index: 0, delta: { content: 'Hi' } }] })}`,
      `data: ${JSON.stringify({ id: 'c1', model: 'gpt-fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    const result = extractOpenAiUsage(Buffer.from(sse));
    expect(result.model).toBe('gpt-fake');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe('extractOllamaUsage', () => {
  test('non-streaming: prompt_eval_count / eval_count map to input/output tokens', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gemma4:12b', done: true, prompt_eval_count: 40, eval_count: 8 }));
    expect(extractOllamaUsage(body)).toEqual({ model: 'gemma4:12b', inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test('NDJSON streaming: the final done:true line carries the cumulative counts', () => {
    const ndjson = [
      JSON.stringify({ model: 'gemma4:12b', message: { role: 'assistant', content: 'Hel' }, done: false }),
      JSON.stringify({ model: 'gemma4:12b', message: { role: 'assistant', content: 'lo' }, done: false }),
      JSON.stringify({ model: 'gemma4:12b', done: true, prompt_eval_count: 40, eval_count: 8 }),
      '',
    ].join('\n');
    expect(extractOllamaUsage(Buffer.from(ndjson))).toEqual({ model: 'gemma4:12b', inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('readModelHint', () => {
  test('reads model out of a well-formed body', () => {
    const body = new TextEncoder().encode(JSON.stringify({ model: 'gemma4:12b', messages: [] })).buffer;
    expect(readModelHint(body)).toBe('gemma4:12b');
  });

  test('a bodyless GET (health probe) has no model, not an error', () => {
    expect(readModelHint(new ArrayBuffer(0))).toBeNull();
  });

  test('malformed JSON degrades to null rather than throwing', () => {
    const body = new TextEncoder().encode('{not json').buffer;
    expect(readModelHint(body)).toBeNull();
  });
});
