// AUDIT-6: memory growth probes. Requires `npm run build`; run with --expose-gc.
//   node --expose-gc scripts/audit2-memory.mjs parse <file> [iterations=200]
//     parses one source file repeatedly (parseSource only, no DB) and samples RSS / heap after gc().
//     Keep iterations small: RSS grows ~3.5 MB per parse of a 125 KB file and 3000 parses OOM a 16 GB box.
//   node --expose-gc scripts/audit2-memory.mjs reindex <work> [files=1000] [cycles=15] [edits=100]
//     indexes a realistic repo once, then `cycles` times edits `edits` files and re-indexes,
//     sampling RSS / heap after gc() each cycle. Flat RSS = no leak; steady growth = retained memory.
// Prints one JSON object with the samples and the per-iteration growth slope.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { openDatabase, closeDatabase, getAllFiles } from '../dist/core/db/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { indexRepo } from '../dist/core/ingest/index.js';
import { parseSource } from '../dist/core/parse/index.js';
import { writeAuditRepo } from './audit-repo.mjs';

const [mode, a1, a2, a3, a4] = process.argv.slice(2);
if (typeof gc !== 'function' || !['parse', 'reindex'].includes(mode) || !a1) {
  console.error('usage: node --expose-gc scripts/audit2-memory.mjs parse <file> [n] | reindex <work> [files] [cycles] [edits]');
  process.exit(2);
}
const mb = (n) => Math.round((n / 2 ** 20) * 10) / 10;
const sample = () => {
  gc();
  const m = process.memoryUsage();
  const st = readFileSync('/proc/self/status', 'utf8');
  const kb = (k) => Math.round(Number(new RegExp(`${k}:\\s+(\\d+)`).exec(st)?.[1] ?? 0) / 102.4) / 10;
  return { rss: mb(m.rss), anon: kb('RssAnon'), file: kb('RssFile'), heap: mb(m.heapUsed), external: mb(m.external) };
};
const slope = (ys) => {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return Math.round((num / den) * 100) / 100;
};
const out = { mode, samples: [] };

if (mode === 'parse') {
  const src = readFileSync(a1, 'utf8');
  const ext = extname(a1);
  const lang = ext === '.py' ? 'python' : ext === '.js' || ext === '.cjs' || ext === '.mjs' ? 'javascript' : 'typescript';
  const n = Number(a2 ?? 200);
  const every = Math.max(1, Math.floor(n / 20));
  for (let i = 0; i < n; i++) {
    await parseSource(src, lang, a1);
    if (i % every === 0) out.samples.push({ i, ...sample() });
  }
  out.samples.push({ i: n, ...sample() });
  out.bytes = src.length;
  out.rssMbPer1kParses = Math.round(((out.samples.at(-1).rss - out.samples[1].rss) / (n - every)) * 1000 * 100) / 100;
} else {
  const work = a1;
  const files = Number(a2 ?? 1000);
  const cycles = Number(a3 ?? 15);
  const edits = Number(a4 ?? 100);
  mkdirSync(work, { recursive: true });
  const repo = join(work, `mem${files}`);
  rmSync(repo, { recursive: true, force: true });
  writeAuditRepo(repo, files);
  const dbPath = join(work, 'mem.db');
  for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  const db = openDatabase(dbPath);
  const walk = { exclude: DEFAULT_CONFIG.exclude };
  await indexRepo(db, repo, walk);
  out.samples.push({ cycle: 0, ...sample() });
  const victims = getAllFiles(db)
    .filter((f) => f.language !== 'python')
    .slice(0, edits)
    .map((f) => [join(repo, f.path), readFileSync(join(repo, f.path), 'utf8')]);
  for (let c = 1; c <= cycles; c++) {
    for (const [p, src] of victims) writeFileSync(p, `${src}\n// cycle ${c}\n`);
    await indexRepo(db, repo, walk);
    out.samples.push({ cycle: c, ...sample() });
  }
  closeDatabase(db);
  out.samples.push({ cycle: 'closed', ...sample() });
  const rss = out.samples.slice(1, -1).map((s) => s.rss);
  out.rssMbPerCycle = slope(rss);
  out.heapMbPerCycle = slope(out.samples.slice(1, -1).map((s) => s.heap));
}
console.log(JSON.stringify(out, null, 2));
