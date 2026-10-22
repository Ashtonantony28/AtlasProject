import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
  type SymbolRow,
} from '../../src/core/db/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { buildSymbolText, createEmbedder, getAllEmbeddings } from '../../src/core/vector/index.js';
import { SAMPLE } from '../cli/helpers.js';

// The text before SG55: the whole source split once per symbol.
function textBefore(sym: SymbolRow, path: string, src: string): string {
  const doc = sym.docstring
    ?.replace(/^\/\*\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
  const lines = src.split('\n');
  const end = Math.min(sym.end_line, sym.start_line + 30);
  return [
    `${sym.kind}: ${sym.qualified_name ?? sym.name}`,
    ...(sym.signature ? [sym.signature] : []),
    ...(sym.docstring ? [doc] : []),
    `file: ${path}`,
    ...(src
      ? [lines.slice(Math.max(0, sym.start_line - 1), Math.min(lines.length, end)).join('\n')]
      : []),
  ].join('\n');
}

describe('embedding text (SG55)', () => {
  let dir: string;
  let db: DB;
  const sources = new Map<number, { path: string; src: string }>();
  let symbols: SymbolRow[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-text-'));
    cpSync(SAMPLE, dir, { recursive: true });
    const gen = Array.from(
      { length: 60 },
      (_, i) =>
        `/** Op ${i}.\n * Long ${i}. */\nexport function op${i}(x: number): number {\n${'  x++;\n'.repeat(i % 40)}  return x;\n}\n`,
    ).join('\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/api.generated.ts'), gen);
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, dir, { exclude: DEFAULT_CONFIG.exclude });
    for (const f of getAllFiles(db))
      sources.set(f.id, { path: f.path, src: readFileSync(join(dir, f.path), 'utf8') });
    symbols = getAllSymbols(db).filter((s) => s.kind !== 'module');
  });
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches the per-symbol split for every symbol, in any file order', () => {
    expect(
      symbols.filter((s) => sources.get(s.file_id)!.path.endsWith('.generated.ts')).length,
    ).toBe(60);
    // Interleave files so the cached split is replaced between symbols.
    const shuffled = [...symbols].sort((a, b) => ((a.id * 7919) % 101) - ((b.id * 7919) % 101));
    for (const s of shuffled) {
      const { path, src } = sources.get(s.file_id)!;
      expect(buildSymbolText(s, { path }, src)).toBe(textBefore(s, path, src));
    }
    const s = symbols[0]!;
    const { path, src } = sources.get(s.file_id)!;
    for (const [start_line, end_line] of [
      [1e6, 1e6 + 2],
      [5, 3],
      [0, 2],
    ] as const) {
      const edge = { ...s, start_line, end_line };
      expect(buildSymbolText(edge, { path }, src)).toBe(textBefore(edge, path, src));
    }
  });

  it('stores the vectors of the per-symbol-split texts', async () => {
    const embedder = createEmbedder(DEFAULT_CONFIG);
    const stored = new Map(getAllEmbeddings(db).map((e) => [e.symbol_id, e.vector]));
    expect(stored.size).toBe(symbols.length);
    const texts = symbols.map((s) => {
      const { path, src } = sources.get(s.file_id)!;
      return textBefore(s, path, src);
    });
    const vecs = await embedder.embed(texts);
    symbols.forEach((s, k) =>
      expect(Buffer.from(stored.get(s.id)!.buffer)).toEqual(Buffer.from(vecs[k]!.buffer)),
    );
  });
});
