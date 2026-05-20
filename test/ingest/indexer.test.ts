import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  counts,
  getAllSymbols,
  getAllImports,
  getAllFiles,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('indexRepo end-to-end on fixture', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-idx-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates files, symbols, and imports from the sample fixture', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    const stats = await indexRepo(db, FIXTURE);

    expect(stats.filesScanned).toBe(4);
    expect(stats.filesIndexed).toBe(4);
    expect(stats.filesFailed).toBe(0);

    const c = counts(db);
    expect(c.files).toBe(4);
    expect(c.symbols).toBeGreaterThanOrEqual(15);
    expect(c.imports).toBe(5);

    // Spot check a few known symbols by qualified name.
    const symbols = getAllSymbols(db);
    const names = new Set(symbols.map((s) => s.qualified_name));
    expect(names.has('add')).toBe(true);
    expect(names.has('Circle')).toBe(true);
    expect(names.has('Circle.area')).toBe(true);
    expect(names.has('Counter.increment')).toBe(true);

    // Spot check that imports of './math.js' got recorded.
    const imps = getAllImports(db);
    const fromMath = imps.filter((i) => i.module === './math.js');
    expect(fromMath.length).toBeGreaterThanOrEqual(2);

    // Files have non-zero LOC.
    const files = getAllFiles(db);
    for (const f of files) expect(f.loc).toBeGreaterThan(0);

    closeDatabase(db);
  });

  it('skips unchanged files on a second run', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const second = await indexRepo(db, FIXTURE);
    expect(second.filesSkipped).toBe(4);
    expect(second.filesIndexed).toBe(0);
    closeDatabase(db);
  });

  it('--force reindexes everything', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const second = await indexRepo(db, FIXTURE, { force: true });
    expect(second.filesSkipped).toBe(0);
    expect(second.filesIndexed).toBe(4);
    closeDatabase(db);
  });
});
