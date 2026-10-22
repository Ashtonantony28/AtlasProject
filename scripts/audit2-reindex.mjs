// AUDIT-6: incremental and mass re-index costs on the realistic generator. Requires `npm run build`.
//   node --expose-gc scripts/audit2-reindex.mjs --gen <files> --work <dir> [--runs 3]
// Indexes a fresh repo into <work>/reindex.db, then times (median of --runs):
//   noop, edit1, edit10, edit100 (append a documented function to N files),
//   add1, delete1, then a "branch switch" (30% of files edited, 5% deleted,
//   one package renamed) and the switch back. Each mutation is restored before
//   the next one. Also reports resolver and embedAll time on the final index and
//   RSS high-water marks. Prints one JSON object.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, closeDatabase, counts, getAllFiles } from '../dist/core/db/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { indexRepo } from '../dist/core/ingest/index.js';
import { resolveGraph } from '../dist/core/graph/index.js';
import { createEmbedder, embedAllSymbols } from '../dist/core/vector/index.js';
import { writeAuditRepo } from './audit-repo.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const work = opt('work');
const gen = Number(opt('gen', '0'));
if (!work || !gen) {
  console.error('usage: node scripts/audit2-reindex.mjs --gen <files> --work <dir> [--runs 3]');
  process.exit(2);
}
const runs = Number(opt('runs', '3'));
const r2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const rssMb = () => Math.round(process.memoryUsage().rss / 2 ** 20);
const hwmMb = () => Math.round(process.resourceUsage().maxRSS / 1024);
const time = async (fn) => {
  const t = performance.now();
  const r = await fn();
  return [performance.now() - t, r];
};

mkdirSync(work, { recursive: true });
const repo = join(work, `reindex${gen}`);
rmSync(repo, { recursive: true, force: true });
writeAuditRepo(repo, gen);
const dbPath = join(work, 'reindex.db');
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const db = openDatabase(dbPath);
const walk = { exclude: DEFAULT_CONFIG.exclude };
const out = { gen, load: readFileSync('/proc/loadavg', 'utf8').trim() };

const [fullMs, full] = await time(() => indexRepo(db, repo, walk));
Object.assign(out, { files: full.filesScanned, ...counts(db), fullIndexMs: r2(fullMs), rssAfterFullMb: rssMb() });
const files = getAllFiles(db).filter((f) => f.language !== 'python');
const abs = (p) => join(repo, p);
const extra = (i) =>
  `\n/** Added by audit2-reindex ${i}. */\nexport function auditAdded${i}(x: number): number {\n  return x + ${i};\n}\n`;

async function measure(label, mutate, restore) {
  const ms = [];
  let last;
  for (let i = 0; i < runs; i++) {
    mutate(i);
    const [t, s] = await time(() => indexRepo(db, repo, walk));
    ms.push(t);
    last = s;
    restore();
    await indexRepo(db, repo, walk);
  }
  out[label] = {
    ms: r2(median(ms)),
    indexed: last.filesIndexed,
    removed: last.filesRemoved,
    embeddings: last.embeddings,
  };
  console.error(`[audit2-reindex] ${label} ${r2(median(ms))} ms`);
}

const editN = (n) => {
  const pick = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / n)) === 0).slice(0, n);
  const orig = pick.map((f) => [f.path, readFileSync(abs(f.path), 'utf8')]);
  return [
    (r) => {
      for (const [p, src] of orig) writeFileSync(abs(p), src + extra(r));
    },
    () => {
      for (const [p, src] of orig) writeFileSync(abs(p), src);
    },
  ];
};

{
  const ms = [];
  for (let i = 0; i < runs; i++) ms.push((await time(() => indexRepo(db, repo, walk)))[0]);
  out.noop = { ms: r2(median(ms)), msPer100Files: r2((median(ms) / full.filesScanned) * 100) };
}
for (const n of [1, 10, 100]) await measure(`edit${n}`, ...editN(n));
await measure(
  'add1',
  (r) => writeFileSync(abs('src/audit_added.ts'), extra(r)),
  () => rmSync(abs('src/audit_added.ts'), { force: true }),
);
{
  const victim = files[Math.floor(files.length / 2)].path;
  const src = readFileSync(abs(victim), 'utf8');
  await measure(
    'delete1',
    () => rmSync(abs(victim)),
    () => writeFileSync(abs(victim), src),
  );
}

// Branch switch: 30% edited, 5% deleted, one package directory renamed.
{
  const all = getAllFiles(db);
  const snapshot = new Map(all.map((f) => [f.path, readFileSync(abs(f.path), 'utf8')]));
  const pkg = 'src/pkg1';
  const switchTo = () => {
    all.forEach((f, i) => {
      if (f.path.startsWith(`${pkg}/`)) return;
      if (i % 20 === 7) rmSync(abs(f.path));
      else if (i % 10 < 3) writeFileSync(abs(f.path), snapshot.get(f.path) + (f.language === 'python' ? '\n# switched\n' : extra(i)));
    });
    if (existsSync(abs(pkg))) renameSync(abs(pkg), abs('src/pkg1renamed'));
  };
  const switchBack = () => {
    rmSync(abs('src/pkg1renamed'), { recursive: true, force: true });
    for (const [p, src] of snapshot) {
      mkdirSync(join(abs(p), '..'), { recursive: true });
      writeFileSync(abs(p), src);
    }
  };
  switchTo();
  const [toMs, to] = await time(() => indexRepo(db, repo, walk));
  out.branchSwitch = { ms: r2(toMs), indexed: to.filesIndexed, removed: to.filesRemoved, embeddings: to.embeddings };
  switchBack();
  const [backMs, back] = await time(() => indexRepo(db, repo, walk));
  out.branchSwitchBack = { ms: r2(backMs), indexed: back.filesIndexed, removed: back.filesRemoved, embeddings: back.embeddings };
  const fresh = r2((fullMs * to.filesIndexed) / full.filesScanned);
  out.branchSwitch.freshIndexShareMs = fresh;
}

// Phase costs every incremental run pays regardless of change size.
out.resolverMs = r2((await time(() => resolveGraph(db, { root: repo })))[0]);
const embedder = createEmbedder(DEFAULT_CONFIG);
out.embedAllNoopMs = r2((await time(() => embedAllSymbols(db, embedder, repo)))[0]);
out.rssEndMb = rssMb();
out.rssHwmMb = hwmMb();
closeDatabase(db);
console.log(JSON.stringify(out, null, 2));
