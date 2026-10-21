// Perf audit harness (AUDIT-2). Requires `npm run build`.
//   node scripts/audit-perf.mjs --gen <files> --work <dir> [--runs 3] [--slow-runs N] [--skip docs,drift,ask]
//   node scripts/audit-perf.mjs --target <repo> --work <dir>
// Indexes into <work>/audit.db (the target is only read), then measures every
// §Interfaces budget plus resolver, docs (offline client), drift and ask
// retrieval. Prints one JSON object; each timing is the median of --runs runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, closeDatabase, counts, getAllSymbols, getAllFiles } from '../dist/core/db/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { indexRepo } from '../dist/core/ingest/index.js';
import { resolveGraph } from '../dist/core/graph/index.js';
import { createEmbedder, search } from '../dist/core/vector/index.js';
import { synthesizeDocs, createOfflineClient } from '../dist/core/synth/index.js';
import { detectDrift } from '../dist/core/drift/index.js';
import { ask, retrieveForQuery } from '../dist/core/qa/index.js';
import { writeAuditRepo } from './audit-repo.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const work = opt('work');
if (!work || (!opt('gen') && !opt('target'))) {
  console.error('usage: node scripts/audit-perf.mjs (--gen <files> | --target <repo>) --work <dir>');
  process.exit(2);
}
const runs = Number(opt('runs', '3'));
// Docs/drift are O(files x edges) today (A2-01); --slow-runs 1 keeps 10k runs under an hour.
const slowRuns = Number(opt('slow-runs', String(runs)));
const skip = new Set(opt('skip', '').split(',').filter(Boolean));
mkdirSync(work, { recursive: true });

const r2 = (n) => Math.round(n * 100) / 100;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
};
const median = (xs) => pct(xs, 50);
const time = async (fn) => {
  const t = performance.now();
  const out = await fn();
  return [performance.now() - t, out];
};
const rssMb = () => Math.round(process.memoryUsage().rss / 2 ** 20);
const out = { memory: {} };

let target;
if (opt('gen')) {
  target = join(work, `repo${opt('gen')}`);
  rmSync(target, { recursive: true, force: true });
  const [ms] = await time(() => writeAuditRepo(target, Number(opt('gen'))));
  out.generateMs = r2(ms);
} else target = resolve(opt('target'));
out.target = target;

const dbPath = join(work, 'audit.db');
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const db = openDatabase(dbPath);
const walk = { exclude: DEFAULT_CONFIG.exclude };

// 1) Full index: per-file parse+insert (read, hash, parse, one transaction).
const perFile = [];
let last = performance.now();
const [indexMs, stats] = await time(() =>
  indexRepo(db, target, {
    ...walk,
    onFile: (f) => {
      const now = performance.now();
      if (f.status === 'parsed') perFile.push(now - last);
      last = now;
    },
  }),
);
const parseLoopMs = perFile.reduce((a, b) => a + b, 0);
out.memory.afterIndexMb = rssMb();
const c = counts(db);
Object.assign(out, {
  files: stats.filesScanned,
  filesFailed: stats.filesFailed,
  symbols: c.symbols,
  edges: c.edges,
  imports: c.imports,
  indexMs: r2(indexMs),
  parseLoopMs: r2(parseLoopMs),
  postParseMs: r2(indexMs - parseLoopMs),
  msPerFileMedian: r2(median(perFile)),
  msPerFileP95: r2(pct(perFile, 95)),
});

// 2) No-op re-index.
const noop = [];
for (let i = 0; i < runs; i++) noop.push((await time(() => indexRepo(db, target, walk)))[0]);
out.noopReindexMs = r2(median(noop));
out.noopMsPer100Files = r2((median(noop) / stats.filesScanned) * 100);

// 3) Resolver alone (full rebuild of the edges table).
const res = [];
for (let i = 0; i < runs; i++) res.push((await time(() => resolveGraph(db, { root: target })))[0]);
out.resolverMs = r2(median(res));
out.resolverMsPer1kFiles = r2((median(res) / stats.filesScanned) * 1000);

// 4) One-file edit: re-index cost after touching a single file (restored after).
const files = getAllFiles(db);
const victim = files.find((f) => f.language !== 'python') ?? files[0];
if (victim) {
  const abs = join(target, victim.path);
  const orig = readFileSync(abs, 'utf8');
  const one = [];
  try {
    for (let i = 0; i < runs; i++) {
      writeFileSync(abs, `${orig}\n// touch ${i}\n`);
      one.push((await time(() => indexRepo(db, target, walk)))[0]);
    }
  } finally {
    writeFileSync(abs, orig);
    await indexRepo(db, target, walk);
  }
  out.oneFileReindexMs = r2(median(one));
}

// 5) Search latency.
const embedder = createEmbedder(DEFAULT_CONFIG);
const syms = getAllSymbols(db).filter((s) => s.kind !== 'module');
const names = [...new Set(syms.map((s) => s.name))];
const phrases = [
  'compute invoice payment total', 'customer address lookup', 'flush the event stream buffer',
  'schedule a worker on the queue', 'apply discount to price', 'session token cache',
  'audit ledger account report', 'shipment catalog', 'metric stream', 'profile service step',
];
const lat = { exact: [], phrase: [], kindFilter: [], fileFilter: [] };
for (let i = 0; i < 5; i++) await search(db, embedder, names[i % names.length] ?? 'x', { limit: 10 });
const Q = 60;
for (let i = 0; i < Q; i++) {
  const n = names[Math.floor((i * names.length) / Q) % names.length] ?? 'x';
  const p = phrases[i % phrases.length];
  lat.exact.push((await time(() => search(db, embedder, n, { limit: 10 })))[0]);
  lat.phrase.push((await time(() => search(db, embedder, p, { limit: 10 })))[0]);
  lat.kindFilter.push((await time(() => search(db, embedder, p, { limit: 10, kind: 'class' })))[0]);
  lat.fileFilter.push((await time(() => search(db, embedder, p, { limit: 10, file: 'pkg1' })))[0]);
}
out.search = {};
for (const [k, xs] of Object.entries(lat)) out.search[k] = { p50: r2(pct(xs, 50)), p95: r2(pct(xs, 95)) };
const all = Object.values(lat).flat();
out.search.all = { n: all.length, p50: r2(pct(all, 50)), p95: r2(pct(all, 95)) };
out.memory.afterSearchMb = rssMb();

// 6) Docs (offline client): first run generates, later runs are fully cached.
if (!skip.has('docs')) {
  const llm = createOfflineClient();
  let promptChars = 0;
  let maxPrompt = 0;
  const counting = {
    model: llm.model,
    async complete(p) {
      const n = p.messages.reduce((a, m) => a + m.content.length, 0) + (p.system?.length ?? 0);
      promptChars += n;
      maxPrompt = Math.max(maxPrompt, n);
      return llm.complete(p);
    },
  };
  const opts = { root: target, tokenBudget: 1e12 };
  const [firstMs, first] = await time(() => synthesizeDocs(db, counting, opts));
  const cached = [];
  for (let i = 0; i < slowRuns; i++) cached.push((await time(() => synthesizeDocs(db, counting, opts)))[0]);
  out.docs = {
    firstMs: r2(firstMs),
    generated: first.modulesGenerated,
    cachedMs: r2(median(cached)),
    cachedMsPer1kFiles: r2((median(cached) / stats.filesScanned) * 1000),
    promptCharsTotal: promptChars,
    maxPromptChars: maxPrompt,
  };
  out.memory.afterDocsMb = rssMb();
}

// 7) Drift against the docs table.
if (!skip.has('drift')) {
  const dr = [];
  let report;
  for (let i = 0; i < slowRuns; i++) {
    const [ms, r] = await time(() => detectDrift(db, { root: target }));
    dr.push(ms);
    report = r;
  }
  out.drift = { ms: r2(median(dr)), stale: report.stale.length, undocumented: report.undocumented.length };
  out.memory.afterDriftMb = rssMb();
}

// 8) Ask: retrieval latency and prompt size (offline client).
if (!skip.has('ask')) {
  const rt = [];
  for (let i = 0; i < runs; i++)
    rt.push((await time(() => retrieveForQuery(db, target, 'how is the invoice payment total computed')))[0]);
  let promptChars = 0;
  const llm = createOfflineClient();
  const counting = {
    model: llm.model,
    async complete(p) {
      promptChars = p.messages.reduce((a, m) => a + m.content.length, 0);
      return llm.complete(p);
    },
  };
  const [askMs] = await time(() => ask(db, counting, target, 'how is the invoice payment total computed'));
  out.ask = { retrieveMs: r2(median(rt)), askMs: r2(askMs), promptChars };
  out.memory.afterAskMb = rssMb();
}

out.memory.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
closeDatabase(db);
console.log(JSON.stringify(out, null, 2));
