// AUDIT-14 (A14-04): the 200-deep `.gitignore` chain in layouts.test.ts uses only
// segment-local patterns, which SG27 merges into one matcher. Patterns with a `/` are not
// merged; SG27 still walked that shape at 1.5 ms/file at depth 200 (11 ms/file at 600) and
// SG30 brought it to ~0.15 ms/file. This keeps the anchored shape inside the same 1 ms/file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { walkRepo } from '../../src/core/ingest/walker.js';

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-walk-anchored-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('walk with anchored .gitignore patterns (AUDIT-14)', () => {
  it('a 200-deep chain with an anchored .gitignore at every level ≤ 1 ms per file', () => {
    const depth = 200;
    let d = join(dir, 'repo');
    for (let i = 0; i < depth; i++) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, '.gitignore'), `/build${i}/\nsub/*.log\n!keep${i}.ts\n/tmp${i}*\n`);
      for (let f = 0; f < 5; f++) writeFileSync(join(d, `m${i}_${f}.ts`), `export const v = ${f};\n`);
      d = join(d, `d${i}`);
    }
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      expect(walkRepo(join(dir, 'repo')).length).toBe(depth * 5);
      runs.push(performance.now() - t);
    }
    const perFile = median(runs) / (depth * 5);
    console.log(`[perf] walk, anchored .gitignore chain depth ${depth}: ${(perFile * 1000).toFixed(0)} µs/file`);
    expect(perFile).toBeLessThanOrEqual(1);
  });
});
