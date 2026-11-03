import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  getAllFiles,
  getAllSymbols,
  getFileByPath,
  openDatabase,
  type DB,
  type SymbolRow,
} from '../../src/core/db/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  buildSymbolText,
  createEmbedder,
  getAllEmbeddings,
  readIndexedSource,
} from '../../src/core/vector/index.js';
import { createOfflineClient, synthesizeDocs, type LLMClient } from '../../src/core/synth/index.js';
import { runDrift } from '../../src/core/drift/index.js';
import { ask } from '../../src/core/qa/ask.js';
import { createMcpContext, handleSymbolTool, type McpContext } from '../../src/mcp/server.js';
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

describe('readIndexedSource hashes the text the indexer hashed (SG310)', () => {
  let dir: string;
  let root: string;
  let ctx: McpContext;
  const FILES = [
    ['src/latin.ts', 'latinTotal', 'return 41 + 1;'],
    ['src/bom.ts', 'bomTotal', 'return 40 + 2;'],
  ] as const;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-hash-'));
    root = join(dir, 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    writeFileSync(
      join(root, 'src/latin.ts'),
      Buffer.concat([
        Buffer.from('// caf'),
        Buffer.from([0xe9]),
        Buffer.from(' au lait\nexport function latinTotal(): number {\n  return 41 + 1;\n}\n'),
      ]),
    );
    writeFileSync(
      join(root, 'src/bom.ts'),
      '\uFEFFexport function bomTotal(): number {\r\n  return 40 + 2;\r\n}\r\n',
    );
    ctx = createMcpContext({ root, offline: true });
    await indexRepo(ctx.db, root);
  });
  afterAll(() => {
    if (ctx.db.open) closeDatabase(ctx.db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a non-UTF-8 file and a BOM/CRLF file as unchanged, and atlas_symbol serves them', () => {
    for (const [path, name, body] of FILES) {
      const read = readIndexedSource(root, getFileByPath(ctx.db, path)!);
      expect(read.changed, path).toBe(false);
      expect(read.source, path).toContain(body);
      expect(handleSymbolTool(ctx, { name })[0]?.excerpt, path).toContain(body);
    }
  });

  it('ask sends both bodies with no "changed since indexing" note', async () => {
    const prompts: string[] = [];
    const capture: LLMClient = {
      model: 'capture',
      complete: async (params) => {
        prompts.push(params.messages.map((m) => m.content).join('\n'));
        return { content: 'see [1]', inputTokens: 1, outputTokens: 1 };
      },
    };
    const res = await ask(ctx.db, capture, root, 'latinTotal bomTotal', { seedLimit: 20 });
    expect(res.answer).not.toMatch(/changed since indexing/);
    for (const [, , body] of FILES) expect(prompts.join('\n')).toContain(body);
  });

  it('drift reports nothing stale after synthesis and a re-index skips every file', async () => {
    await synthesizeDocs(ctx.db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    const report = runDrift(ctx.db, { root });
    expect(report.stale.map((s) => `${s.targetPath}:${s.currentHash}`)).toEqual([]);
    const stats = await indexRepo(ctx.db, root);
    expect(stats.filesSkipped).toBe(stats.filesScanned);
  });
});
