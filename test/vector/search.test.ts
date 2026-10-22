import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  getAllSymbols,
  getFileByPath,
  getSymbolsForFile,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  LocalHashEmbedder,
  search,
  countEmbeddings,
  vectorKnn,
} from '../../src/core/vector/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('search end-to-end', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-search-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('embeds all non-module symbols and finds the right top hits', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);

    // Every non-module symbol should have an embedding.
    const allSyms = getAllSymbols(db).filter((s) => s.kind !== 'module');
    expect(countEmbeddings(db)).toBe(allSyms.length);

    const embedder = new LocalHashEmbedder();
    const circle = await search(db, embedder, 'circle area radius');
    expect(circle.length).toBeGreaterThan(0);
    // Top hit must be Circle.area or area.
    const top = circle[0]!;
    expect(['Circle.area', 'area']).toContain(top.symbol.qualified_name ?? top.symbol.name);

    const counter = await search(db, embedder, 'increment counter value');
    expect(counter.length).toBeGreaterThan(0);
    // Either Counter.increment or Counter should rank highest.
    const counterTop = counter[0]!;
    expect(['Counter.increment', 'Counter']).toContain(
      counterTop.symbol.qualified_name ?? counterTop.symbol.name,
    );
    closeDatabase(db);
  });

  it('filters by kind', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const embedder = new LocalHashEmbedder();
    const onlyClasses = await search(db, embedder, 'shape', { kind: 'class' });
    expect(onlyClasses.length).toBeGreaterThan(0);
    for (const h of onlyClasses) expect(h.symbol.kind).toBe('class');
    closeDatabase(db);
  });

  it('filters by file substring', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const embedder = new LocalHashEmbedder();
    const hits = await search(db, embedder, 'area', { file: 'shapes' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.filePath).toContain('shapes');
    closeDatabase(db);
  });

  it('persists embeddings across reopen', async () => {
    const path = join(dir, 'index.db');
    {
      const db = openDatabase(path);
      await indexRepo(db, FIXTURE);
      closeDatabase(db);
    }
    const db = openDatabase(path);
    const all = getAllSymbols(db).filter((s) => s.kind !== 'module');
    expect(countEmbeddings(db)).toBe(all.length);
    closeDatabase(db);
  });

  it('vec0 KNN returns sane similarities (1.0 for an exact embedding match)', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);

    // Take the stored embedding for Circle.area and feed it back as a query.
    const { getAllEmbeddings, vectorKnn } = await import('../../src/core/vector/index.js');
    const all = getAllEmbeddings(db);
    expect(all.length).toBeGreaterThan(0);

    // Find a stable target (Circle.area) by joining with symbols.
    const targetRow = db
      .prepare(
        "SELECT id FROM symbols WHERE qualified_name = 'Circle.area' LIMIT 1",
      )
      .get() as { id: number } | undefined;
    expect(targetRow).toBeDefined();
    const stored = all.find((e) => e.symbol_id === targetRow!.id);
    expect(stored).toBeDefined();

    const hits = vectorKnn(db, stored!.vector, 3);
    expect(hits.length).toBeGreaterThan(0);
    // The closest match to a vector is itself: distance ≈ 0, similarity ≈ 1.
    expect(hits[0]!.symbolId).toBe(stored!.symbol_id);
    expect(hits[0]!.similarity).toBeCloseTo(1, 3);
    closeDatabase(db);
  });
});

// Embeds "frobnicate" as if it were "widget total", so only FTS can match zeta's docstring.
class FrobnicateBlindEmbedder extends LocalHashEmbedder {
  override async embed(inputs: string[]): Promise<Float32Array[]> {
    return super.embed(inputs.map((s) => (s === 'frobnicate' ? 'widget total' : s)));
  }
}

describe('search filter when FTS ranks matches outside the filter first', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-search-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 40 short "frobnicate" docstrings outside special/ outrank zeta's long one; ten
  // widgetTotal functions fill special/'s KNN pool.
  function writeRepo(root: string): void {
    for (let i = 0; i < 4; i++) {
      const body = Array.from(
        { length: 10 },
        (_, j) =>
          `/** frobnicate */\nexport function decoy${i}x${j}(): number {\n  return ${j};\n}\n`,
      ).join('\n');
      mkdirSync(join(root, 'decoy'), { recursive: true });
      writeFileSync(join(root, 'decoy', `d${i}.ts`), body);
    }
    const widgets = Array.from(
      { length: 10 },
      (_, k) =>
        `/** Compute the widget total. */\nexport function widgetTotal${k}(count: number): number {\n  return count * ${k};\n}\n`,
    ).join('\n');
    mkdirSync(join(root, 'special'), { recursive: true });
    writeFileSync(
      join(root, 'special', 's.ts'),
      `${widgets}\n/** Zeta handles parsing, routing, caching, logging and metrics, and has to frobnicate the cache total before shutdown completes. */\nexport function zeta(): void {}\n`,
    );
  }

  it('still returns an FTS-only match inside a selective file filter', async () => {
    const root = join(dir, 'repo');
    writeRepo(root);
    const db = openDatabase(join(dir, 'index.db'));
    try {
      await indexRepo(db, root);
      const embedder = new FrobnicateBlindEmbedder();
      const opts = { file: 'special/', candidatePoolSize: 5, limit: 5 };
      const [q] = await embedder.embed(['frobnicate']);
      const zeta = getSymbolsForFile(db, getFileByPath(db, 'special/s.ts')!.id).find(
        (s) => s.name === 'zeta',
      )!;
      const pool = vectorKnn(db, q!, opts.candidatePoolSize, {
        sql: 'SELECT s.id FROM symbols s WHERE s.file_id IN (SELECT id FROM files WHERE instr(path, ?) > 0)',
        params: [opts.file],
      });
      expect(pool.map((r) => r.symbolId)).not.toContain(zeta.id);
      const unfiltered = await search(db, embedder, 'frobnicate', { ...opts, file: undefined });
      expect(unfiltered.map((h) => h.symbol.name)).not.toContain('zeta');

      const hits = await search(db, embedder, 'frobnicate', opts);
      for (const h of hits) expect(h.filePath).toContain('special/');
      expect(hits.map((h) => h.symbol.name)).toContain('zeta');
    } finally {
      closeDatabase(db);
    }
  });
});
