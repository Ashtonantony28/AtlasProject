import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { LocalHashEmbedder, search } from '../../src/core/vector/index.js';
// @ts-expect-error untyped .mjs helper shared with scripts/bench.mjs
import { writeSyntheticRepo } from '../../scripts/synthetic-repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

// Embeds the query "zxqv" as if it were about widgets, so the zxqv symbol's
// vector is far from the query and only lexical retrieval can find it.
class ZxqvBlindEmbedder extends LocalHashEmbedder {
  override async embed(inputs: string[]): Promise<Float32Array[]> {
    return super.embed(inputs.map((s) => (s === 'zxqv' ? 'widget total' : s)));
  }
}

async function buildIndex(files: number, perFile: number): Promise<{ db: DB; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-hybrid-'));
  writeSyntheticRepo(join(dir, 'repo'), { files, perFile });
  const db = openDatabase(join(dir, 'index.db'));
  await indexRepo(db, join(dir, 'repo'));
  return { db, dir };
}

describe('hybrid search: exact names outside the KNN pool', () => {
  let db: DB;
  let dir: string;
  beforeAll(async () => {
    ({ db, dir } = await buildIndex(8, 50));
  });
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an exact-name match first even when its vector is far from the query', async () => {
    expect(counts(db).symbols).toBeGreaterThanOrEqual(300);
    const embedder = new ZxqvBlindEmbedder();
    const knnOnly = await search(db, embedder, 'widget total', { limit: 50 });
    expect(knnOnly.map((h) => h.symbol.name)).not.toContain('zxqv');

    const hits = await search(db, embedder, 'zxqv');
    expect(hits[0]?.symbol.name).toBe('zxqv');
    expect(hits[0]?.structuralScore).toBe(1);
  });
});

describe('hybrid search on a 10k-symbol index', () => {
  let db: DB;
  let dir: string;
  const embedder = new LocalHashEmbedder();
  beforeAll(async () => {
    ({ db, dir } = await buildIndex(200, 50));
  }, 180_000);
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies the kind filter before truncation', async () => {
    const unfiltered = await search(db, embedder, 'widget total', { limit: 50 });
    expect(unfiltered.some((h) => h.symbol.kind === 'interface')).toBe(false);

    const hits = await search(db, embedder, 'widget total', { kind: 'interface' });
    expect(hits.map((h) => h.symbol.name).sort()).toEqual([
      'PaneLayout0',
      'PaneLayout1',
      'PaneLayout2',
    ]);
  });

  it('applies the file filter before truncation', async () => {
    const hits = await search(db, embedder, 'widget total', { file: 'special/' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.filePath).toContain('special/');
    expect(hits.map((h) => h.symbol.name)).toContain('PaneLayout0');
  });
});

describe('hybrid search query sanitising', () => {
  it('does not throw on FTS5 syntax in the query', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-hybrid-'));
    const db = openDatabase(join(dir, 'index.db'));
    try {
      await indexRepo(db, FIXTURE);
      const embedder = new LocalHashEmbedder();
      for (const q of [
        '"foo" OR bar*',
        'NEAR(',
        '"',
        '*',
        'AND OR NOT',
        '-area',
        'area:',
        "Circle'",
      ]) {
        await expect(search(db, embedder, q)).resolves.toBeInstanceOf(Array);
      }
      const hits = await search(db, embedder, '"area" OR radius*');
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
