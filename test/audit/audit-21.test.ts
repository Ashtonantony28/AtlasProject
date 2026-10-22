// AUDIT-21: soundness, round 6 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-21.md (IDs A21-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held: SG50
// (edges carried across a re-parse, MCP reservations), SG45 (run stamps, `writers`) and SG55
// (`sliceLines` cache).
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
  type SymbolRow,
} from '../../src/core/db/index.js';
import { indexRepo, type IndexStats } from '../../src/core/ingest/index.js';
import { EXTRACTOR_VERSION } from '../../src/core/parse/version.js';
import { estimateInputTokens, type LLMClient } from '../../src/core/synth/index.js';
import { buildSymbolText, embedAllSymbols, type Embedder } from '../../src/core/vector/index.js';
import { EMBEDDING_DIM } from '../../src/core/db/schema.js';
import {
  createMcpContext,
  handleAskTool,
  handleIndexTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

const dirs: string[] = [];
const dbs: DB[] = [];
const ctxs: McpContext[] = [];
afterEach(() => {
  for (const c of ctxs.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string | null>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    if (text === null) {
      rmSync(p);
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function newRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit21-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  writeTree(root, files);
  return root;
}

function open(path: string): DB {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

/** `src -kind-> dst` per edge; labels are `path::qualifiedName@startLine` (`null` for weak). */
function edgesOf(db: DB): string[] {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const byId = new Map(getAllSymbols(db).map((s) => [s.id, s]));
  const label = (id: number | null): string => {
    if (id === null) return 'null';
    const s = byId.get(id)!;
    const name = s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name);
    return `${paths.get(s.file_id)}::${name}@${s.start_line}`;
  };
  return getAllEdges(db)
    .map((e) => `${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}`)
    .sort();
}

/**
 * Index `before`, apply `after`, re-index while a reader polls the graph at every event-loop
 * turn. Returns the graph before the edit, the last graph a reader saw while the run was in
 * progress (the carried graph, after the parse loop), the final graph and a fresh --force index.
 */
async function window(
  before: Record<string, string>,
  after: Record<string, string | null>,
): Promise<{ old: string[]; seen: string[]; final: string[]; fresh: string[]; stats: IndexStats }> {
  const root = newRepo(before);
  const db = open(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  const old = edgesOf(db);
  writeTree(root, after);
  let done = false;
  const run = indexRepo(db, root, { skipEmbeddings: true }).finally(() => (done = true));
  let seen = old;
  while (!done) {
    seen = edgesOf(db);
    await new Promise(setImmediate);
  }
  const stats = await run;
  const fresh = open(join(root, '..', 'fresh.db'));
  await indexRepo(fresh, root, { skipEmbeddings: true, force: true });
  return { old, seen, final: edgesOf(db), fresh: edgesOf(fresh), stats };
}

/** `buildSymbolText` with a fresh split of `src` per call (the pre-SG55 behaviour). */
function naive(sym: SymbolRow, path: string, src: string): string {
  const lines = src.split('\n');
  const s = Math.max(0, sym.start_line - 1);
  const e = Math.min(lines.length, Math.min(sym.end_line, sym.start_line + 30));
  return `${buildSymbolText(sym, { path }, null)}\n${lines.slice(s, e).join('\n')}`;
}

const strip = (edges: string[]): string[] => edges.map((e) => e.replace(/@\d+/g, '')).sort();

/** A client billed for its whole prompt estimate and every `max_tokens` token. */
function greedy(delayMs: number, opts: { fail?: () => boolean; seen?: number[] } = {}): LLMClient {
  return {
    model: 'greedy',
    complete: async (p) => {
      opts.seen?.push(p.maxTokens);
      await new Promise((r) => setTimeout(r, delayMs));
      if (opts.fail?.()) throw new Error('503 overloaded');
      return {
        content: 'Circle.area [1]',
        inputTokens: estimateInputTokens(p),
        outputTokens: p.maxTokens,
        stopReason: 'end_turn',
      };
    },
  };
}

async function mcpOnSample(llm: LLMClient, tokenBudget: number): Promise<McpContext> {
  const root = newRepo({});
  cpSync(SAMPLE, root, { recursive: true });
  const ctx = createMcpContext({ root, llm });
  ctxs.push(ctx);
  await handleIndexTool(ctx, {});
  setBudget(root, tokenBudget);
  return ctx;
}

function setBudget(root: string, tokenBudget: number): void {
  const cfg = join(root, '.atlas', 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), tokenBudget }));
}

// Destructured exports are symbols since extractor v3 (SG31); an older extractor stored none.
const DESTRUCTURED = {
  'a.ts': 'const obj = { p: 1, q: 2 };\nexport const { p, q } = obj;\n',
  'b.ts': "import { p } from './a';\nexport function use() { return p; }\n",
};

/** Index, then make the rows of `a.ts` look written by an older extractor (no p/q symbols). */
async function olderRowsAfterFinishedRun(): Promise<{ root: string; db: DB }> {
  const root = newRepo(DESTRUCTURED);
  const db = open(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  db.prepare(
    "DELETE FROM symbols WHERE name IN ('p', 'q') AND file_id = (SELECT id FROM files WHERE path = 'a.ts')",
  ).run();
  return { root, db };
}

const pq = (db: DB): string[] =>
  getAllSymbols(db)
    .filter((s) => s.name === 'p' || s.name === 'q')
    .map((s) => s.name)
    .sort();

// ---------------------------------------------------------------- medium

describe('AUDIT-21 medium', () => {
  it.fails(
    'A21-01 a reader during a run sees callers of a TS overloaded function pointed at its implementation, not at an overload signature',
    async () => {
      const lib = 'export function f(a: any): void { helper(); }\nfunction helper() {}\n';
      const { old, seen, final, fresh } = await window(
        {
          'lib.ts': 'export function f(a: string): void;\n' + lib,
          'use.ts': "import { f } from './lib';\nexport function u() { f('x'); }\n",
        },
        // One more overload signature on top; the implementation moves from line 2 to line 3.
        {
          'lib.ts':
            'export function f(a: boolean): void;\nexport function f(a: string): void;\n' + lib,
        },
      );
      expect(old).toContain('use.ts::u@2 -calls-> lib.ts::f@2');
      expect(final).toEqual(fresh);
      expect(final).toContain('use.ts::u@2 -calls-> lib.ts::f@3');
      // Today the carried edge goes to the 2nd occurrence, the bodiless `f(a: string)` signature.
      expect(seen).toContain('use.ts::u@2 -calls-> lib.ts::f@3');
      expect(seen).toContain('lib.ts::f@3 -calls-> lib.ts::helper@4');
    },
  );

  it.fails(
    'A21-01 a reader during a run keeps the callers of a Python function whose earlier redefinition (or @overload stub) was removed',
    async () => {
      const { old, seen, final, fresh } = await window(
        {
          'p.py': 'def f():\n    a()\n\ndef f():\n    b()\n\ndef a(): pass\ndef b(): pass\n',
          'u.py': 'from p import f\ndef u():\n    f()\n',
        },
        { 'p.py': 'def f():\n    b()\n\ndef a(): pass\ndef b(): pass\n' },
      );
      expect(old).toContain('u.py::u@2 -calls-> p.py::f@4');
      expect(final).toEqual(fresh);
      // `f` exists before and after the edit, but every edge touching it is gone mid-run.
      expect(strip(seen)).toEqual(expect.arrayContaining(['u.py::u -calls-> p.py::f']));
    },
  );
});

// ---------------------------------------------------------------- low

describe('AUDIT-21 low', () => {
  it.fails(
    'A21-02 rows from an unstamped (pre-SG45) run interrupted after a finished run are re-parsed by the next run',
    async () => {
      const { root, db } = await olderRowsAfterFinishedRun();
      // An older `atlas` (no stamp) started a run (a downgrade re-parse) and was killed.
      db.prepare("INSERT INTO runs (commit_sha, started_at) VALUES (NULL, '2026-10-01')").run();
      const stats = await indexRepo(db, root, { skipEmbeddings: true });
      expect(stats.resolveReason).toBe('previous run interrupted');
      // Today: no upgrade, a.ts is skipped as unchanged and keeps the older extractor's rows.
      expect(pq(db)).toEqual(['p', 'q']);
    },
  );
});

// ---------------------------------------------------------------- holds

describe('AUDIT-21 holds', () => {
  it('SG50 renames, inserts, deletions and reorders: the reader keeps every surviving edge mid-run and the final graph equals a fresh index', async () => {
    const { old, seen, final, fresh, stats } = await window(
      {
        'lib.ts':
          'export function a() { x(); }\nexport function b() { y(); }\nfunction x() {}\nfunction y() {}\nexport class K { m() { x(); } }\n',
        'use.ts':
          "import { a, b, K } from './lib';\nexport function u() { a(); b(); new K().m(); }\n",
        'p.py': 'def g():\n    h()\n\ndef h(): pass\n',
        'q.py': 'from p import g\ndef v():\n    g()\n',
      },
      {
        // b renamed, a new function on top, K before a, y deleted (b's call becomes unbound).
        'lib.ts':
          'export function z() {}\nexport class K { m() { x(); } }\nexport function a() { x(); }\nexport function b2() { y(); }\nfunction x() {}\n',
        'p.py': 'def new():\n    pass\n\ndef g():\n    h()\n\ndef h(): pass\n',
      },
    );
    expect(stats.resolveReason).toBe('files changed');
    expect(final).toEqual(fresh);
    // Mid-run: the previous graph on the new symbols; edges of vanished symbols (b, y) dropped.
    const vanished = /lib\.ts::(b|y)\b/;
    expect(strip(seen)).toEqual(strip(old.filter((e) => !vanished.test(e))));
    expect(seen).toContain('use.ts::u@2 -calls-> lib.ts::a@3');
    expect(seen).toContain('q.py::v@2 -calls-> p.py::g@4');
  });

  it('SG50 forced re-index of a file with overloads: the reader sees the same graph throughout (same occurrences)', async () => {
    const lib =
      'export function f(a: string): void;\nexport function f(a: any): void { helper(); }\nfunction helper() {}\n';
    const { old, seen, final } = await window(
      { 'lib.ts': lib, 'use.ts': "import { f } from './lib';\nexport function u() { f('x'); }\n" },
      { 'lib.ts': lib + '// touched\n' },
    );
    expect(seen).toEqual(old);
    expect(final).toEqual(old);
  });

  it('SG50 a failed call releases its reservation and charges nothing; the next call gets the full max_tokens', async () => {
    let failNext = true;
    const seen: number[] = [];
    const ctx = await mcpOnSample(
      greedy(10, {
        seen,
        fail: () => {
          const f = failNext;
          failNext = false;
          return f;
        },
      }),
      40_000,
    );
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(/503/);
    expect(ctx.budget.total().spent).toBe(0);
    await handleAskTool(ctx, { question: 'circle area' });
    expect(seen).toEqual([16_000, 16_000]);
    expect(ctx.budget.total().spent).toBeLessThanOrEqual(40_000);
  });

  it('SG50 parallel calls with a mid-call failure and a budget lowered mid-call: never more than the cap in force when each call started; later calls are refused', async () => {
    let n = 0;
    const ctx = await mcpOnSample(greedy(40, { fail: () => ++n === 1 }), 40_000);
    const calls = [
      handleAskTool(ctx, { question: 'circle area' }),
      handleAskTool(ctx, { question: 'shape perimeter' }),
    ];
    await new Promise((r) => setTimeout(r, 5));
    // Lowered while both are in flight: they were admitted under 40k and settle onto the new budget.
    setBudget(ctx.root, 10_000);
    const third = handleAskTool(ctx, { question: 'math helpers' });
    const results = await Promise.allSettled([...calls, third]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'rejected']);
    expect(String((results[2] as PromiseRejectedResult).reason)).toMatch(/token budget exhausted/);
    expect(ctx.budget.cap).toBe(10_000);
    expect(ctx.budget.total().spent).toBeGreaterThan(0);
    expect(ctx.budget.total().spent).toBeLessThanOrEqual(40_000);
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(
      /token budget exhausted/,
    );
  });

  it('SG45 an interrupted run stamped with an older extractor after a finished run forces an upgrade', async () => {
    const { root, db } = await olderRowsAfterFinishedRun();
    db.prepare(
      "INSERT INTO runs (commit_sha, started_at, stats_json) VALUES (NULL, '2026-10-01', ?)",
    ).run(JSON.stringify({ state: { extractorVersion: EXTRACTOR_VERSION - 1 } }));
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats.extractorUpgrade).toEqual({ from: EXTRACTOR_VERSION - 1, to: EXTRACTOR_VERSION });
    expect(pq(db)).toEqual(['p', 'q']);
  });

  it('SG45 two interrupted runs (older stamp, then current) with no finished run still upgrade; an unstamped one alone upgrades from null', async () => {
    const root = newRepo(DESTRUCTURED);
    const db = open(join(root, '..', 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
    db.prepare('DELETE FROM runs').run();
    const stamp = (v: number | null): void => {
      db.prepare("INSERT INTO runs (commit_sha, started_at, stats_json) VALUES (NULL, 'x', ?)").run(
        v === null ? null : JSON.stringify({ state: { extractorVersion: v } }),
      );
    };
    stamp(EXTRACTOR_VERSION - 1);
    stamp(EXTRACTOR_VERSION);
    expect((await indexRepo(db, root, { skipEmbeddings: true })).extractorUpgrade?.from).toBe(
      EXTRACTOR_VERSION - 1,
    );
    db.prepare('DELETE FROM runs').run();
    stamp(null);
    expect((await indexRepo(db, root, { skipEmbeddings: true })).extractorUpgrade?.from).toBeNull();
    db.prepare('DELETE FROM runs').run();
    stamp(EXTRACTOR_VERSION);
    const s = await indexRepo(db, root, { skipEmbeddings: true });
    expect(s.extractorUpgrade).toBeUndefined();
    expect(s.resolveReason).toBe('previous run interrupted');
  });

  it('SG55 sliceLines: same content under two paths, alternating files, an edit, and equal-length sources give the naive split', () => {
    const sym = (start: number, end: number): SymbolRow => ({
      id: start,
      file_id: 1,
      kind: 'function',
      name: 'f',
      signature: null,
      start_line: start,
      end_line: end,
      docstring: null,
      qualified_name: null,
      exported: 0,
    });
    const a = 'l1\nl2\nl3\nl4\n';
    const b = 'm1\nm2\nm3\nm4\n'; // same length as `a`
    const aCopy = `${'l1\nl2'}\nl3\nl4\n`; // equal value, another string object
    const edited = 'l1\nX\nl3\nl4\n';
    const cases: [SymbolRow, string, string][] = [
      [sym(1, 2), 'a.ts', a],
      [sym(2, 3), 'copy/a.ts', aCopy],
      [sym(1, 4), 'b.ts', b],
      [sym(2, 2), 'a.ts', a],
      [sym(2, 2), 'a.ts', edited],
      [sym(3, 9), 'b.ts', b],
      [sym(2, 2), 'a.ts', a],
    ];
    for (const [s, path, src] of cases)
      expect(buildSymbolText(s, { path }, src)).toBe(naive(s, path, src));
  });

  it('SG55 embedding texts: identical files under two paths and an edited copy embed their own lines', async () => {
    const lib =
      'export function one() {\n  return 1;\n}\nexport function two() {\n  return 2;\n}\n';
    const root = newRepo({
      'a.ts': lib,
      'copy/a.ts': lib,
      'b.ts': lib.replace(/return/g, 'yield'),
    });
    const db = open(join(root, '..', 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
    const texts: string[] = [];
    const embedder: Embedder = {
      model: 'capture',
      dim: EMBEDDING_DIM,
      embed: async (inputs) => {
        texts.push(...inputs);
        return inputs.map(() => new Float32Array(EMBEDDING_DIM).fill(0.1));
      },
    };
    await embedAllSymbols(db, embedder, root, { batchSize: 1 });
    const files = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
    const expected = getAllSymbols(db)
      .filter((s) => s.kind !== 'module')
      .map((s) => {
        const path = files.get(s.file_id)!;
        return naive(s, path, readFileSync(join(root, path), 'utf8'));
      });
    expect(texts).toEqual(expected);
    expect(texts.filter((t) => t.includes('yield'))).toHaveLength(2);
    expect(texts.filter((t) => t.includes('file: copy/a.ts') && t.includes('return'))).toHaveLength(
      2,
    );
  });
});
