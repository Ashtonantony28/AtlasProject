// AUDIT-20: test coverage, round 5 (SG34, SG40, SG45, SG50, BudgetExhaustedError). Plain `it`
// tests pin behaviour that is correct today but that a surviving mutation showed no other test
// checks (the mutant IDs are in each test name; AUDIT-20.md has the diffs). Each `it.fails`
// asserts the correct behaviour and currently fails, reproducing one finding in AUDIT-20.md
// (IDs A20-xx); when it is fixed it turns red and should become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  MIGRATIONS,
  openDatabase,
  runMigrations,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo, type IndexOptions } from '../../src/core/ingest/index.js';
import { EXTRACTOR_VERSION } from '../../src/core/parse/version.js';
import {
  createMcpContext,
  handleAskTool,
  handleIndexTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

// Fault injection: the next `resolveGraph` throws, as if the run were killed after its parse loop.
const crash = vi.hoisted(() => ({ nextResolve: false }));
vi.mock('../../src/core/graph/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/graph/resolver.js')>();
  return {
    ...real,
    resolveGraph: (...args: Parameters<typeof real.resolveGraph>) => {
      if (crash.nextResolve) {
        crash.nextResolve = false;
        throw new Error('killed before resolve');
      }
      return real.resolveGraph(...args);
    },
  };
});

// A counting stand-in for `createAnthropicClient`: records each model it is asked for; a creation
// fails while `made.fail` is set, and waits for `made.gate` when one is set.
const made = vi.hoisted(() => ({
  models: [] as string[],
  fail: false,
  gate: null as Promise<void> | null,
  completeError: null as Error | null,
}));
vi.mock('../../src/core/synth/llmClient.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/synth/llmClient.js')>();
  return {
    ...real,
    createAnthropicClient: async (model: string) => {
      made.models.push(model);
      const fail = made.fail;
      if (made.gate) await made.gate;
      if (fail) throw new Error('ANTHROPIC_API_KEY is not set');
      return {
        model,
        complete: async () => {
          if (made.completeError) throw made.completeError;
          return {
            content: 'Circle.area [1]',
            inputTokens: 300,
            outputTokens: 100,
            stopReason: 'end_turn',
          };
        },
      };
    },
  };
});

const dirs: string[] = [];
const dbs: DB[] = [];
const ctxs: McpContext[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  crash.nextResolve = false;
  made.models.length = 0;
  made.fail = false;
  made.gate = null;
  made.completeError = null;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of cleanup.splice(0)) f();
  for (const c of ctxs.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-a20-'));
  dirs.push(d);
  return d;
}

function repo(files: Record<string, string>): string {
  const root = join(tmp(), 'repo');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function open(path: string): DB {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

async function indexed(files: Record<string, string>): Promise<{ root: string; db: DB }> {
  const root = repo(files);
  const db = open(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  return { root, db };
}

/** `n` files of 10 small functions each, every function calling the previous one. */
function manyFiles(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    files[`src/m${i}.ts`] = Array.from(
      { length: 10 },
      (_, k) =>
        `export function f${i}_${k}(x: number): number {\n  return ${k === 0 ? 'x' : `f${i}_${k - 1}(x) + 1`};\n}\n`,
    ).join('');
  }
  return files;
}

/** Edges as `src -kind-> dst`, each end labelled `path::qualifiedName(kind)@startLine`. */
function edgeLabels(db: DB): string[] {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const byId = new Map(getAllSymbols(db).map((s) => [s.id, s]));
  const label = (id: number | null): string => {
    if (id === null) return 'null';
    const s = byId.get(id);
    return s
      ? `${paths.get(s.file_id)}::${s.qualified_name ?? s.name}(${s.kind})@${s.start_line}`
      : `dangling#${id}`;
  };
  return getAllEdges(db)
    .map(
      (e) =>
        `${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}${e.weak ? ' (weak)' : ''}${e.meta ? ` ${e.meta}` : ''}`,
    )
    .sort();
}

/** Re-index after `edit`, killed before the resolve: the graph a reader sees at the run's yields. */
async function midRun(db: DB, root: string, edit: () => void): Promise<string[]> {
  edit();
  crash.nextResolve = true;
  await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow('killed');
  return edgeLabels(db);
}

// ---------------------------------------------------------------- SG34 yielding

describe('AUDIT-20 SG34 yielding', () => {
  it('Y01/Y02/Y04: the parse loop yields about every 50 ms, no more often than needed', async () => {
    const { root, db } = await indexed(manyFiles(300));
    let ticks = 0;
    let turns = 0;
    let inLoop = false;
    const timer = setInterval(() => inLoop && ticks++, 5);
    cleanup.push(() => clearInterval(timer));
    let parsed = 0;
    const t0 = { at: 0 };
    const spin = (): void => {
      if (parsed > 0 && parsed < 300) turns++;
      if (parsed < 300) setImmediate(spin);
    };
    const run = indexRepo(db, root, {
      skipEmbeddings: true,
      force: true,
      onFile: () => {
        if (++parsed === 1) {
          inLoop = true;
          t0.at = Date.now();
          setImmediate(spin);
        }
        if (parsed === 300) inLoop = false;
      },
    });
    await run;
    const loopMs = Date.now() - t0.at;
    // A timer fires during the loop (it lasts several yield intervals) ...
    expect(loopMs).toBeGreaterThan(150);
    expect(ticks).toBeGreaterThanOrEqual(2);
    // ... and the loop does not yield after every file.
    expect(turns).toBeLessThan(100);
  });

  it('Y03: a run that takes less than 50 ms still yields between its phases', async () => {
    const { root, db } = await indexed({ 'a.ts': 'export function a() {}\n' });
    let turns = 0;
    let done = false;
    const spin = (): void => {
      if (done) return;
      turns++;
      setImmediate(spin);
    };
    const run = indexRepo(db, root, { force: true }).finally(() => (done = true));
    setImmediate(spin);
    await run;
    // The queue start, the walk, the parse loop and the embed phase each give one turn.
    expect(turns).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------- SG34 coalescing

describe('AUDIT-20 SG34 joining queued runs', () => {
  it('K01–K09: a call joins a queued run only when root and every walk/run option match', async () => {
    const { root, db } = await indexed({
      'a.ts': 'export function a() {}\n',
      'b.py': 'def b():\n    pass\n',
    });
    const base: IndexOptions = { skipEmbeddings: true };
    // `first` takes the queue; every call below queues behind it while it has not started.
    const first = indexRepo(db, root, base);
    const variants: [string, string, IndexOptions][] = [
      ['force', root, { ...base, force: true }],
      ['skipEmbeddings', root, {}],
      ['exclude', root, { ...base, exclude: ['b.py'] }],
      ['include', root, { ...base, include: ['**/*.ts'] }],
      ['languages', root, { ...base, languages: ['python'] }],
      ['maxBytes', root, { ...base, maxBytes: 10 }],
      ['root', join(root, '..'), base],
    ];
    expect(indexRepo(db, root, { ...base, force: false })).toBe(first);
    expect(indexRepo(db, `${root}/./`, base)).toBe(first); // K09: same root, other spelling
    const runs = variants.map(([name, r, opts]) => {
      const run = indexRepo(db, r, opts);
      expect(run, name).not.toBe(first);
      expect(indexRepo(db, r, opts), name).toBe(run);
      return run;
    });
    // K01: callers with a progress callback each get their own run and their own callbacks.
    const seen: string[][] = [[], []];
    const withProgress = seen.map((s) =>
      indexRepo(db, root, { ...base, onFile: (f) => s.push(f.path) }),
    );
    expect(withProgress[0]).not.toBe(withProgress[1]);
    await Promise.all([first, ...runs, ...withProgress]);
    expect(seen).toEqual([
      ['a.ts', 'b.py'],
      ['a.ts', 'b.py'],
    ]);
  });
});

// ---------------------------------------------------------------- SG45 run stamps

describe('AUDIT-20 SG45 extractor stamps of unfinished runs', () => {
  const addRun = (db: DB, statsJson: string | null, finished = false): void => {
    db.prepare('INSERT INTO runs (started_at, finished_at, stats_json) VALUES (?, ?, ?)').run(
      new Date().toISOString(),
      finished ? new Date().toISOString() : null,
      statsJson,
    );
  };
  const stamp = (v: unknown): string => JSON.stringify({ state: { extractorVersion: v } });
  const files = { 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' };

  it('S03: an interrupted run stamped by another extractor after a finished run forces a re-parse', async () => {
    const { root, db } = await indexed(files);
    addRun(db, stamp(EXTRACTOR_VERSION + 1));
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats.extractorUpgrade).toEqual({ from: EXTRACTOR_VERSION + 1, to: EXTRACTOR_VERSION });
    expect(stats.filesIndexed).toBe(2);
  });

  it('S02: an unstamped interrupted run after a finished one is not an upgrade', async () => {
    const { root, db } = await indexed(files);
    addRun(db, null);
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats.extractorUpgrade).toBeUndefined();
    expect(stats.filesIndexed).toBe(0);
    expect(stats.resolveReason).toBe('previous run interrupted');
  });

  it('S01: rows with no run at all (an index from before runs were kept) are re-parsed', async () => {
    const { root, db } = await indexed(files);
    db.exec('DELETE FROM runs');
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats.extractorUpgrade).toEqual({ from: null, to: EXTRACTOR_VERSION });
    expect(stats.filesIndexed).toBe(2);
  });

  it('S06/S07: an unreadable stamp on the only (interrupted) run counts as an unknown writer', async () => {
    for (const bad of [stamp('3'), '{not json']) {
      const { root, db } = await indexed(files);
      db.exec('DELETE FROM runs');
      addRun(db, bad);
      const stats = await indexRepo(db, root, { skipEmbeddings: true });
      expect(stats.extractorUpgrade, bad).toEqual({ from: null, to: EXTRACTOR_VERSION });
    }
  });

  it('S09: a finished run without a recorded state still counts as finished', async () => {
    const { root, db } = await indexed(files);
    db.exec('DELETE FROM runs');
    addRun(db, JSON.stringify({ filesIndexed: 2 }), true); // a finished run from before SG25
    addRun(db, stamp(EXTRACTOR_VERSION)); // then an interrupted current run
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    // The rows may still be the old run's: re-parse them.
    expect(stats.extractorUpgrade).toEqual({ from: null, to: EXTRACTOR_VERSION });
  });
});

// ---------------------------------------------------------------- SG45 migrations

describe('AUDIT-20 SG45 migrations', () => {
  it('G01: migrations run under a write lock taken before the version is re-read', () => {
    const path = join(tmp(), 'index.db');
    const a = new Database(path);
    cleanup.push(() => a.close());
    sqliteVec.load(a);
    a.pragma('journal_mode = WAL');
    // When A re-reads the version inside its transaction, B (another process, no wait) tries to
    // migrate the same file. A must already hold the write lock, so B is refused, not A.
    const prepare = a.prepare.bind(a);
    let tried = false;
    let other: unknown = 'not tried';
    a.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes('MAX(version)')) return stmt;
      return {
        get: (...args: unknown[]) => {
          const v: unknown = stmt.get(...args);
          if (a.inTransaction && !tried) {
            tried = true;
            const b = new Database(path, { timeout: 0 });
            sqliteVec.load(b);
            try {
              runMigrations(b);
              other = 'migrated';
            } catch (err) {
              other = (err as { code?: string }).code;
            } finally {
              b.close();
            }
          }
          return v;
        },
      };
    }) as typeof a.prepare;
    expect(() => runMigrations(a)).not.toThrow();
    expect(other).toBe('SQLITE_BUSY');
    const v = prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number };
    expect(v.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  /** Another process holding the index's write lock (a long index transaction) for `ms`. */
  async function holdWriteLock(path: string, ms: number): Promise<() => Promise<void>> {
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
         const db = new D(${JSON.stringify(path)});
         db.pragma('journal_mode = WAL');
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${ms});`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = new Promise<void>((ok) => holder.once('exit', () => ok()));
    cleanup.push(() => holder.kill());
    await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
    return () => exited;
  }

  it('G05: opening a fresh index while another process holds the write lock waits instead of failing', async () => {
    const path = join(tmp(), 'index.db');
    const done = await holdWriteLock(path, 400);
    const t0 = Date.now();
    const db = open(path); // blocks this thread until the holder commits
    expect(Date.now() - t0).toBeGreaterThan(200);
    const v = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number };
    expect(v.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    await done();
  });

  it('G03: opening a migrated index takes no write lock, so it never waits behind a writer', async () => {
    const path = join(tmp(), 'index.db');
    closeDatabase(openDatabase(path));
    const done = await holdWriteLock(path, 1500);
    const t0 = Date.now();
    open(path);
    expect(Date.now() - t0).toBeLessThan(750);
    await done();
  });
});

// ---------------------------------------------------------------- SG50 carried edges

describe('AUDIT-20 SG50 edges carried over a re-parse', () => {
  const has = (labels: string[], edge: string): boolean =>
    labels.some((l) => l.startsWith(`${edge} `));
  const shift = (labels: string[], file: string): string[] =>
    labels.map((l) =>
      // Every parsed symbol of `file` moved down a line; the module symbol stays at line 1.
      l.replace(
        new RegExp(`(${file}::[^ ]*\\((?!module)\\w+\\)@)(\\d+)`, 'g'),
        (_, p: string, n: string) => `${p}${Number(n) + 1}`,
      ),
    );

  it('C02: an edge follows its symbol by kind when a same-named symbol of another kind moves', async () => {
    const { root, db } = await indexed({
      'a.ts':
        'export interface Shape { w: number }\nexport function Shape() { return helper(); }\nexport function helper() { return 1; }\n',
    });
    const before = edgeLabels(db);
    expect(has(before, 'a.ts::Shape(function)@2 -calls-> a.ts::helper(function)@3')).toBe(true);
    const during = await midRun(db, root, () =>
      writeFileSync(
        join(root, 'a.ts'),
        'export function Shape() { return helper(); }\nexport interface Shape { w: number }\nexport function helper() { return 1; }\n',
      ),
    );
    expect(has(during, 'a.ts::Shape(function)@1 -calls-> a.ts::helper(function)@3')).toBe(true);
    expect(during.join('\n')).not.toMatch(/Shape\(interface\)[^\n]*-calls->/);
  });

  it('C03: an edge follows a method by its qualified name when classes are reordered', async () => {
    const { root, db } = await indexed({
      'a.ts':
        'export class A {\n  run() { return helper(); }\n}\nexport class B {\n  run() { return 2; }\n}\nexport function helper() { return 1; }\n',
    });
    expect(has(edgeLabels(db), 'a.ts::A.run(method)@2 -calls-> a.ts::helper(function)@7')).toBe(
      true,
    );
    const during = await midRun(db, root, () =>
      writeFileSync(
        join(root, 'a.ts'),
        'export class B {\n  run() { return 2; }\n}\nexport class A {\n  run() { return helper(); }\n}\nexport function helper() { return 1; }\n',
      ),
    );
    expect(has(during, 'a.ts::A.run(method)@5 -calls-> a.ts::helper(function)@7')).toBe(true);
    expect(during.join('\n')).not.toMatch(/B\.run\(method\)[^\n]*-calls->/);
  });

  it('C04/C06/C07: same-named symbols keep their own edges (by occurrence), weak flags and meta', async () => {
    const { root, db } = await indexed({
      'm.py':
        'from pkg import missing\n\ndef f():\n    return g()\n\ndef f():\n    return h()\n\ndef g():\n    return missing()\n\ndef h():\n    return 1\n',
    });
    const before = edgeLabels(db);
    // The resolver gives the calls of both bodies to the second `f`: a carry by name alone, or
    // to the first match, would move them to the first one.
    expect(has(before, 'm.py::f(function)@6 -calls-> m.py::g(function)@9')).toBe(true);
    expect(has(before, 'm.py::f(function)@6 -calls-> m.py::h(function)@12')).toBe(true);
    expect(before.some((e) => e.includes('(weak)'))).toBe(true);
    expect(before.some((e) => e.includes('{'))).toBe(true);
    const during = await midRun(db, root, () =>
      writeFileSync(join(root, 'm.py'), `\n${readFileSync(join(root, 'm.py'), 'utf8')}`),
    );
    expect(during).toEqual(shift(before, 'm.py'));
  });

  it('C08/C09/C10/C12: module symbols keep their edges once; edges of a removed symbol are dropped', async () => {
    const { root, db } = await indexed({
      'a.ts':
        "import * as nb from './b';\nimport { b, gone } from './b';\nexport function a() { return b() + gone() + nb.b(); }\n",
      'b.ts': 'export function b() { return 1; }\nexport function gone() { return 2; }\n',
    });
    const before = edgeLabels(db);
    expect(before.filter((e) => e.includes('-> b.ts::b.ts(module)@1'))).toHaveLength(1);
    expect(before.filter((e) => e.includes('b.ts::gone'))).not.toHaveLength(0);
    const during = await midRun(db, root, () =>
      writeFileSync(join(root, 'b.ts'), '\nexport function b() { return 1; }\n'),
    );
    expect(during).toEqual(shift(before, 'b.ts').filter((e) => !e.includes('b.ts::gone')));
  });
});

// ---------------------------------------------------------------- SG40 client cache

describe('AUDIT-20 SG40 MCP client per model', () => {
  async function session(): Promise<{ ctx: McpContext; edit: (p: object) => void }> {
    const root = join(tmp(), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    const ctx = createMcpContext({ root });
    ctxs.push(ctx);
    await handleIndexTool(ctx, {});
    const cfg = join(root, '.atlas', 'config.json');
    const edit = (patch: object): void =>
      writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), ...patch }));
    return { ctx, edit };
  }
  const ask = (ctx: McpContext) => handleAskTool(ctx, { question: 'circle area' });

  it('R05/R06: one client per model; a failed creation is retried by the next call', async () => {
    const { ctx, edit } = await session();
    await ask(ctx);
    await ask(ctx);
    expect(made.models).toEqual([ctx.config.synthModel]);
    edit({ synthModel: 'model-b' });
    made.fail = true;
    await expect(ask(ctx)).rejects.toThrow('ANTHROPIC_API_KEY is not set');
    made.fail = false;
    expect((await ask(ctx)).model).toBe('model-b');
    await ask(ctx);
    expect(made.models.slice(1)).toEqual(['model-b', 'model-b']);
  });

  it('R07: a late failure of an old model’s client does not drop the current model’s client', async () => {
    const { ctx, edit } = await session();
    edit({ synthModel: 'model-a' });
    made.fail = true;
    let open: () => void = () => undefined;
    made.gate = new Promise<void>((r) => (open = r));
    const failing = ask(ctx);
    await vi.waitFor(() => expect(made.models).toEqual(['model-a']));
    made.fail = false;
    made.gate = null;
    edit({ synthModel: 'model-b' });
    await ask(ctx);
    open();
    await expect(failing).rejects.toThrow('ANTHROPIC_API_KEY is not set');
    await ask(ctx);
    expect(made.models).toEqual(['model-a', 'model-b']);
  });
});

// ---------------------------------------------------------------- BudgetExhaustedError remedy

describe('AUDIT-20 BudgetExhaustedError remedy', () => {
  it('E03: with --budget, an API error from docs is reported as itself, not as a budget error', async () => {
    const root = join(tmp(), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', root]);
    made.completeError = new Error('401 authentication_error: invalid x-api-key');
    await expect(runCli(['docs', '--budget', '50000', '--cwd', root])).rejects.toThrow(
      /^401 authentication_error: invalid x-api-key$/,
    );
  });
});
