import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { LocalHashEmbedder, search } from '../../src/core/vector/index.js';
// @ts-expect-error untyped .mjs helper shared with scripts/bench.mjs
import { writeSyntheticRepo } from '../../scripts/synthetic-repo.mjs';

const QUERIES = ['widget total', 'zxqv', 'PaneLayout1', 'widgetTotal17x3', 'compute batch count'];

describe('search on a 10k-symbol index', () => {
  let dir: string;
  let db: DB;
  const embedder = new LocalHashEmbedder();
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-search-perf-'));
    writeSyntheticRepo(join(dir, 'repo'), { files: 200, perFile: 50 });
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, join(dir, 'repo'));
  });
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps search p95 within 50 ms', async () => {
    expect(counts(db).symbols).toBeGreaterThanOrEqual(10_000);
    for (const q of QUERIES) await search(db, embedder, q, { limit: 10 });
    const lat: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      await search(db, embedder, QUERIES[i % QUERIES.length]!, { limit: 10 });
      lat.push(performance.now() - t);
    }
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.ceil(0.95 * lat.length) - 1]!;
    console.log(`[perf] search p95 at ${counts(db).symbols} symbols: ${p95.toFixed(2)} ms`);
    expect(p95).toBeLessThanOrEqual(50);
  });
});
