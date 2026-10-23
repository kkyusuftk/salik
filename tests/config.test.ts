// config/*.json is validated once at startup (server/server.ts) and typed
// thereafter — this is what makes that trustworthy: a malformed file must
// refuse to start rather than run with a silently-wrong client list.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseKeysFile, parseModelRegistry, parsePriceTable, parseSettings } from '../src/config.ts';

describe('parseKeysFile', () => {
  const valid = {
    upstreamKeys: { anthropic: 'sk-ant-test', openai: 'sk-test' },
    clients: [{ token: 'tok-1', name: 'portfolio', tier: 'interactive', dailyBudgetUsd: 2.0 }],
  };

  test('accepts a well-formed file', () => {
    const parsed = parseKeysFile(valid, 'test');
    expect(parsed.clients).toHaveLength(1);
    expect(parsed.clients[0]).toEqual({ token: 'tok-1', name: 'portfolio', tier: 'interactive', dailyBudgetUsd: 2.0, debug: false });
  });

  test('debug defaults to false when absent, but is honoured when present', () => {
    const parsed = parseKeysFile(
      { ...valid, clients: [{ ...valid.clients[0], debug: true }] },
      'test',
    );
    expect(parsed.clients[0]?.debug).toBe(true);
  });

  test('rejects a duplicate client token', () => {
    const dup = { ...valid, clients: [...valid.clients, { ...valid.clients[0], name: 'other' }] };
    expect(() => parseKeysFile(dup, 'test')).toThrow(/duplicate client token/);
  });

  test('rejects an unrecognised tier', () => {
    const bad = { ...valid, clients: [{ ...valid.clients[0], tier: 'urgent' }] };
    expect(() => parseKeysFile(bad, 'test')).toThrow(/tier must be one of/);
  });

  test('rejects a negative daily budget', () => {
    const bad = { ...valid, clients: [{ ...valid.clients[0], dailyBudgetUsd: -1 }] };
    expect(() => parseKeysFile(bad, 'test')).toThrow(/dailyBudgetUsd/);
  });

  test('rejects a missing upstreamKeys block', () => {
    const { upstreamKeys, ...rest } = valid;
    expect(() => parseKeysFile(rest, 'test')).toThrow(/upstreamKeys/);
  });

  test('rejects a non-object payload entirely', () => {
    expect(() => parseKeysFile('not an object', 'test')).toThrow(/expected a JSON object/);
    expect(() => parseKeysFile(null, 'test')).toThrow(/expected a JSON object/);
  });
});

describe('parsePriceTable', () => {
  test('accepts a well-formed table, including a comment key', () => {
    const table = parsePriceTable(
      {
        _comment: 'ignored',
        'claude-sonnet-5': [
          { until: '2026-08-31', input: 2, output: 10 },
          { input: 3, output: 15 },
        ],
      },
      'test',
    );
    expect(table['claude-sonnet-5']).toHaveLength(2);
    expect(Object.keys(table)).not.toContain('_comment');
  });

  test('rejects a model whose last rate period still has an "until"', () => {
    expect(() =>
      parsePriceTable({ 'claude-sonnet-5': [{ until: '2026-08-31', input: 2, output: 10 }] }, 'test'),
    ).toThrow(/must have no "until"/);
  });

  test('rejects a model with an empty rate-period array', () => {
    expect(() => parsePriceTable({ 'claude-sonnet-5': [] }, 'test')).toThrow(/non-empty array/);
  });

  test('rejects non-numeric input/output', () => {
    expect(() => parsePriceTable({ 'claude-sonnet-5': [{ input: '2', output: 10 }] }, 'test')).toThrow(/must be numbers/);
  });
});

describe('parseSettings', () => {
  const valid = {
    port: 4749,
    host: '0.0.0.0',
    dbPath: 'data/salik.db',
    logPath: 'data/salik.log',
    bodiesDir: 'data/bodies',
    bodyRetentionDays: 3,
    upstreams: {
      ollama: { url: 'http://127.0.0.1:11434', timeoutMs: 1000 },
      anthropic: { url: 'https://api.anthropic.com', timeoutMs: 1000, defaultVersion: '2023-06-01' },
      openai: { url: 'https://api.openai.com', timeoutMs: 1000 },
    },
  };

  test('accepts a well-formed settings file', () => {
    const parsed = parseSettings(valid, 'test');
    expect(parsed.port).toBe(4749);
    expect(parsed.upstreams.openai.url).toBe('https://api.openai.com');
  });

  test('rejects a missing anthropic.defaultVersion', () => {
    const bad = { ...valid, upstreams: { ...valid.upstreams, anthropic: { url: 'x', timeoutMs: 1 } } };
    expect(() => parseSettings(bad, 'test')).toThrow(/defaultVersion/);
  });

  test('rejects a non-numeric port', () => {
    expect(() => parseSettings({ ...valid, port: '4749' }, 'test')).toThrow(/"port"/);
  });
});

describe('parseModelRegistry', () => {
  const valid = {
    defaultFallback: 'claude-haiku-4-5',
    models: [
      { id: 'claude-sonnet-5', provider: 'anthropic', upstreamModel: 'claude-sonnet-5', fallback: 'claude-haiku-4-5' },
      { id: 'claude-haiku-4-5', provider: 'anthropic', upstreamModel: 'claude-haiku-4-5' },
      { id: 'gemma4:12b', provider: 'ollama', upstreamModel: 'gemma4:12b' },
    ],
  };

  test('accepts a well-formed registry', () => {
    const parsed = parseModelRegistry(valid, 'test');
    expect(parsed.defaultFallback).toBe('claude-haiku-4-5');
    expect(parsed.models).toHaveLength(3);
    expect(parsed.byId.get('claude-sonnet-5')).toEqual({
      id: 'claude-sonnet-5',
      provider: 'anthropic',
      upstreamModel: 'claude-sonnet-5',
      fallback: 'claude-haiku-4-5',
    });
    expect(parsed.byId.get('gemma4:12b')?.provider).toBe('ollama');
  });

  test('a model with no fallback is valid — it just has none at runtime', () => {
    const parsed = parseModelRegistry(valid, 'test');
    expect(parsed.byId.get('claude-haiku-4-5')?.fallback).toBeUndefined();
  });

  test('rejects a duplicate model id', () => {
    const bad = { ...valid, models: [...valid.models, { id: 'gemma4:12b', provider: 'ollama', upstreamModel: 'gemma4:12b' }] };
    expect(() => parseModelRegistry(bad, 'test')).toThrow(/duplicate model id/);
  });

  test('rejects an unknown provider', () => {
    const bad = { ...valid, models: [{ id: 'x', provider: 'bedrock', upstreamModel: 'x' }] };
    expect(() => parseModelRegistry(bad, 'test')).toThrow(/provider must be one of/);
  });

  test('rejects a defaultFallback that names no real model', () => {
    const bad = { ...valid, defaultFallback: 'does-not-exist' };
    expect(() => parseModelRegistry(bad, 'test')).toThrow(/defaultFallback.*does-not-exist/);
  });

  test('rejects a per-model fallback that names no real model', () => {
    const bad = { ...valid, models: [{ id: 'x', provider: 'ollama', upstreamModel: 'x', fallback: 'ghost' }, ...valid.models] };
    expect(() => parseModelRegistry(bad, 'test')).toThrow(/"x"\.fallback.*ghost/);
  });

  test('rejects a model naming itself as its own fallback', () => {
    const bad = { ...valid, models: [{ id: 'x', provider: 'ollama', upstreamModel: 'x', fallback: 'x' }, ...valid.models] };
    expect(() => parseModelRegistry(bad, 'test')).toThrow(/names itself as its own fallback/);
  });

  test('a model that IS the configured defaultFallback needs no fallback of its own', () => {
    // claude-haiku-4-5 has no `fallback` and IS `defaultFallback` — valid
    // config; src/dispatch.ts's one-hop rule means this just has nowhere
    // further to fall back to, not a load-time error.
    expect(() => parseModelRegistry(valid, 'test')).not.toThrow();
  });

  test('rejects a non-array models', () => {
    expect(() => parseModelRegistry({ ...valid, models: 'nope' }, 'test')).toThrow(/"models"/);
  });

  test('rejects a missing defaultFallback', () => {
    const { defaultFallback: _drop, ...bad } = valid;
    expect(() => parseModelRegistry(bad, 'test')).toThrow(/defaultFallback/);
  });
});

// The checked-in files themselves, read the way server/server.ts reads them at
// startup. The tests above prove the parsers; these prove the config the next
// restart will actually load.
describe('config/*.json as checked in', () => {
  const load = (file: string): unknown => JSON.parse(readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8'));

  test('settings, models and pricing all parse', () => {
    expect(() => parseSettings(load('settings.json'), 'config/settings.json')).not.toThrow();
    expect(() => parseModelRegistry(load('models.json'), 'config/models.json')).not.toThrow();
    expect(() => parsePriceTable(load('pricing.json'), 'config/pricing.json')).not.toThrow();
  });

  test('every cloud model has a price', () => {
    // src/middleware/meter.ts prices a call by its upstreamModel, and an
    // unpriced one meters at zero, which silently switches off every client's
    // daily budget cap on that model.
    const registry = parseModelRegistry(load('models.json'), 'config/models.json');
    const prices = parsePriceTable(load('pricing.json'), 'config/pricing.json');
    const unpriced = registry.models
      .filter((m) => m.provider !== 'ollama' && prices[m.upstreamModel] === undefined)
      .map((m) => m.id);
    expect(unpriced).toEqual([]);
  });

  test("Donna's gpt-5.4-mini falls back to another OpenAI model, never the Anthropic default", () => {
    const registry = parseModelRegistry(load('models.json'), 'config/models.json');
    const fallbackId = registry.byId.get('gpt-5.4-mini')?.fallback ?? registry.defaultFallback;
    expect(registry.byId.get(fallbackId)?.provider).toBe('openai');
  });
});
