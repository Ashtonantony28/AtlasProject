import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

    // Known signatures — the parser must capture the declaration line.
    const byQName = new Map(symbols.map((s) => [s.qualified_name, s]));
    expect(byQName.get('add')?.signature).toMatch(/function add\(a:\s*number,\s*b:\s*number\)/);
    expect(byQName.get('Circle')?.signature).toMatch(/class Circle/);
    expect(byQName.get('Circle.area')?.signature).toMatch(/area\(\)/);
    expect(byQName.get('Counter.increment')?.signature).toMatch(/def increment\(self/);

    // Spans — every symbol has a valid start/end line, and they're 1-based.
    for (const s of symbols) {
      expect(s.start_line).toBeGreaterThanOrEqual(1);
      expect(s.end_line).toBeGreaterThanOrEqual(s.start_line);
    }

    // Docstrings — at least one symbol carries a captured docstring.
    const docstringed = symbols.filter((s) => s.docstring && s.docstring.length > 0);
    expect(docstringed.length).toBeGreaterThan(0);
    const greetPy = byQName.get('greet');
    expect(greetPy?.docstring).toMatch(/friendly greeting/);

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

  it('a no-change second run is near-zero work', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const second = await indexRepo(db, FIXTURE);
    expect(second.filesIndexed).toBe(0);
    expect(second.symbols).toBe(0);
    expect(second.imports).toBe(0);
    expect(second.embeddings).toBe(0);
    closeDatabase(db);
  });

  it('indexes a >32KB file without failing (chunked tree-sitter input)', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const src = Array.from(
      { length: 3000 },
      (_, i) => `export function fn${i}(a: number): number {\n  return a + ${i};\n}\n`,
    ).join('');
    expect(src.length).toBeGreaterThan(32 * 1024);
    writeFileSync(join(repo, 'big.ts'), src);

    const db = openDatabase(join(dir, 'index.db'));
    const stats = await indexRepo(db, repo);
    expect(stats.filesFailed).toBe(0);
    const fns = getAllSymbols(db).filter((s) => s.kind === 'function');
    expect(fns.length).toBeGreaterThanOrEqual(3000);
    closeDatabase(db);
  });
});
