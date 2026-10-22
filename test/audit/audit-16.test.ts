// AUDIT-16: test coverage, round 4 (SG25–SG33). Plain `it` tests pin behaviour that is correct
// today but that a surviving mutation showed no other test checks (the mutant is named in each
// test; AUDIT-16.md has the diff). Each `it.fails` asserts the correct behaviour and currently
// fails, reproducing one finding in AUDIT-16.md (IDs A16-xx); when it is fixed it turns red and
// should become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getAllSymbols,
  MIGRATIONS,
  openDatabase,
  runMigrations,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { acquireIndexLock } from '../../src/core/ingest/lock.js';
import { walkRepoReport } from '../../src/core/ingest/walker.js';
import { parseSource } from '../../src/core/parse/index.js';

// Fault injection: the next `resolveGraph` throws (a run killed after its parse loop), and
// `parseSourceOrThrow` throws for any source containing `fault.parseMarker` (a tree-sitter failure).
const fault = vi.hoisted(() => ({ nextResolve: false, parseMarker: null as string | null }));
vi.mock('../../src/core/graph/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/graph/resolver.js')>();
  return {
    ...real,
    resolveGraph: (...args: Parameters<typeof real.resolveGraph>) => {
      if (fault.nextResolve) {
        fault.nextResolve = false;
        throw new Error('killed before resolve');
      }
      return real.resolveGraph(...args);
    },
  };
});
vi.mock('../../src/core/parse/parser.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/parse/parser.js')>();
  return {
    ...real,
    parseSourceOrThrow: (...args: Parameters<typeof real.parseSourceOrThrow>) => {
      if (fault.parseMarker !== null && args[0].includes(fault.parseMarker)) {
        return Promise.reject(new Error('tree-sitter: injected failure'));
      }
      return real.parseSourceOrThrow(...args);
    },
  };
});

const dirs: string[] = [];
const dbs: DB[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  fault.nextResolve = false;
  fault.parseMarker = null;
  for (const f of cleanup.splice(0)) f();
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'atlas-a16-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(files: Record<string, string>): string {
  const root = tmp();
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

const fiveFiles = (): Record<string, string> =>
  Object.fromEntries(
    [0, 1, 2, 3, 4].map((i) => [
      `m${i}.ts`,
      `import { f${(i + 1) % 5} } from './m${(i + 1) % 5}';\nexport function f${i}(): number {\n  return f${(i + 1) % 5}();\n}\n`,
    ]),
  );

// ---------------------------------------------------------------- migrations (A16-01)

describe('AUDIT-16 high', () => {
  it('A16-01: a connection whose migration check races another opener does not fail on `_migrations.version`', () => {
    const path = join(tmp(), 'index.db');
    // Connection A opens the fresh file as openDatabase does, and reads "nothing applied".
    // Before it writes, connection B (another `atlas index` / `atlas mcp` process) opens the
    // same file and applies every migration. This is the interleaving that makes
    // test/ingest/concurrency.test.ts fail with "UNIQUE constraint failed: _migrations.version".
    const a = new Database(path);
    cleanup.push(() => a.close());
    sqliteVec.load(a);
    a.pragma('journal_mode = WAL');
    const prepare = a.prepare.bind(a);
    let raced = false;
    a.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (raced || !sql.includes('MAX(version)')) return stmt;
      return {
        get: (...args: unknown[]) => {
          const stale: unknown = stmt.get(...args);
          raced = true;
          closeDatabase(openDatabase(path));
          return stale;
        },
      };
    }) as typeof a.prepare;

    expect(() => runMigrations(a)).not.toThrow();
    const v = prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number };
    expect(v.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });
});

// ---------------------------------------------------------------- index lock (SG32)

describe('AUDIT-16 index lock', () => {
  it('L04: waiting for the lock never blocks the event loop (a 50 ms timer fires on time)', async () => {
    const path = join(tmp(), 'index.db');
    const release = await acquireIndexLock(path);
    try {
      const t0 = Date.now();
      let firedAt = -1;
      const timer = setTimeout(() => (firedAt = Date.now() - t0), 50);
      await expect(acquireIndexLock(path, 400)).rejects.toThrow(/gave up after/);
      clearTimeout(timer);
      expect(firedAt).toBeGreaterThanOrEqual(0);
      expect(firedAt).toBeLessThan(300);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      release();
    }
  });

  it('L07: a waiting run polls about every 100 ms, not in a busy loop', async () => {
    const path = join(tmp(), 'index.db');
    const release = await acquireIndexLock(path);
    const exec = vi.spyOn(Database.prototype, 'exec');
    try {
      await expect(acquireIndexLock(path, 500)).rejects.toThrow(/gave up after/);
      const attempts = exec.mock.calls.filter(([sql]) => sql === 'BEGIN EXCLUSIVE').length;
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(12);
    } finally {
      exec.mockRestore();
      release();
    }
  });

  it('L03: an error other than SQLITE_BUSY is thrown at once, not reported as another run', async () => {
    const path = join(tmp(), 'index.db');
    writeFileSync(`${path}.lock`, 'not a database '.repeat(64));
    const t0 = Date.now();
    const err = await acquireIndexLock(path, 5_000).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err?.code).toBe('SQLITE_NOTADB');
    expect(err?.message).not.toMatch(/another atlas index run/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it.skipIf(process.platform !== 'linux')(
    'L02: giving up closes the waiting connection (no file descriptor leak per failed wait)',
    async () => {
      const path = join(tmp(), 'index.db');
      const release = await acquireIndexLock(path);
      try {
        const fds = () => readdirSync('/proc/self/fd').length;
        await expect(acquireIndexLock(path, 0)).rejects.toThrow(/gave up/);
        const before = fds();
        for (let i = 0; i < 5; i++)
          await expect(acquireIndexLock(path, 0)).rejects.toThrow(/gave up/);
        expect(fds()).toBeLessThanOrEqual(before + 1);
      } finally {
        release();
      }
    },
  );

  it('Q02/Q03: the lock follows the real DB file, so a run through a symlinked index.db waits', async () => {
    const root = repo(fiveFiles());
    const atlas = join(root, '.atlas');
    mkdirSync(atlas);
    const real = join(atlas, 'real.db');
    closeDatabase(openDatabase(real));
    symlinkSync(real, join(atlas, 'index.db'));
    const db = open(join(atlas, 'index.db'));

    const release = await acquireIndexLock(realpathSync(real));
    let done = false;
    const run = indexRepo(db, root, { skipEmbeddings: true }).then((s) => ((done = true), s));
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
    } finally {
      release();
    }
    expect((await run).filesIndexed).toBe(5);
  });

  it('Q01: indexing an in-memory DB takes no file lock (no `:memory:.lock` in the cwd)', async () => {
    const lock = join(process.cwd(), ':memory:.lock');
    const existed = existsSync(lock);
    cleanup.push(() => {
      if (!existed) rmSync(lock, { force: true });
    });
    const db = open(':memory:');
    const stats = await indexRepo(db, repo(fiveFiles()), { skipEmbeddings: true });
    expect(stats.filesIndexed).toBe(5);
    expect(existsSync(lock)).toBe(existed);
  });

  it('Q04/Q07: runs on one in-memory DB queue: none starts before the previous one settles', async () => {
    const root = repo(fiveFiles());
    const db = open(':memory:');
    const log: string[] = [];
    const run = (n: string) =>
      indexRepo(db, root, { skipEmbeddings: true, force: true, onFile: () => log.push(n) }).then(
        () => log.push(`${n} done`),
      );
    const r1 = run('1');
    const r2 = run('2');
    await r1;
    const r3 = run('3');
    await Promise.all([r2, r3]);
    const expected = ['1', '2', '3'].flatMap((n) => [...Array<string>(5).fill(n), `${n} done`]);
    expect(log).toEqual(expected);
    expect(getAllSymbols(db).filter((s) => s.kind !== 'module')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------- interrupted runs (SG33)

describe('AUDIT-16 interrupted runs', () => {
  it('R03/R05: after an interrupted run, a file change says `files changed` and --force says `forced`', async () => {
    const root = repo(fiveFiles());
    const db = open(join(root, '.atlas', 'index.db'));
    const opts = { skipEmbeddings: true };
    await indexRepo(db, root, opts);

    // R03: the interruption and a file change are both reasons; the file change is reported.
    fault.nextResolve = true;
    writeFileSync(join(root, 'm0.ts'), `${fiveFiles()['m0.ts']}export const extra = 1;\n`);
    await expect(indexRepo(db, root, opts)).rejects.toThrow('killed before resolve');
    writeFileSync(join(root, 'm1.ts'), `${fiveFiles()['m1.ts']}export const extra = 2;\n`);
    expect((await indexRepo(db, root, opts)).resolveReason).toBe('files changed');

    // R05: --force after an interruption says `forced`.
    fault.nextResolve = true;
    writeFileSync(join(root, 'm2.ts'), `${fiveFiles()['m2.ts']}export const extra = 3;\n`);
    await expect(indexRepo(db, root, opts)).rejects.toThrow('killed before resolve');
    expect((await indexRepo(db, root, { ...opts, force: true })).resolveReason).toBe('forced');
    expect((await indexRepo(db, root, opts)).resolveReason).toBeNull();
  });

  it('A16-05: after an interrupted first index, the next run reports the interruption, not an extractor upgrade', async () => {
    const root = repo(fiveFiles());
    const db = open(join(root, '.atlas', 'index.db'));
    fault.nextResolve = true;
    await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow(
      'killed before resolve',
    );
    // The rows were written by this extractor a moment ago; `atlas index` instead prints
    // "index was written by an older Atlas; re-parsed every file with extractor v3".
    const next = await indexRepo(db, root, { skipEmbeddings: true });
    expect(next.extractorUpgrade).toBeUndefined();
    expect(next.filesIndexed).toBe(0);
    expect(next.resolveReason).toBe('previous run interrupted');
  });
});

// ---------------------------------------------------------------- per-file writes (SG32)

describe('AUDIT-16 per-file writes', () => {
  it('P02: re-parsing an edited file leaves no orphan vectors behind', async () => {
    const root = repo(fiveFiles());
    const db = open(join(root, '.atlas', 'index.db'));
    await indexRepo(db, root);
    writeFileSync(
      join(root, 'm0.ts'),
      'export function renamed(): number {\n  return 0;\n}\nexport function other(): number {\n  return 1;\n}\n',
    );
    const stats = await indexRepo(db, root);
    expect(stats.filesIndexed).toBe(1);
    const symbolIds = new Set(
      getAllSymbols(db)
        .filter((s) => s.kind !== 'module')
        .map((s) => s.id),
    );
    const vecIds = (
      db.prepare('SELECT rowid AS id FROM embeddings_vec').all() as { id: number | bigint }[]
    ).map((r) => Number(r.id));
    expect(vecIds.filter((id) => !symbolIds.has(id))).toEqual([]);
    expect(vecIds).toHaveLength(symbolIds.size);
  });

  it('I11/I12: onFile names a parse failure and counts one diagnostic in the singular', async () => {
    const root = repo({
      'ok.ts': 'export function a(): number {\n  return 1;\n}\nconst x = ;\n',
      'bad.ts': '// FAULT\nexport function b(): number {\n  return 2;\n}\n',
    });
    const db = open(join(root, '.atlas', 'index.db'));
    fault.parseMarker = 'FAULT';
    const events: { path: string; status: string; reason?: string }[] = [];
    const stats = await indexRepo(db, root, {
      skipEmbeddings: true,
      onFile: (e) => events.push(e),
    });
    expect(stats.filesFailed).toBe(1);
    expect(events).toContainEqual({
      path: 'bad.ts',
      status: 'failed',
      reason: 'tree-sitter: injected failure',
    });
    expect(events).toContainEqual({
      path: 'ok.ts',
      status: 'parsed',
      reason: '1 parse diagnostic',
    });
  });
});

// ---------------------------------------------------------------- walker (SG30)

describe('AUDIT-16 walker', () => {
  it('W08: a .gitignore that cannot be read (here a directory) is skipped, not fatal', () => {
    const root = repo({ 'a.ts': 'export const a = 1;\n', 'sub/b.ts': 'export const b = 1;\n' });
    mkdirSync(join(root, 'sub', '.gitignore'));
    const { files, unreadable } = walkRepoReport(root);
    expect(files.map((f) => f.relativePath)).toEqual(['a.ts', 'sub/b.ts']);
    expect(unreadable).toEqual([]);
  });
});

// ---------------------------------------------------------------- destructuring (SG31)

describe('AUDIT-16 destructured Python targets', () => {
  it('Y06/Y07: span and signature cover the whole assignment, like a single-name assignment', async () => {
    const src = 'a, b = (\n    1,\n    2,\n)\nc = (\n    3\n)\n';
    const r = await parseSource(src, 'python', 'm.py');
    const pick = (n: string) => {
      const s = r.symbols.find((x) => x.name === n)!;
      return [s.signature, s.startLine, s.endLine];
    };
    expect(pick('a')).toEqual(['a, b = (', 1, 4]);
    expect(pick('b')).toEqual(['a, b = (', 1, 4]);
    expect(pick('c')).toEqual(['c = (', 5, 7]);
  });
});
