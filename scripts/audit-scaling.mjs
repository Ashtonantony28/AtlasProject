// Scaling probes for AUDIT-2. Requires `npm run build`.
//   node scripts/audit-scaling.mjs force <work> <files...>  forced re-index (`--force`) per repo size
//   node scripts/audit-scaling.mjs bigfile <work> <fns...>  parse vs embed time for one TS file of N functions
// Prints JSON rows; each time is the median of 3 runs on a fresh DB.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, closeDatabase, counts } from '../dist/core/db/index.js';
import { indexRepo } from '../dist/core/ingest/index.js';
import { createEmbedder, embedAllSymbols } from '../dist/core/vector/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { writeAuditRepo } from './audit-repo.mjs';

const [mode, work, ...sizes] = process.argv.slice(2);
if (!['force', 'bigfile'].includes(mode) || !work || sizes.length === 0) {
  console.error('usage: node scripts/audit-scaling.mjs force|bigfile <work> <n...>');
  process.exit(2);
}
const r2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const time = async (fn) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};
mkdirSync(work, { recursive: true });
const rows = [];
for (const n of sizes.map(Number)) {
  const repo = join(work, `${mode}${n}`);
  rmSync(repo, { recursive: true, force: true });
  if (mode === 'force') writeAuditRepo(repo, n);
  else {
    mkdirSync(repo, { recursive: true });
    const L = [];
    for (let i = 0; i < n; i++)
      L.push(`/** fn ${i} */\nexport function fn${i}(a: number): number {\n  return a + ${i};\n}`);
    writeFileSync(join(repo, 'big.ts'), L.join('\n') + '\n');
  }
  const a = [];
  const b = [];
  let symbols = 0;
  for (let run = 0; run < 3; run++) {
    const dbPath = join(work, `${mode}${n}.db`);
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    const db = openDatabase(dbPath);
    if (mode === 'force') {
      a.push(await time(() => indexRepo(db, repo)));
      b.push(await time(() => indexRepo(db, repo, { force: true })));
    } else {
      a.push(await time(() => indexRepo(db, repo, { skipEmbeddings: true })));
      b.push(await time(() => embedAllSymbols(db, createEmbedder(DEFAULT_CONFIG), repo)));
    }
    symbols = counts(db).symbols;
    closeDatabase(db);
    for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  }
  rows.push(
    mode === 'force'
      ? { size: n, symbols, freshIndexMs: r2(median(a)), forcedReindexMs: r2(median(b)) }
      : { fns: n, symbols, parseMs: r2(median(a)), embedMs: r2(median(b)) },
  );
  rmSync(repo, { recursive: true, force: true });
}
console.log(JSON.stringify(rows, null, 2));
