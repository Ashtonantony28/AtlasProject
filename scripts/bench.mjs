// Perf harness: node scripts/bench.mjs --target <path|self|synthetic10k>. Requires `npm run build`.
// Prints one JSON object with index, no-op re-index and search latency numbers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openDatabase, closeDatabase, counts, getAllSymbols } from '../dist/core/db/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { indexRepo } from '../dist/core/ingest/index.js';
import { createEmbedder, search } from '../dist/core/vector/index.js';
import { writeSyntheticRepo } from './synthetic-repo.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targetArg = args[args.indexOf('--target') + 1];
if (!args.includes('--target') || !targetArg) {
  console.error('usage: node scripts/bench.mjs --target <path|self|synthetic10k>');
  process.exit(2);
}
const QUERIES = 50;

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;
const round = (n) => Math.round(n * 100) / 100;

const dir = mkdtempSync(join(tmpdir(), 'atlas-bench-'));
try {
  let target = targetArg === 'self' ? repoRoot : resolve(targetArg);
  if (targetArg === 'synthetic10k') {
    target = join(dir, 'synthetic10k');
    writeSyntheticRepo(target, { files: 200, perFile: 50 });
  }
  const db = openDatabase(join(dir, 'bench.db'));
  const opts = { exclude: DEFAULT_CONFIG.exclude };

  const perFile = [];
  let last = performance.now();
  const t0 = last;
  const stats = await indexRepo(db, target, {
    ...opts,
    onFile: (f) => {
      const now = performance.now();
      if (f.status === 'parsed') perFile.push(now - last);
      last = now;
    },
  });
  const indexMs = performance.now() - t0;

  const t1 = performance.now();
  const noop = await indexRepo(db, target, opts);
  const noopMs = performance.now() - t1;

  const embedder = createEmbedder(DEFAULT_CONFIG);
  const names = [
    ...new Set(
      getAllSymbols(db)
        .filter((s) => s.kind !== 'module')
        .map((s) => s.name),
    ),
  ];
  const lat = [];
  for (let i = 0; names.length > 0 && i < QUERIES; i++) {
    const q = names[Math.floor((i * names.length) / QUERIES) % names.length];
    const ts = performance.now();
    await search(db, embedder, q, { limit: 10 });
    lat.push(performance.now() - ts);
  }
  lat.sort((a, b) => a - b);
  perFile.sort((a, b) => a - b);

  const c = counts(db);
  closeDatabase(db);
  console.log(
    JSON.stringify({
      target: targetArg === 'synthetic10k' ? 'synthetic10k' : target,
      files: stats.filesScanned,
      filesIndexed: stats.filesIndexed,
      filesFailed: stats.filesFailed,
      symbols: c.symbols,
      edges: c.edges,
      indexMs: round(indexMs),
      msPerFileMedian: round(pct(perFile, 50)),
      noopReindexMs: round(noopMs),
      noopFilesSkipped: noop.filesSkipped,
      searchQueries: lat.length,
      searchP50Ms: round(pct(lat, 50)),
      searchP95Ms: round(pct(lat, 95)),
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
