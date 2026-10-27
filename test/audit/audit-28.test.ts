// AUDIT-28: test coverage, round 7 (SG80, SG90). Plain `it` tests pin behaviour that is correct
// today but that a surviving mutation showed no other test checks (the mutant IDs are in each test
// name; AUDIT-28.md has the diffs). Each `it.fails` asserts the correct behaviour and currently
// fails, reproducing one finding in AUDIT-28.md (IDs A28-xx); when it is fixed it turns red and
// should become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeDatabase,
  deleteFile,
  getDoc,
  nameBusy,
  openDatabase,
  upsertDoc,
  upsertFile,
  type DB,
} from '../../src/core/db/index.js';
import { immediate } from '../../src/core/db/database.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { lockHolder } from '../helpers/lockHolder.js';
import { runCli } from '../cli/helpers.js';

// `hook.wal(path)` runs before every `journal_mode = WAL` pragma (it may throw, as SQLite would);
// `hook.stat(path)` runs before `statSync`; `hook.parseFail` makes those paths fail to parse.
const hook = vi.hoisted(() => ({
  wal: undefined as ((path: string) => void) | undefined,
  stat: undefined as ((path: string) => void) | undefined,
  parseFail: new Set<string>(),
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default;
  class Hooked extends Real {
    pragma(source: string, options?: Database.PragmaOptions): unknown {
      if (source === 'journal_mode = WAL') hook.wal?.(this.name);
      return super.pragma(source, options);
    }
  }
  return { default: Hooked };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    hook.stat?.(String(args[0]));
    return real.statSync(...args);
  }) as typeof real.statSync;
  return { ...real, default: { ...real, statSync }, statSync };
});
vi.mock('../../src/core/parse/parser.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/parse/parser.js')>();
  return {
    ...real,
    parseSourceOrThrow: (...args: Parameters<typeof real.parseSourceOrThrow>) =>
      args[2] !== undefined && hook.parseFail.has(args[2])
        ? Promise.reject(new Error('parse failed'))
        : real.parseSourceOrThrow(...args),
  };
});

const ROOT = resolve(__dirname, '../..');
const REMEDY = ' (another process is writing the index; retry when it finishes)';
const busyError = (code = 'SQLITE_BUSY'): Error =>
  new Database.SqliteError('database is locked', code);

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  hook.wal = hook.stat = undefined;
  hook.parseFail.clear();
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0)) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-a28-'));
  dirs.push(d);
  return d;
}

function open(path: string): DB {
  const db = openDatabase(path);
  cleanup.push(() => db.open && closeDatabase(db));
  return db;
}

/** A `Date.now` that moves `step` ms per call, for loops bounded by the busy timeout. */
function fastClock(step: number): void {
  let t = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => (t += step));
}

describe('A28-01 (high) a WAL switch refused while another opener finishes it (SG90)', () => {
  // Two processes open a 0-byte index (beside a stale `-wal`). One gets `SQLITE_BUSY` at once while
  // the other switches the file to WAL. If the other has written page 1 by the time this one
  // checks the size, `switchToWal` gives up, though nothing holds a lock any more.
  it('A28-01 an opener whose switch was refused retries once the other opener has switched the file', () => {
    const path = join(tmp(), 'index.db');
    const racer = new Database(path); // a 0-byte file another process is switching to WAL
    cleanup.push(() => racer.close());
    racer.exec('BEGIN IMMEDIATE');
    hook.stat = (p) => {
      if (p !== path || !racer.inTransaction) return;
      // The racer finishes its switch when this opener checks the size (before SG105: on refusal).
      racer.exec('COMMIT');
      racer.pragma('journal_mode = WAL');
    };
    const db = open(path);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('A28-01 an opener whose stale-WAL delete lost the race retries once the other opener has switched the file', () => {
    // CI's `disk I/O error`: both openers' first reads delete the stale `-wal`; this one's fails
    // with SQLITE_IOERR_DELETE_NOENT after the other has deleted it and written page 1.
    const path = join(tmp(), 'index.db');
    writeFileSync(path, '');
    let raced = false;
    hook.wal = (p) => {
      if (p !== path || raced) return;
      raced = true;
      const racer = new Database(path);
      racer.pragma('journal_mode = WAL');
      racer.close();
      throw new Database.SqliteError('disk I/O error', 'SQLITE_IOERR_DELETE_NOENT');
    };
    const db = open(path);
    expect(raced).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });
});

describe('SG90 switching an empty file to WAL (pinned)', () => {
  function emptyFile(): string {
    const path = join(tmp(), 'index.db');
    writeFileSync(path, '');
    return path;
  }

  it.each(['SQLITE_BUSY', 'SQLITE_IOERR_DELETE_NOENT'])(
    'W03–W05, W08–W10: an empty file whose switch fails with %s for 200 ms is retried about every 10 ms, then opened',
    (code) => {
      const path = emptyFile();
      const until = Date.now() + 200;
      let tries = 0;
      hook.wal = (p) => {
        if (p !== path || Date.now() >= until) return;
        tries++;
        throw busyError(code);
      };
      const t0 = Date.now();
      const db = open(path);
      expect(Date.now() - t0).toBeLessThan(600);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(tries).toBeGreaterThanOrEqual(5);
      expect(tries).toBeLessThanOrEqual(60);
    },
  );

  it('W07: an empty file refused for good fails after the busy timeout, naming `journal mode`', () => {
    const path = emptyFile();
    let tries = 0;
    hook.wal = (p) => {
      if (p !== path) return;
      if (++tries > 2000) throw new Error('runaway retry loop');
      throw busyError();
    };
    fastClock(100);
    expect(() => openDatabase(path)).toThrow(`journal mode: database is locked${REMEDY}`);
    vi.restoreAllMocks();
    expect(tries).toBeGreaterThanOrEqual(10);
    expect(tries).toBeLessThanOrEqual(60);
  });

  it('W06: a refused switch of a file that is not empty is not retried', () => {
    const path = join(tmp(), 'index.db');
    const other = new Database(path);
    other.exec('CREATE TABLE t (x)');
    other.close();
    let tries = 0;
    hook.wal = (p) => {
      if (p !== path) return;
      tries++;
      throw busyError();
    };
    expect(() => openDatabase(path)).toThrow(`journal mode: database is locked${REMEDY}`);
    expect(tries).toBe(1);
  });
});

describe('SG80 `immediate` retry loop (pinned)', () => {
  /** A connection whose `BEGIN IMMEDIATE` throws `begin(n)` on the n-th try, when defined. */
  function stub(begin: (n: number) => unknown, inTransaction = false) {
    const pragmas: string[] = [];
    let begins = 0;
    let runs = 0;
    const db = {
      inTransaction,
      pragma: (sql: string) => void pragmas.push(sql),
      transaction: (fn: () => unknown) =>
        Object.assign(() => (runs++, fn()), {
          immediate: () => {
            const err = begin(++begins);
            if (err) throw err;
            runs++;
            return fn();
          },
        }),
    } as unknown as DB;
    return { db, pragmas, begins: () => begins, runs: () => runs };
  }

  it('I02, I03, I10: lowers busy_timeout to 10 ms while it polls and restores 5000 ms', () => {
    const ok = stub((n) => (n < 3 ? busyError() : undefined));
    expect(immediate(ok.db, () => 'done')).toBe('done');
    expect(ok.begins()).toBe(3);
    expect(ok.pragmas).toEqual(['busy_timeout = 10', 'busy_timeout = 5000']);

    const failing = stub(() => new Error('disk I/O error'));
    expect(() => immediate(failing.db, () => 'never')).toThrow('disk I/O error');
    expect(failing.pragmas).toEqual(['busy_timeout = 10', 'busy_timeout = 5000']);
  });

  it('I05: an error other than SQLITE_BUSY from BEGIN is thrown at once, not retried', () => {
    const err = Object.assign(new Error('attempt to write a readonly database'), {
      code: 'SQLITE_READONLY',
    });
    const s = stub((n) => (n > 100 ? new Error('runaway retry loop') : err));
    expect(() => immediate(s.db, () => 'never')).toThrow(err);
    expect(s.begins()).toBe(1);
    expect(s.runs()).toBe(0);
  });

  it('I06, I07: SQLITE_BUSY from BEGIN is retried until the 5 s busy timeout, then thrown', () => {
    const s = stub((n) => (n > 1000 ? new Error('runaway retry loop') : busyError()));
    fastClock(100); // each try costs 100 ms of the deadline
    expect(() => immediate(s.db, () => 'never')).toThrow('database is locked');
    vi.restoreAllMocks();
    expect(s.begins()).toBeGreaterThanOrEqual(20);
    expect(s.begins()).toBeLessThanOrEqual(50);
    expect(s.runs()).toBe(0);
  });

  it('I11, I12: inside another transaction it runs `fn` in a savepoint and leaves busy_timeout alone', () => {
    const s = stub(() => new Error('BEGIN inside a transaction'), true);
    expect(immediate(s.db, () => 'nested')).toBe('nested');
    expect(s.begins()).toBe(0);
    expect(s.runs()).toBe(1);
    expect(s.pragmas).toEqual([]);
  });
});

describe('SG80 every index-run and doc write takes the write lock up front (pinned)', () => {
  /** A connection to the migrated index at `path` that records every statement it runs. */
  function traced(path: string): { db: DB; log: string[] } {
    closeDatabase(openDatabase(path));
    const log: string[] = [];
    const db = new Database(path, { timeout: 5000, verbose: (s) => log.push(String(s)) });
    sqliteVec.load(db);
    db.pragma('foreign_keys = ON');
    cleanup.push(() => db.open && db.close());
    return { db, log };
  }

  /** Write statements in `log` that ran outside a `BEGIN IMMEDIATE` transaction. */
  function unlockedWrites(log: string[]): string[] {
    let tx: 'none' | 'immediate' | 'deferred' = 'none';
    const bad: string[] = [];
    for (const raw of log) {
      const sql = raw.trim();
      if (/^BEGIN IMMEDIATE\b/i.test(sql)) tx = 'immediate';
      else if (/^BEGIN\b/i.test(sql)) tx = 'deferred';
      else if (/^(COMMIT|END)\b/i.test(sql) || /^ROLLBACK\s*$/i.test(sql)) tx = 'none';
      else if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) && tx !== 'immediate') {
        bad.push(`${tx}: ${sql.slice(0, 70)}`);
      }
    }
    return bad;
  }

  it('X01–X07: start stamp, per-file writes, retry blanking, prune, resolve, embeddings and finish stamp', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.ts'), 'export function f() {}\n');
    writeFileSync(join(dir, 'b.ts'), "import { f } from './a';\nexport function g() { f(); }\n");
    writeFileSync(join(dir, 'c.ts'), "import { g } from './b';\nexport function h() { g(); }\n");
    writeFileSync(join(dir, 'd.ts'), 'export function k() {}\n');
    const path = join(dir, '.atlas', 'index.db');
    const first = openDatabase(path);
    await indexRepo(first, dir);
    // The next run is an extractor upgrade (every file re-parsed), `d.ts` fails to parse (so its
    // hash is blanked for a retry) and `c.ts` is gone (pruned).
    first
      .prepare("UPDATE runs SET stats_json = json_set(stats_json, '$.state.extractorVersion', 0)")
      .run();
    closeDatabase(first);
    rmSync(join(dir, 'c.ts'));
    hook.parseFail.add('d.ts');

    const { db, log } = traced(path);
    const stats = await indexRepo(db, dir);
    expect(stats.filesFailed).toBe(1);
    expect(stats.filesRemoved).toBe(1);
    expect(stats.embeddings).toBeGreaterThan(0);
    const ran = (re: RegExp): boolean => log.some((s) => re.test(s));
    expect(ran(/^INSERT INTO runs/)).toBe(true);
    expect(ran(/^INSERT INTO symbols/)).toBe(true);
    expect(ran(/^UPDATE files SET content_hash = ''/)).toBe(true);
    expect(ran(/^DELETE FROM files/)).toBe(true);
    expect(ran(/^DELETE FROM edges/)).toBe(true);
    expect(ran(/^INSERT INTO embeddings_vec/)).toBe(true);
    expect(ran(/^UPDATE runs SET finished_at/)).toBe(true);
    expect(unlockedWrites(log)).toEqual([]);
  });

  it('X08–X11: `upsertDoc` (insert and update) and `deleteFile` called on their own', () => {
    const { db, log } = traced(join(tmp(), 'index.db'));
    const id = upsertFile(db, { path: 'a.ts', language: 'typescript', content_hash: 'h', loc: 1 });
    log.length = 0;
    upsertDoc(db, { target_kind: 'file', target_id: id, content: 'one', source_hash: 'h1' });
    upsertDoc(db, { target_kind: 'file', target_id: id, content: 'two', source_hash: 'h2' });
    deleteFile(db, id);
    expect(getDoc(db, 'file', id)).toBeUndefined();
    expect(log.filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s))).toHaveLength(4);
    expect(unlockedWrites(log)).toEqual([]);
  });
});

describe('SG80 naming `SQLITE_BUSY` (pinned)', () => {
  it('N01: an error passed through two steps keeps the first name and one remedy', () => {
    const err = busyError();
    nameBusy(err, 'index write');
    nameBusy(err, 'run stamp');
    expect(err.message).toBe(`index write: database is locked${REMEDY}`);
  });

  it('N04: `atlas docs` importing `.atlas/docs` into a fresh index names a busy write `docs write`', async () => {
    const dir = tmp();
    cpSync(join(ROOT, 'fixtures/sample/src'), join(dir, 'src'), { recursive: true });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', dir]);
    await runCli(['docs', '--offline', '--cwd', dir]);
    // A fresh index beside the committed docs: the next `docs` first imports them.
    const path = join(dir, '.atlas', 'index.db');
    for (const f of ['', '-wal', '-shm']) rmSync(path + f, { force: true });
    await runCli(['index', dir]);
    const holder = await lockHolder(path);
    try {
      holder.hold(6000);
      const t0 = Date.now();
      await expect(runCli(['docs', '--offline', '--cwd', dir])).rejects.toThrow(
        `docs write: database is locked${REMEDY}`,
      );
      expect(Date.now() - t0).toBeGreaterThan(4900);
    } finally {
      out.mockRestore();
      await holder.close();
    }
  }, 30_000);
});
