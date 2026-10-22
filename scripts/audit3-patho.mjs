// AUDIT-10: pathological inputs for the SG19 module resolver and the SG20 walker.
// Requires `npm run build`. Prints JSON rows; each time is the median of --runs runs (default 3).
//   node scripts/audit3-patho.mjs workspaces <work> <packages...>
//     N workspace packages (5 files each), one root tsconfig.base.json with one `paths`
//     alias per package, a tsconfig.json per package extending it; every file imports
//     three other packages by name. Times a full index and the resolver alone.
//   node scripts/audit3-patho.mjs gitignore <work> <depth...>
//     A directory chain `depth` deep, a .gitignore and 5 source files at every level.
//     Times the walk alone and reports files returned.
//   node scripts/audit3-patho.mjs gitignore-wide <work> <dirs...>
//     `dirs` sibling directories of 20 files, each with its own .gitignore, against the
//     same tree with no .gitignore files.
//   node scripts/audit3-patho.mjs pyroots <work> <projects...>
//     N Python projects (pyproject.toml + src/<pkg>/ + tests/__init__.py), 5 modules each.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, closeDatabase, counts } from '../dist/core/db/index.js';
import { indexRepo } from '../dist/core/ingest/index.js';
import { walkRepo } from '../dist/core/ingest/walker.js';
import { resolveGraph } from '../dist/core/graph/index.js';

const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const runs = runsIdx >= 0 ? Number(args.splice(runsIdx, 2)[1]) : 3;
const [mode, work, ...sizes] = args;
const MODES = ['workspaces', 'gitignore', 'gitignore-wide', 'pyroots'];
if (!MODES.includes(mode) || !work || sizes.length === 0) {
  console.error(`usage: node scripts/audit3-patho.mjs ${MODES.join('|')} <work> <n...> [--runs 3]`);
  process.exit(2);
}
const r2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const time = async (fn) => {
  const t = performance.now();
  const out = await fn();
  return [performance.now() - t, out];
};
const write = (p, s) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, s);
};

function workspaces(repo, n) {
  write(join(repo, 'package.json'), JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }));
  const paths = {};
  for (let p = 0; p < n; p++) paths[`@m/p${p}`] = [`packages/p${p}/src/index.ts`];
  write(join(repo, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths } }, null, 1));
  for (let p = 0; p < n; p++) {
    const dir = join(repo, 'packages', `p${p}`);
    write(join(dir, 'package.json'), JSON.stringify({ name: `@m/p${p}`, main: 'src/index.ts' }));
    write(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { outDir: 'dist' } }));
    const deps = [1, 7, 31].map((k) => (p + k) % n).filter((d) => d !== p);
    for (let f = 0; f < 5; f++) {
      const lines = deps.map((d) => `import { api${d} } from '@m/p${d}';`);
      if (f > 0) lines.push(`import { f${p}_${f - 1} } from './f${f - 1}';`);
      lines.push(`export function f${p}_${f}(x: number): number {`);
      lines.push(`  return ${deps.map((d) => `api${d}(x)`).join(' + ') || 'x'}${f > 0 ? ` + f${p}_${f - 1}(x)` : ''};`);
      lines.push('}');
      write(join(dir, 'src', `f${f}.ts`), lines.join('\n') + '\n');
    }
    write(join(dir, 'src', 'index.ts'), `import { f${p}_4 } from './f4';\nexport function api${p}(x: number): number {\n  return f${p}_4(x);\n}\n`);
  }
}

function gitignoreChain(repo, depth) {
  let dir = repo;
  for (let d = 0; d < depth; d++) {
    write(join(dir, '.gitignore'), `*.log\nbuild${d}/\n!keep${d}.ts\ntmp${d}*\n`);
    for (let f = 0; f < 5; f++) write(join(dir, `m${d}_${f}.ts`), `export const v${d}_${f} = ${f};\n`);
    dir = join(dir, `d${d}`);
  }
}

function gitignoreWide(repo, dirs, withIgnores) {
  for (let d = 0; d < dirs; d++) {
    const dir = join(repo, `pkg${d}`);
    if (withIgnores) write(join(dir, '.gitignore'), `dist/\n*.log\n!important.log\ncoverage\n`);
    for (let f = 0; f < 20; f++) write(join(dir, `m${f}.ts`), `export const v${d}_${f} = ${f};\n`);
  }
}

function pyroots(repo, n) {
  for (let p = 0; p < n; p++) {
    const dir = join(repo, `proj${p}`);
    write(join(dir, 'pyproject.toml'), `[project]\nname = "proj${p}"\n[tool.setuptools.packages.find]\nwhere = ["src"]\n`);
    write(join(dir, 'src', `pkg${p}`, '__init__.py'), '');
    write(join(dir, 'tests', '__init__.py'), '');
    for (let f = 0; f < 5; f++) {
      const dep = (p + 1) % n;
      write(
        join(dir, 'src', `pkg${p}`, `m${f}.py`),
        `from pkg${dep}.m${f} import g${dep}_${f}\nfrom tests import helper\n\ndef g${p}_${f}(x):\n    return g${dep}_${f}(x)\n`,
      );
    }
    write(join(dir, 'tests', `test_${p}.py`), `from pkg${p}.m0 import g${p}_0\n\ndef test_${p}():\n    assert g${p}_0(1)\n`);
  }
}

mkdirSync(work, { recursive: true });
const rows = [];
for (const n of sizes.map(Number)) {
  const repo = join(work, `${mode}${n}`);
  rmSync(repo, { recursive: true, force: true });
  if (mode === 'workspaces' || mode === 'pyroots') {
    (mode === 'workspaces' ? workspaces : pyroots)(repo, n);
    const idx = [];
    const res = [];
    let c;
    let stats;
    for (let r = 0; r < runs; r++) {
      const dbPath = join(work, `${mode}${n}.db`);
      for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
      const db = openDatabase(dbPath);
      idx.push((await time(() => indexRepo(db, repo, { skipEmbeddings: true })))[0]);
      const [ms, st] = await time(() => resolveGraph(db, { root: repo }));
      res.push(ms);
      stats = st;
      c = counts(db);
      closeDatabase(db);
      for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    }
    const resolvedImports = stats.imports - 0;
    rows.push({
      mode,
      n,
      files: c.files,
      symbols: c.symbols,
      edges: c.edges,
      weakEdges: stats.weakEdges,
      importEdges: resolvedImports,
      indexMs: r2(median(idx)),
      resolverMs: r2(median(res)),
      resolverMsPer1kFiles: r2((median(res) / c.files) * 1000),
    });
  } else if (mode === 'gitignore') {
    gitignoreChain(repo, n);
    const t = [];
    let files = 0;
    for (let r = 0; r < runs; r++) {
      const [ms, out] = await time(() => walkRepo(repo, {}));
      t.push(ms);
      files = out.length;
    }
    rows.push({ mode, depth: n, files, walkMs: r2(median(t)), walkUsPerFile: r2((median(t) / files) * 1000) });
  } else {
    const out = {};
    for (const withIgnores of [false, true]) {
      rmSync(repo, { recursive: true, force: true });
      gitignoreWide(repo, n, withIgnores);
      const t = [];
      let files = 0;
      for (let r = 0; r < runs; r++) {
        const [ms, res] = await time(() => walkRepo(repo, { exclude: ['**/*.min.js', 'vendor/'] }));
        t.push(ms);
        files = res.length;
      }
      out[withIgnores ? 'withGitignores' : 'without'] = { files, walkMs: r2(median(t)) };
    }
    rows.push({ mode, dirs: n, ...out });
  }
  rmSync(repo, { recursive: true, force: true });
}
console.log(JSON.stringify(rows, null, 2));
