import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, getAllSymbols } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { LocalHashEmbedder, search, countEmbeddings } from '../../src/core/vector/index.js';

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
});
