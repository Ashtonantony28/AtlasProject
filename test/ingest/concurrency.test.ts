// SG32 (cross-process index runs serialise on a file lock), SG33 (an interrupted run is
// re-resolved by the next plain run) and SG80 (index runs and `atlas docs` wait out another writer).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeDatabase,
  counts,
  getAllEdges,
  getLastRun,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo, type IndexOptions } from '../../src/core/ingest/index.js';
import { acquireIndexLock } from '../../src/core/ingest/lock.js';
import { writeBigRepo } from '../helpers/bigRepo.js';
import { lockHolder } from '../helpers/lockHolder.js';
import { runCli } from '../cli/helpers.js';

const crash = vi.hoisted(() => ({
  nextResolve: false,
  beforeResolve: undefined as (() => void) | undefined,
  afterResolve: undefined as (() => void) | undefined,
}));
vi.mock('../../src/core/graph/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/graph/resolver.js')>();
  return {
    ...real,
    resolveGraph: (...args: Parameters<typeof real.resolveGraph>) => {
      if (crash.nextResolve) {
        crash.nextResolve = false;
        throw new Error('killed before resolve');
      }
      crash.beforeResolve?.();
      const stats = real.resolveGraph(...args);
      crash.afterResolve?.();
      return stats;
    },
  };
});

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli/index.ts');

const dirs: string[] = [];
afterEach(() => {
  crash.nextResolve = false;
  crash.beforeResolve = crash.afterResolve = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sg32-'));
  dirs.push(dir);
  cpSync(join(ROOT, 'fixtures/sample/src'), join(dir, 'src'), { recursive: true });
  writeBigRepo(dir);
  return dir;
}

function withDb<T>(dir: string, f: (db: DB) => T): T {
  const db = openDatabase(join(dir, '.atlas', 'index.db'));
  try {
    return f(db);
  } finally {
    closeDatabase(db);
  }
}

function snapshot(db: DB) {
  const files = new Map(
    (db.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[]).map((f) => [
      f.id,
      f.path,
    ]),
  );
  const label = new Map(
    getAllSymbols(db).map((s) => [s.id, `${files.get(s.file_id)}::${s.qualified_name ?? s.name}`]),
  );
  const { files: f, symbols, imports, edges } = counts(db);
  const refs = (db.prepare('SELECT COUNT(*) AS c FROM refs').get() as { c: number }).c;
  return {
    counts: { f, symbols, imports, edges, refs },
    edges: getAllEdges(db)
      .map(
        (e) =>
          `${e.src_symbol === null ? 'null' : label.get(e.src_symbol)} -${e.kind}-> ${e.dst_symbol === null ? 'null' : label.get(e.dst_symbol)}${e.weak ? ' (weak)' : ''}`,
      )
      .sort(),
  };
}

interface Proc {
  code: Promise<number | null>;
  stdout: () => string;
  stderr: () => string;
  firstParsed: Promise<void>;
}

function cliIndex(dir: string): Proc {
  const child = spawn(TSX, [CLI, 'index', dir, '--verbose'], { stdio: 'pipe' });
  let out = '';
  let err = '';
  let parsed: () => void = () => undefined;
  const firstParsed = new Promise<void>((r) => (parsed = r));
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    if (out.includes('[parsed]')) parsed();
  });
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const code = new Promise<number | null>((r) => child.on('close', (c) => (parsed(), r(c))));
  return { code, stdout: () => out, stderr: () => err, firstParsed };
}

describe('SG32 index runs across processes', () => {
  it('two `atlas index` processes, the second started while the first parses, leave exactly one run’s rows', async () => {
    const single = repo();
    const singleRun = cliIndex(single);
    expect(await singleRun.code, singleRun.stderr()).toBe(0);
    const expected = withDb(single, snapshot);
    expect(expected.counts.symbols).toBeGreaterThan(1000);

    for (const stagger of ['together', 'while parsing'] as const) {
      const dir = repo();
      const a = cliIndex(dir);
      if (stagger === 'while parsing') await a.firstParsed;
      const b = cliIndex(dir);
      expect(await a.code, a.stderr()).toBe(0);
      expect(await b.code, b.stderr()).toBe(0);
      expect(withDb(dir, snapshot)).toEqual(expected);
    }
  }, 120_000);

  it('a run waits for the lock held by another run, and gives up with a clear message', async () => {
    const dir = repo();
    const db = openDatabase(join(dir, '.atlas', 'index.db'));
    try {
      const path = join(dir, '.atlas', 'index.db');
      const release = await acquireIndexLock(path);
      await expect(acquireIndexLock(path, 150)).rejects.toThrow(
        `another atlas index run is writing ${path}; gave up after 0s`,
      );
      let done = false;
      const run = indexRepo(db, dir, { skipEmbeddings: true }).then((s) => ((done = true), s));
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      expect(counts(db).files).toBe(0);
      release();
      expect((await run).filesIndexed).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });
});

const M0 =
  "import { f1_0 } from './m1';\nexport function f0_0(x: number): number {\n  return f1_0(x);\n}\n";

describe('SG33 interrupted index runs', () => {
  it('the next plain run re-resolves (`previous run interrupted`) to the edges of a --force run', async () => {
    const dir = repo();
    const db = openDatabase(join(dir, '.atlas', 'index.db'));
    try {
      await indexRepo(db, dir, { skipEmbeddings: true });
      writeFileSync(join(dir, 'src/m0.ts'), M0);
      crash.nextResolve = true;
      await expect(indexRepo(db, dir, { skipEmbeddings: true })).rejects.toThrow(
        'killed before resolve',
      );

      expect((await indexRepo(db, dir, { skipEmbeddings: true })).resolveReason).toBe(
        'previous run interrupted',
      );
      expect((await indexRepo(db, dir, { skipEmbeddings: true })).resolveReason).toBeNull();
      const after = snapshot(db);

      const clean = repo();
      writeFileSync(join(clean, 'src/m0.ts'), M0);
      const cdb = openDatabase(join(clean, '.atlas', 'index.db'));
      try {
        const forced = await indexRepo(cdb, clean, { skipEmbeddings: true, force: true });
        expect(forced.resolveReason).toBe('forced');
        expect(after).toEqual(snapshot(cdb));
      } finally {
        closeDatabase(cdb);
      }
      expect(after.edges).toContain('src/m0.ts::f0_0 -calls-> src/m1.ts::f1_0');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('SG50 edges of re-parsed files until the resolve', () => {
  it('an edit keeps the edges of symbols that survive it and drops those of removed ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-sg50-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.ts'), 'export function f() {}\nexport function g() {}\n');
    writeFileSync(
      join(dir, 'b.ts'),
      "import { f, g } from './a';\nexport function h() { f(); g(); }\nexport function i() { h(); }\n",
    );
    const db = openDatabase(join(dir, '.atlas', 'index.db'));
    try {
      await indexRepo(db, dir, { skipEmbeddings: true });
      const before = snapshot(db).edges;
      expect(before).toContain('b.ts::h -calls-> a.ts::g');
      // Both files re-parsed, `g` removed, then killed before the resolve: the state a reader
      // sees at the run's yield after the parse loop.
      writeFileSync(join(dir, 'a.ts'), '\nexport function f() {}\nexport function k() {}\n');
      writeFileSync(join(dir, 'b.ts'), `\n${readFileSync(join(dir, 'b.ts'), 'utf8')}`);
      crash.nextResolve = true;
      await expect(indexRepo(db, dir, { skipEmbeddings: true })).rejects.toThrow('killed');
      expect(snapshot(db).edges).toEqual(before.filter((e) => !e.includes('a.ts::g')));
      expect((await indexRepo(db, dir, { skipEmbeddings: true })).resolveReason).toBe(
        'previous run interrupted',
      );
      expect(snapshot(db).edges).toContain('b.ts::h -calls-> null (weak)');
    } finally {
      closeDatabase(db);
    }
  });
});

const REMEDY = '(another process is writing the index; retry when it finishes)';
const busy = (step: string): RegExp =>
  new RegExp(`^${step}: database is locked ${REMEDY.replace(/[()]/g, '\\$&')}$`);

describe('SG80 index runs and `atlas docs` wait out another writer', () => {
  function small(): string {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-sg80-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.ts'), 'export function f() {}\n');
    writeFileSync(join(dir, 'b.ts'), "import { f } from './a';\nexport function g() { f(); }\n");
    writeFileSync(join(dir, 'c.ts'), "import { g } from './b';\nexport function h() { g(); }\n");
    return dir;
  }

  function sample(): string {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-sg80-'));
    dirs.push(dir);
    cpSync(join(ROOT, 'fixtures/sample/src'), join(dir, 'src'), { recursive: true });
    return dir;
  }

  async function cli(args: string[]): Promise<{ err: string; ms: number }> {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const t0 = Date.now();
    try {
      await runCli(args);
      return { err: '', ms: Date.now() - t0 };
    } catch (e) {
      return { err: (e as Error).message, ms: Date.now() - t0 };
    } finally {
      out.mockRestore();
    }
  }

  // Where another connection takes the write lock, for 1 s, during a forced run.
  const STEPS = [
    'run stamp', // before the run starts
    'index write', // between two files' writes
    'prune', // after the last file, before its deleted file is pruned
    'graph resolve',
    'embeddings write',
    'finish stamp', // after the resolve of a run without embeddings
  ] as const;

  it.each(STEPS)('an index run waits out a ~1 s hold taken before its %s', async (step) => {
    const dir = small();
    const path = join(dir, '.atlas', 'index.db');
    const db = openDatabase(path);
    const holder = await lockHolder(path);
    try {
      await indexRepo(db, dir, { skipEmbeddings: true });
      if (step === 'prune') rmSync(join(dir, 'c.ts'));
      let heldAt = 0;
      const hold = (): void => {
        heldAt = Date.now();
        holder.hold(1000);
      };
      let parsed = 0;
      const opts: IndexOptions = {
        force: true,
        skipEmbeddings: step !== 'embeddings write',
        onFile: () => {
          parsed++;
          if ((step === 'index write' && parsed === 1) || (step === 'prune' && parsed === 2))
            hold();
        },
      };
      if (step === 'graph resolve') crash.beforeResolve = hold;
      if (step === 'embeddings write' || step === 'finish stamp') crash.afterResolve = hold;
      if (step === 'run stamp') hold();

      const stats = await indexRepo(db, dir, opts);
      expect(heldAt).toBeGreaterThan(0);
      expect(Date.now() - heldAt).toBeGreaterThan(900);
      expect(stats.filesIndexed).toBe(step === 'prune' ? 2 : 3);
      expect(stats.filesRemoved).toBe(step === 'prune' ? 1 : 0);
      expect(stats.edges).toBeGreaterThan(0);
      if (step === 'embeddings write') expect(stats.embeddings).toBeGreaterThan(0);
      expect(getLastRun(db)?.finished_at).not.toBeNull();
    } finally {
      await holder.close();
      closeDatabase(db);
    }
  });

  it('a hold past the busy timeout fails the run naming its step, the cause and the remedy', async () => {
    const dir = small();
    const path = join(dir, '.atlas', 'index.db');
    const db = openDatabase(path);
    const holder = await lockHolder(path);
    try {
      let parsed = 0;
      const t0 = Date.now();
      await expect(
        indexRepo(db, dir, {
          skipEmbeddings: true,
          onFile: () => void (++parsed === 1 && holder.hold(6500)),
        }),
      ).rejects.toThrow(busy('index write'));
      expect(Date.now() - t0).toBeGreaterThan(4900);
    } finally {
      await holder.close();
      closeDatabase(db);
    }
  }, 20_000);

  it('`atlas index` and `atlas docs` succeed while another connection holds the lock for ~1 s', async () => {
    const dir = sample();
    const path = join(dir, '.atlas', 'index.db');
    expect((await cli(['index', dir])).err).toBe('');
    const holder = await lockHolder(path);
    try {
      holder.hold(1000);
      const index = await cli(['index', '--force', dir]);
      expect(index.err).toBe('');
      expect(index.ms).toBeGreaterThan(800);

      holder.hold(1000);
      const docs = await cli(['docs', '--offline', '--cwd', dir]);
      expect(docs.err).toBe('');
      expect(docs.ms).toBeGreaterThan(800);
      expect(withDb(dir, (db) => counts(db).docs)).toBeGreaterThan(0);
    } finally {
      await holder.close();
    }
  });

  it('`atlas docs` and `atlas index` held past the busy timeout fail naming the step, the cause and the remedy', async () => {
    const dir = sample();
    const path = join(dir, '.atlas', 'index.db');
    expect((await cli(['index', dir])).err).toBe('');
    const holder = await lockHolder(path);
    try {
      holder.hold(6000);
      const docs = await cli(['docs', '--offline', '--cwd', dir]);
      expect(docs.err).toMatch(busy('docs write'));
      expect(docs.ms).toBeGreaterThan(4900);
      await holder.released();

      holder.hold(6000);
      const index = await cli(['index', dir]);
      expect(index.err).toMatch(busy('run stamp'));
      expect(index.ms).toBeGreaterThan(4900);
    } finally {
      await holder.close();
    }
  }, 30_000);
});
