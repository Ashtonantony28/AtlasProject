import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { createOfflineClient, synthesizeDocs } from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
// @ts-expect-error untyped .mjs helper shared with scripts/bench.mjs
import { writeSyntheticRepo } from '../../scripts/synthetic-repo.mjs';

describe('synthesis on a fully cached 1k-file index', () => {
  let dir: string;
  let root: string;
  let db: DB;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-synth-perf-'));
    root = join(dir, 'repo');
    writeSyntheticRepo(root, { files: 1000, perFile: 5 });
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
    const first = await synthesizeDocs(db, createOfflineClient(), {
      root,
      tokenBudget: 10_000_000,
    });
    expect(first.modulesGenerated).toBe(1002);
  }, 180_000);
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes ≤ 1 s and generates nothing', async () => {
    const t0 = performance.now();
    const stats = await synthesizeDocs(db, createOfflineClient(), {
      root,
      tokenBudget: 10_000_000,
    });
    const ms = performance.now() - t0;
    console.log(`[perf] cached synthesis, 1002 files: ${ms.toFixed(0)} ms`);
    expect(stats.modulesCached).toBe(1002);
    expect(stats.modulesGenerated).toBe(0);
    expect(stats.architectureGenerated).toBe(false);
    expect(ms).toBeLessThanOrEqual(1000);
  });

  it('drift over the same index takes ≤ 1 s', () => {
    const t0 = performance.now();
    const report = detectDrift(db, { root });
    const ms = performance.now() - t0;
    console.log(`[perf] drift, 1002 files: ${ms.toFixed(0)} ms`);
    expect(report.stale).toEqual([]);
    expect(ms).toBeLessThanOrEqual(1000);
  });
});
