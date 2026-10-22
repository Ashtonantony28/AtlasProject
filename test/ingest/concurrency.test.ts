// SG32 (cross-process index runs serialise on a file lock) and SG33 (an interrupted run is
// re-resolved by the next plain run).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeDatabase,
  counts,
  getAllEdges,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { acquireIndexLock } from '../../src/core/ingest/lock.js';
import { writeBigRepo } from '../helpers/bigRepo.js';

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

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli/index.ts');

const dirs: string[] = [];
afterEach(() => {
  crash.nextResolve = false;
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
