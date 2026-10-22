// Frozen §Interfaces budgets measured on Atlas itself (a bench target that is always in tree):
// parse+insert ≤ 5 ms/file median, no-op re-index ≤ 100 ms per 100 files, resolver ≤ 2 s per
// 1k files. Added by AUDIT-10 (A10-03): test:perf covered only search, synthesis and drift.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { resolveGraph } from '../../src/core/graph/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

describe('indexing budgets on Atlas itself', () => {
  let dir: string;
  let db: DB;
  let files = 0;
  const perFile: number[] = [];
  const walk = { exclude: DEFAULT_CONFIG.exclude };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-index-perf-'));
    // Warm-up pass on a throwaway DB so module loading and grammar init are not timed.
    const warm = openDatabase(join(dir, 'warm.db'));
    await indexRepo(warm, ROOT, { ...walk, skipEmbeddings: true });
    closeDatabase(warm);
    db = openDatabase(join(dir, 'index.db'));
    let last = performance.now();
    const stats = await indexRepo(db, ROOT, {
      ...walk,
      onFile: (f) => {
        const now = performance.now();
        if (f.status === 'parsed') perFile.push(now - last);
        last = now;
      },
    });
    files = stats.filesScanned;
  }, 180_000);
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('parse+insert median ≤ 5 ms/file', () => {
    expect(perFile.length).toBeGreaterThan(50);
    const ms = median(perFile);
    console.log(`[perf] parse+insert, ${perFile.length} files: ${ms.toFixed(2)} ms/file median`);
    expect(ms).toBeLessThanOrEqual(5);
  });

  it('no-op re-index ≤ 100 ms per 100 files', async () => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const s = await indexRepo(db, ROOT, walk);
      runs.push(performance.now() - t);
      expect(s.filesIndexed).toBe(0);
    }
    const per100 = (median(runs) / files) * 100;
    console.log(`[perf] no-op re-index, ${files} files: ${per100.toFixed(1)} ms/100 files`);
    expect(per100).toBeLessThanOrEqual(100);
  });

  it('resolver ≤ 2 s per 1k files', () => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      resolveGraph(db, { root: ROOT });
      runs.push(performance.now() - t);
    }
    const per1k = (median(runs) / files) * 1000;
    console.log(`[perf] resolver, ${files} files: ${per1k.toFixed(0)} ms/1k files`);
    expect(per1k).toBeLessThanOrEqual(2000);
  });
});
