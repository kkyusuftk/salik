// `bun run tokens` — how many tokens went through this gateway, by hour.
//
// Reads data/salik.db directly and READ-ONLY rather than calling
// GET /api/salik/usage, for three reasons: it answers when the server is down
// (which is one of the times you most want to know what it was doing), it needs
// no token, and a reader cannot disturb a writer under WAL. Both paths share
// src/usage.ts, so the arithmetic behind the two answers is the same code.
//
// Hours are LOCAL by default here and UTC on the endpoint, on purpose: a person
// reading a terminal means their own clock, and an API caller means the one
// unambiguous zone. Both label what they used.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hourlyUsage, type UsageBucket } from '../src/db.ts';
import { formatOffset, parseTzOffsetMinutes, since, sumTotals, totalsOf, type UsageTotals } from '../src/usage.ts';
import { parseSettings } from '../src/config.ts';

const USAGE = `usage: bun run tokens [options]

  --hours N        how far back to look (default 24)
  --client NAME    only this client
  --by-client      split each hour by client instead of totalling it
  --utc            bucket by UTC hours (default: this machine's local hours)
  --tz ±HH:MM      bucket by some other zone
  --json           emit the same numbers as JSON
`;

function parseArgs(argv: readonly string[]): {
  hours: number; client?: string; byClient: boolean; tz: string; json: boolean;
} {
  const args = { hours: 24, client: undefined as string | undefined, byClient: false, tz: 'local', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`${arg} needs a value\n\n${USAGE}`); process.exit(2); }
      return v;
    };
    switch (arg) {
      case '--hours': case '-h': args.hours = Number(next()); break;
      case '--days': case '-d': args.hours = Number(next()) * 24; break;
      case '--client': case '-c': args.client = next(); break;
      case '--by-client': args.byClient = true; break;
      case '--utc': args.tz = 'utc'; break;
      case '--tz': args.tz = next(); break;
      case '--json': args.json = true; break;
      case '--help': console.log(USAGE); process.exit(0); break;
      default: console.error(`unknown option ${arg}\n\n${USAGE}`); process.exit(2);
    }
  }
  if (!Number.isFinite(args.hours) || args.hours <= 0) { console.error('--hours must be a positive number'); process.exit(2); }
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
const offsetMinutes = parseTzOffsetMinutes(args.tz);
if (offsetMinutes === null) { console.error(`--tz "${args.tz}" is not utc, local, ±HH:MM or minutes`); process.exit(2); }

const ROOT = process.cwd();
const settings = parseSettings(JSON.parse(readFileSync(path.resolve(ROOT, 'config/settings.json'), 'utf8')), 'config/settings.json');
const dbPath = path.resolve(ROOT, settings.dbPath);

let db: Database;
try {
  // readonly, so a mistyped flag can never write to the live ledger — and so
  // this refuses outright rather than helpfully creating an empty database
  // somewhere the server isn't looking.
  db = new Database(dbPath, { readonly: true });
} catch {
  console.error(`no ledger at ${dbPath} — has the gateway ever run?`);
  process.exit(1);
}

const from = since(args.hours);
const buckets = hourlyUsage(db, { since: from, client: args.client, offsetMinutes, byClient: args.byClient });
const totals = sumTotals(buckets);

if (args.json) {
  console.log(JSON.stringify({
    window: { hours: args.hours, since: from, tz: formatOffset(offsetMinutes), offsetMinutes },
    client: args.client ?? null,
    groupedBy: args.byClient ? ['hour', 'client'] : ['hour'],
    buckets: buckets.map((b) => ({ hour: b.hour, client: b.client, ...totalsOf(b) })),
    totals,
  }, null, 2));
  process.exit(0);
}

// ------------------------------------------------------------------ the table

const n = (x: number): string => x.toLocaleString('en-US');
const usd = (x: number): string => (x === 0 ? '—' : `$${x.toFixed(x < 0.01 ? 5 : 3)}`);
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

interface Column { head: string; get: (b: UsageBucket, t: UsageTotals) => string; foot: (t: UsageTotals) => string }

const columns: Column[] = [
  { head: 'hour', get: (b) => b.hour.replace('T', ' '), foot: () => `${args.hours}h total` },
  ...(args.byClient ? [{ head: 'client', get: (b: UsageBucket) => b.client ?? '', foot: () => '' }] : []),
  { head: 'reqs', get: (_b, t) => n(t.requests), foot: (t) => n(t.requests) },
  { head: 'in new', get: (_b, t) => n(t.inputTokens), foot: (t) => n(t.inputTokens) },
  { head: 'in cached', get: (_b, t) => n(t.cacheReadTokens), foot: (t) => n(t.cacheReadTokens) },
  { head: 'in total', get: (_b, t) => n(t.promptTokens), foot: (t) => n(t.promptTokens) },
  { head: 'out', get: (_b, t) => n(t.outputTokens), foot: (t) => n(t.outputTokens) },
  { head: 'tokens', get: (_b, t) => n(t.totalTokens), foot: (t) => n(t.totalTokens) },
  { head: 'cost', get: (_b, t) => usd(t.costUsd), foot: (t) => usd(t.costUsd) },
];

const rows = buckets.map((b) => {
  const t = totalsOf(b);
  return columns.map((c) => c.get(b, t));
});
const footer = columns.map((c) => c.foot(totals));
const widths = columns.map((c, i) => Math.max(c.head.length, ...rows.map((r) => r[i]!.length), footer[i]!.length));
// The first column is a label; every other one is a number, and numbers line
// up on the right or the eye can't compare them.
const pad = (s: string, i: number): string => (i === 0 ? s.padEnd(widths[i]!) : s.padStart(widths[i]!));
const line = (cells: readonly string[]): string => cells.map(pad).join('  ');

const scope = args.client ? ` · ${args.client}` : '';
console.log(`\n${BOLD}salik · tokens by hour${OFF}${DIM}  (last ${args.hours}h, ${formatOffset(offsetMinutes)}${scope})${OFF}\n`);
if (!buckets.length) {
  console.log(`${DIM}  nothing in the ledger for that window.${OFF}\n`);
  process.exit(0);
}
console.log(`${DIM}${line(columns.map((c) => c.head))}${OFF}`);
for (const r of rows) console.log(line(r));
console.log(`${DIM}${line(widths.map((w) => '─'.repeat(w)))}${OFF}`);
console.log(`${BOLD}${line(footer)}${OFF}`);
// An hour with no traffic has no row at all, so a gap in the list is silence
// rather than a missing number — say so, once, instead of zero-filling.
console.log(`\n${DIM}  in total = fresh + cached prompt tokens · hours with no calls are omitted${OFF}\n`);
