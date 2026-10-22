// SG27 wall-clock gates on the AUDIT-10 pathological layouts (the same shapes as
// scripts/audit3-patho.mjs). The default suite pins the algorithm by operation counts
// (test/audit/audit-10.test.ts); these check the time stays inside the frozen budgets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, counts, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { walkRepo } from '../../src/core/ingest/walker.js';
import { resolveGraph } from '../../src/core/graph/index.js';

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

let dir: string;
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-layout-perf-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pathological layouts (SG27)', () => {
  it('resolver on a 250-project Python monorepo (2k files) ≤ 2 s per 1k files (A10-01)', async () => {
    const repo = join(dir, 'pyroots');
    const n = 250;
    for (let p = 0; p < n; p++) {
      const d = join(repo, `proj${p}`);
      write(
        join(d, 'pyproject.toml'),
        `[project]\nname = "proj${p}"\n[tool.setuptools.packages.find]\nwhere = ["src"]\n`,
      );
      write(join(d, 'src', `pkg${p}`, '__init__.py'), '');
      write(join(d, 'tests', '__init__.py'), '');
      for (let f = 0; f < 5; f++) {
        const dep = (p + 1) % n;
        write(
          join(d, 'src', `pkg${p}`, `m${f}.py`),
          `from pkg${dep}.m${f} import g${dep}_${f}\nfrom tests import helper\nimport os\n\ndef g${p}_${f}(x):\n    return g${dep}_${f}(x)\n`,
        );
      }
      write(
        join(d, 'tests', `test_${p}.py`),
        `from pkg${p}.m0 import g${p}_0\n\ndef test_${p}():\n    assert g${p}_0(1)\n`,
      );
    }
    const db = openDatabase(join(dir, 'pyroots.db'));
    try {
      await indexRepo(db, repo, { skipEmbeddings: true });
      const runs: number[] = [];
      let edges = 0;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        edges = resolveGraph(db, { root: repo }).edges;
        runs.push(performance.now() - t);
      }
      const files = counts(db).files;
      const per1k = (median(runs) / files) * 1000;
      console.log(
        `[perf] resolver, Python monorepo ${files} files: ${per1k.toFixed(0)} ms/1k files`,
      );
      expect(files).toBe(2000);
      expect(edges).toBeGreaterThan(0);
      // Before SG27: 1.63 s/1k at 2k files and 6.8 s/1k at 8k (quadratic); after: ~50 ms/1k.
      expect(per1k).toBeLessThanOrEqual(2000);
    } finally {
      closeDatabase(db);
    }
  });

  it('walk of a 200-deep chain with a .gitignore at every level ≤ 1 ms per file (A10-04)', () => {
    const repo = join(dir, 'gitignore');
    let d = repo;
    const depth = 200;
    for (let i = 0; i < depth; i++) {
      write(join(d, '.gitignore'), `*.log\nbuild${i}/\n!keep${i}.ts\ntmp${i}*\n`);
      for (let f = 0; f < 5; f++)
        write(join(d, `m${i}_${f}.ts`), `export const v${i}_${f} = ${f};\n`);
      d = join(d, `d${i}`);
    }
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      expect(walkRepo(repo).length).toBe(depth * 5);
      runs.push(performance.now() - t);
    }
    const perFile = median(runs) / (depth * 5);
    console.log(
      `[perf] walk, .gitignore chain depth ${depth}: ${(perFile * 1000).toFixed(0)} µs/file`,
    );
    // Before SG27: 1.72 ms/file at depth 200 (cubic in depth); after: ~0.16 ms/file.
    expect(perFile).toBeLessThanOrEqual(1);
  });
});
