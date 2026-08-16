// config/*.json is validated once at startup (server/server.ts) and typed
// thereafter — this is what makes that trustworthy: a malformed file must
// refuse to start rather than run with a silently-wrong client list.
import { describe, expect, test } from 'bun:test';
import { parseKeysFile, parsePriceTable, parseSettings } from '../src/types.ts';

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
      openai: { url: 'https://api.openai.com', timeoutMs: 1000, localModels: ['gemma4:12b'] },
    },
  };

  test('accepts a well-formed settings file', () => {
    const parsed = parseSettings(valid, 'test');
    expect(parsed.port).toBe(4749);
    expect(parsed.upstreams.openai.localModels).toEqual(['gemma4:12b']);
  });

  test('rejects a missing anthropic.defaultVersion', () => {
    const bad = { ...valid, upstreams: { ...valid.upstreams, anthropic: { url: 'x', timeoutMs: 1 } } };
    expect(() => parseSettings(bad, 'test')).toThrow(/defaultVersion/);
  });

  test('rejects a non-array openai.localModels', () => {
    const bad = { ...valid, upstreams: { ...valid.upstreams, openai: { ...valid.upstreams.openai, localModels: 'gemma4:12b' } } };
    expect(() => parseSettings(bad, 'test')).toThrow(/localModels/);
  });

  test('rejects a non-numeric port', () => {
    expect(() => parseSettings({ ...valid, port: '4749' }, 'test')).toThrow(/"port"/);
  });
});
