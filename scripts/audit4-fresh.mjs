// AUDIT-14: cost of SG25's freshness checks. Requires `npm run build`.
//   node scripts/audit4-fresh.mjs realistic <work> <files...>
//     Realistic repo of N files (scripts/audit-repo.mjs). Times a fresh index, the no-op
//     re-index, the walk alone and `resolverFingerprint` alone (the directory scan a no-op run
//     pays), then the re-parse after an EXTRACTOR_VERSION bump (simulated by rewriting the last
//     run's `state.extractorVersion`) against `--force`.
//   node scripts/audit4-fresh.mjs wide <work> <dirs...>
//     N directories of one TS file each (pkg<i>/src/m.ts, a package.json in every 10th package),
//     the layout where the fingerprint's per-directory readdir costs most. Same timings, no upgrade.
// Prints JSON rows; each time is the median of 3 runs.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, closeDatabase, counts } from '../dist/core/db/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { indexRepo, walkRepo } from '../dist/core/ingest/index.js';
import { resolverFingerprint } from '../dist/core/graph/modules.js';
import { writeAuditRepo } from './audit-repo.mjs';

const [mode, work, ...sizes] = process.argv.slice(2);
if (!['realistic', 'wide'].includes(mode) || !work || sizes.length === 0) {
  console.error('usage: node scripts/audit4-fresh.mjs realistic|wide <work> <n...>');
  process.exit(2);
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const r0 = (n) => Math.round(n);
const time3 = async (fn) => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await fn();
    runs.push(performance.now() - t);
  }
  return r0(med(runs));
};

function writeWide(repo, dirs) {
  for (let i = 0; i < dirs; i++) {
    const d = join(repo, `pkg${i}`, 'src');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'm.ts'), `export function f${i}(x: number) {\n  return x + ${i};\n}\n`);
    if (i % 10 === 0) writeFileSync(join(repo, `pkg${i}`, 'package.json'), `{"name":"pkg${i}"}\n`);
  }
}

for (const n of sizes.map(Number)) {
  const repo = join(work, `${mode}${n}`);
  rmSync(repo, { recursive: true, force: true });
  if (mode === 'realistic') writeAuditRepo(repo, n);
  else writeWide(repo, n);
  const dbPath = join(work, `${mode}${n}.db`);
  rmSync(dbPath, { force: true });
  const db = openDatabase(dbPath);
  const opts = { exclude: DEFAULT_CONFIG.exclude };
  const row = { mode, n, load: (await import('node:fs')).readFileSync('/proc/loadavg', 'utf8').split(' ')[0] };
  let t = performance.now();
  await indexRepo(db, repo, opts);
  row.freshMs = r0(performance.now() - t);
  row.files = counts(db).files;
  row.symbols = counts(db).symbols;
  row.noopMs = await time3(() => indexRepo(db, repo, opts));
  row.walkMs = await time3(() => walkRepo(repo, opts));
  const paths = db.prepare('SELECT path FROM files').pluck().all();
  row.fingerprintMs = await time3(() => resolverFingerprint(repo, paths));
  row.noopMsPer100Files = Math.round((row.noopMs / row.files) * 1000) / 10;
  if (mode === 'realistic') {
    const bump = () =>
      db
        .prepare(
          "UPDATE runs SET stats_json = json_set(stats_json, '$.state.extractorVersion', 1) WHERE id = (SELECT MAX(id) FROM runs WHERE finished_at IS NOT NULL)",
        )
        .run();
    bump();
    t = performance.now();
    const up = await indexRepo(db, repo, opts);
    row.upgradeMs = r0(performance.now() - t);
    row.upgradeIndexed = up.filesIndexed;
    t = performance.now();
    await indexRepo(db, repo, { ...opts, force: true });
    row.forceMs = r0(performance.now() - t);
    row.symbolsAfter = counts(db).symbols;
  }
  closeDatabase(db);
  console.log(JSON.stringify(row));
  rmSync(repo, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
}
