// AUDIT-17: soundness, round 5 (no false negatives). Each `it.fails` asserts the CORRECT
// behaviour and currently fails, reproducing one finding in AUDIT-17.md (IDs A17-xx); when it is
// fixed it turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and
// held: SG31 (destructured symbols), SG32/SG33 (index lock, interrupted runs), SG34 (yielding and
// joining queued runs) and SG40 (MCP config reload).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  counts,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import type { GraphJson } from '../../src/core/graph/export.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { acquireIndexLock } from '../../src/core/ingest/lock.js';
import { parseSource } from '../../src/core/parse/index.js';
import { estimateInputTokens, type LLMClient } from '../../src/core/synth/index.js';
import {
  createMcpContext,
  handleAskTool,
  handleGraphTool,
  handleIndexTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

// Fault injection: the next `crash.resolves` calls of `resolveGraph` throw, as if the process
// were killed after the parse loop committed and before the resolver finished.
const crash = vi.hoisted(() => ({ resolves: 0 }));
vi.mock('../../src/core/graph/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/graph/resolver.js')>();
  return {
    ...real,
    resolveGraph: (...args: Parameters<typeof real.resolveGraph>) => {
      if (crash.resolves > 0) {
        crash.resolves--;
        throw new Error('killed before resolve');
      }
      return real.resolveGraph(...args);
    },
  };
});

const dirs: string[] = [];
const dbs: DB[] = [];
const ctxs: McpContext[] = [];
afterEach(() => {
  crash.resolves = 0;
  for (const c of ctxs.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function newRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit17-'));
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

/** `src -kind-> dst` for every edge (`null` for weak edges); labels are `path::qualifiedName`. */
function edgesOf(db: DB): { strong: string[]; weak: string[] } {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const byId = new Map(getAllSymbols(db).map((s) => [s.id, s]));
  const label = (id: number | null): string => {
    if (id === null) return 'null';
    const s = byId.get(id)!;
    return `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`;
  };
  const strong: string[] = [];
  const weak: string[] = [];
  for (const e of getAllEdges(db)) {
    const l = `${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}`;
    (e.weak === 0 && e.dst_symbol !== null ? strong : weak).push(l);
  }
  return { strong: strong.sort(), weak: weak.sort() };
}

async function indexed(files: Record<string, string>): Promise<{ root: string; db: DB }> {
  const root = newRepo(files);
  const db = open(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  return { root, db };
}

async function symbolsOf(
  source: string,
  lang: 'javascript' | 'typescript' | 'python',
  path: string,
): Promise<string[]> {
  const r = await parseSource(source, lang, path);
  return r.symbols
    .filter((s) => s.kind !== 'module')
    .map((s) => `${s.kind} ${s.qualifiedName ?? s.name}${s.exported ? ' (exported)' : ''}`);
}

function bigRepo(n = 120): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    files[`src/m${i}.ts`] =
      `import { f${(i + 1) % n} } from './m${(i + 1) % n}';\n` +
      Array.from(
        { length: 20 },
        (_, k) =>
          `export function f${i}${k === 0 ? '' : `_${k}`}() { return ${k === 0 ? `f${(i + 1) % n}` : `f${i}`}(); }\n`,
      ).join('');
  }
  return files;
}

// ---------------------------------------------------------------- medium

describe('AUDIT-17 medium', () => {
  it.fails(
    'A17-01 a call through a destructured `require` of a package (or of a name the module does not export) is not resolved to the importer’s own binding (SG31 regression of A13-05)',
    async () => {
      const { db } = await indexed({
        'use.js':
          "const { join } = require('path');\n" +
          "const { missing } = require('./util');\n" +
          "const { helper } = require('./util');\n" +
          'function main() { join(); missing(); helper(); }\n' +
          'module.exports = { main };\n',
        'util.js': 'function helper() {}\nmodule.exports = { helper };\n',
      });
      const { strong } = edgesOf(db);
      // The resolvable named import still resolves to its definition.
      expect(strong).toContain('use.js::main -calls-> util.js::helper');
      // Before SG31 both were weak calls; now they are strong edges into the `require` bindings.
      expect(strong).not.toContain('use.js::main -calls-> use.js::join');
      expect(strong).not.toContain('use.js::main -calls-> use.js::missing');
    },
  );

  it.fails(
    'A17-02 concurrent atlas_ask calls on one MCP session never spend more than tokenBudget',
    async () => {
      const root = newRepo({});
      cpSync(SAMPLE, root, { recursive: true });
      // Worst case the API allows: the whole prompt and every max_tokens token billed.
      const greedy: LLMClient = {
        model: 'greedy',
        complete: async (p) => {
          await new Promise((r) => setTimeout(r, 30));
          return {
            content: 'Circle.area [1]',
            inputTokens: estimateInputTokens(p),
            outputTokens: p.maxTokens,
            stopReason: 'end_turn',
          };
        },
      };
      const ctx = createMcpContext({ root, llm: greedy });
      ctxs.push(ctx);
      await handleIndexTool(ctx, {});
      const cfg = join(root, '.atlas', 'config.json');
      writeFileSync(
        cfg,
        JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), tokenBudget: 6000 }),
      );
      const results = await Promise.allSettled([
        handleAskTool(ctx, { question: 'circle area' }),
        handleAskTool(ctx, { question: 'shape perimeter' }),
        handleAskTool(ctx, { question: 'math helpers' }),
      ]);
      // Sequentially the second call is capped to what is left and the third refused.
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0);
      expect(ctx.budget.total().spent).toBeLessThanOrEqual(6000);
    },
  );

  it.fails(
    'A17-03 an MCP read during an atlas_index run (at an SG34 yield) never sees a graph missing the edges of re-parsed files',
    async () => {
      const root = newRepo(bigRepo(60));
      const ctx = createMcpContext({ root, offline: true });
      ctxs.push(ctx);
      await handleIndexTool(ctx, {});
      const edges = (): number => (handleGraphTool(ctx, { limit: 1 }) as GraphJson).totals.edges;
      const full = edges();
      expect(full).toBeGreaterThan(1000);
      // A forced re-index changes nothing; an agent asks for the graph while it runs.
      let done = false;
      const run = handleIndexTool(ctx, { force: true }).finally(() => (done = true));
      let least = full;
      while (!done) {
        least = Math.min(least, edges());
        await new Promise(setImmediate);
      }
      expect((await run).edges).toBe(full);
      // Today the reader sees 0 edges between the parse loop and the resolver.
      expect(least).toBe(full);
    },
  );
});

// ---------------------------------------------------------------- low

describe('AUDIT-17 low', () => {
  it.fails(
    'A17-04 calls in destructuring defaults (`const { c = make() } = x`) are the module’s calls',
    async () => {
      const { db } = await indexed({
        'lib.ts': 'export function make() { return 1; }\nexport const obj = {};\n',
        'use.ts':
          "import { make, obj } from './lib';\n" +
          'export const { c = make() } = obj as { c?: number };\n',
      });
      expect(edgesOf(db).strong).toContain('use.ts::<module> -calls-> lib.ts::make');
    },
  );

  it('A17-05 (holds) a corrupt `<db>.lock` stops the run before anything is written', async () => {
    const { root, db } = await indexed({ 'a.ts': 'export function a() {}\n' });
    const before = counts(db);
    writeFileSync(`${db.name}.lock`, 'not a sqlite file\n');
    writeFileSync(join(root, 'b.ts'), 'export function b() {}\n');
    await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow();
    expect(counts(db)).toEqual(before);
  });

  it.fails(
    'A17-05 a corrupt `<db>.lock` fails with a message that names the lock file',
    async () => {
      const { root, db } = await indexed({ 'a.ts': 'export function a() {}\n' });
      writeFileSync(`${db.name}.lock`, 'not a sqlite file\n');
      // Today: "file is not a database", which reads as if index.db itself were corrupt.
      await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow(
        /index\.db\.lock/,
      );
    },
  );
});

// ---------------------------------------------------------------- holds

describe('AUDIT-17 holds', () => {
  it('SG31 TS/JS patterns: nested, defaults, rest, renames, holes, computed keys, namespaces; locals stay local', async () => {
    const ts =
      'export namespace N { export const { na, nb: nbb } = f(); const { nl } = f(); }\n' +
      'export var { va } = x, vb = 1;\n' +
      'export let [ , second, , fourth = 4] = arr;\n' +
      "const { [k]: comp, 'a-b': ab, 0: zero } = x;\n" +
      'const { ta }: { ta: number } = x;\n' +
      'const { sa } = x as const;\n' +
      'export const { deep: { er: [ { most } ] } } = x;\n' +
      'export const { a: b, ...rest } = x;\n' +
      'const { u1, u2 } = x;\nexport { u1, u2 as U2 };\n' +
      'for (const { la } of xs) {}\n' +
      "describe('x', () => { const { cb } = x; });\n" +
      'function g() { const { gl } = x; }\n';
    expect(await symbolsOf(ts, 'typescript', 'a.ts')).toEqual([
      'variable N (exported)',
      'variable N.na (exported)',
      'variable N.nbb (exported)',
      'variable N.nl',
      'variable va (exported)',
      'variable vb (exported)',
      'variable second (exported)',
      'variable fourth (exported)',
      'variable comp',
      'variable ab',
      'variable zero',
      'variable ta',
      'variable sa',
      'variable most (exported)',
      'variable b (exported)',
      'variable rest (exported)',
      'variable u1 (exported)',
      'variable u2 (exported)',
      'function g',
    ]);
  });

  it('SG31 Python targets: tuples, lists, starred, nested, chained; attributes, subscripts and loop targets are not symbols', async () => {
    const py =
      'a, b = 1, 2\n(c, d) = x\n[e, f] = x\ng, *rest = x\nh, (i, j) = x\n' +
      'k, obj.attr, arr[0] = x\nm = n = 1\no, p = q, r = x\n' +
      'if True:\n    ia, ib = x\n_priv, pub = x\n' +
      'def fn():\n    la, lb = 1, 2\nfor fa, fb in x:\n    pass\n__all__ = ["a", "rest"]\n';
    const syms = await symbolsOf(py, 'python', 'm.py');
    expect(syms.filter((s) => s !== 'function fn' && !s.startsWith('variable __all__'))).toEqual([
      'variable a (exported)',
      'variable b',
      'variable c',
      'variable d',
      'variable e',
      'variable f',
      'variable g',
      'variable rest (exported)',
      'variable h',
      'variable i',
      'variable j',
      'variable k',
      'variable m',
      'variable n',
      'variable o',
      'variable p',
      'variable q',
      'variable r',
      'variable ia',
      'variable ib',
      'variable _priv',
      'variable pub',
    ]);
  });

  it('SG31 importers of destructured TS and Python names resolve strongly (named imports, calls, module attributes)', async () => {
    const { db } = await indexed({
      'lib.ts': 'export function make() { return {} as any; }\n',
      'esm.ts':
        "import { make } from './lib';\n" +
        'export const { a, b: bee = 1, ...rest } = make();\nexport const [x, [y]] = make();\n' +
        'const { local } = make();\nexport { local };\n',
      'con.ts':
        "import { a, bee, x, y, rest, local } from './esm';\n" +
        'export function k() { a(); bee(); x(); y(); rest(); local(); }\n',
      'pkg/__init__.py': '',
      'pkg/m.py': 'def make():\n    return 1, 2\na, (b, *c) = make()\n',
      'use.py': 'from pkg.m import a, c\nfrom pkg import m\ndef run():\n    a(); c(); m.b()\n',
    });
    const { strong } = edgesOf(db);
    for (const n of ['a', 'bee', 'x', 'y', 'rest', 'local']) {
      expect(strong).toContain(`con.ts::<module> -imports-> esm.ts::${n}`);
      expect(strong).toContain(`con.ts::k -calls-> esm.ts::${n}`);
    }
    expect(strong).toContain('esm.ts::<module> -calls-> lib.ts::make');
    for (const n of ['a', 'b', 'c'])
      expect(strong).toContain(`use.py::run -calls-> pkg/m.py::${n}`);
  });

  it('SG32 a stale lock file left by a dead holder does not block, and a held lock makes the run wait', async () => {
    const { root, db } = await indexed({ 'a.ts': 'export function a() {}\n' });
    // A lock taken and released (what a killed process leaves behind: the file, not the OS lock).
    (await acquireIndexLock(db.name))();
    writeFileSync(join(root, 'b.ts'), 'export function b() {}\n');
    expect((await indexRepo(db, root, { skipEmbeddings: true })).filesIndexed).toBe(1);

    const release = await acquireIndexLock(db.name);
    writeFileSync(join(root, 'c.ts'), 'export function c() {}\n');
    let done = false;
    const run = indexRepo(db, root, { skipEmbeddings: true }).then((s) => ((done = true), s));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(counts(db).files).toBe(2);
    release();
    expect((await run).filesIndexed).toBe(1);
    expect(counts(db).files).toBe(3);
  });

  it('SG33 two interrupted runs in a row are both recovered by the next plain run (edges equal a fresh index)', async () => {
    const { root, db } = await indexed({
      'src/a.ts': "import { f } from './util';\nexport function a() { return f(); }\n",
      'src/util/index.ts': 'export function f() { return 1; }\n',
    });
    writeFileSync(join(root, 'src/util.ts'), 'export function f() { return 2; }\n');
    crash.resolves = 1;
    await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow(/killed/);
    writeFileSync(join(root, 'src/b.ts'), 'export const b = 1;\n');
    crash.resolves = 1;
    await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow(/killed/);
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats.resolveReason).toBe('previous run interrupted');
    const fresh = open(join(root, '..', 'fresh.db'));
    await indexRepo(fresh, root, { skipEmbeddings: true });
    expect(edgesOf(db)).toEqual(edgesOf(fresh));
    expect(edgesOf(db).strong).toContain('src/a.ts::a -calls-> src/util.ts::f');
    // And the run after that keeps the (now correct) graph.
    expect((await indexRepo(db, root, { skipEmbeddings: true })).resolveReason).toBeNull();
  });

  it('SG34 a call that joins a queued run sees a change made after the queued call, before the run started', async () => {
    const { root, db } = await indexed(bigRepo(60));
    const first = indexRepo(db, root, { skipEmbeddings: true, force: true });
    const queued = indexRepo(db, root, { skipEmbeddings: true });
    await first;
    // `queued` has not started yet: its start waits for a setImmediate after `first` settles.
    writeFileSync(join(root, 'src/late.ts'), 'export function late() {}\n');
    const joined = indexRepo(db, root, { skipEmbeddings: true });
    expect(joined).toBe(queued);
    const stats = await joined;
    expect(stats.filesIndexed).toBe(1);
    expect(getAllSymbols(db).some((s) => s.name === 'late')).toBe(true);
    expect(counts(db).symbols).toBe(60 * 21 + 2);
  });

  it('SG34 a call made after the queued run started does not join it, and its change is indexed', async () => {
    const { root, db } = await indexed(bigRepo(60));
    const runs = (): number =>
      (db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
    const before = runs();
    const first = indexRepo(db, root, { skipEmbeddings: true });
    while (runs() === before) await new Promise(setImmediate);
    // `first` has started (and walked); a change now needs another run.
    writeFileSync(join(root, 'src/late.ts'), 'export function late() {}\n');
    const second = indexRepo(db, root, { skipEmbeddings: true });
    expect(second).not.toBe(first);
    expect((await first).filesIndexed).toBe(0);
    expect((await second).filesIndexed).toBe(1);
    expect(getAllSymbols(db).some((s) => s.name === 'late')).toBe(true);
  });

  it('SG40 config reload: budget carry-over up and down, a respelled indexPath, an invalid config', async () => {
    const root = newRepo({});
    cpSync(SAMPLE, root, { recursive: true });
    let inFlight: () => void = () => undefined;
    let slow = false;
    const llm: LLMClient = {
      model: 'fake',
      complete: async () => {
        if (slow) await new Promise<void>((r) => (inFlight = r));
        return {
          content: 'Circle.area [1]',
          inputTokens: 300,
          outputTokens: 100,
          stopReason: 'end_turn',
        };
      },
    };
    const ctx = createMcpContext({ root, llm });
    ctxs.push(ctx);
    await handleIndexTool(ctx, {});
    const cfg = join(root, '.atlas', 'config.json');
    const edit = (patch: Record<string, unknown>): void =>
      writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), ...patch }));

    await handleAskTool(ctx, { question: 'circle area' });
    expect(ctx.budget.total()).toMatchObject({ spent: 400 });
    // A call in flight while the budget is replaced is charged to the new one.
    slow = true;
    const pending = handleAskTool(ctx, { question: 'circle area' });
    await new Promise((r) => setTimeout(r, 20));
    edit({ tokenBudget: 50_000 });
    slow = false;
    await handleAskTool(ctx, { question: 'circle area' });
    inFlight();
    await pending;
    expect(ctx.budget.total()).toMatchObject({ cap: 50_000, spent: 1200 });
    // Lowered below what is spent: refused, and the spend is kept.
    edit({ tokenBudget: 1000 });
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(
      /token budget exhausted/,
    );
    expect(ctx.budget.total()).toMatchObject({ cap: 1000, spent: 1200 });
    // The same file spelled differently is not an indexPath change.
    edit({ tokenBudget: 50_000, indexPath: './.atlas/../.atlas/index.db' });
    await expect(handleAskTool(ctx, { question: 'circle area' })).resolves.toBeTruthy();
    // An invalid config fails the call and leaves the session's config as it was.
    edit({ tokenBudget: -5 });
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow();
    expect(ctx.config.tokenBudget).toBe(50_000);
    expect(ctx.budget.total()).toMatchObject({ cap: 50_000, spent: 1600 });
  });
});
