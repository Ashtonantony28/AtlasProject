// AUDIT-38: test coverage, round 9 (SG130, SG135, SG140, SG150 in `openDatabase`'s leftover-WAL
// check). Plain `it` tests pin behaviour that is correct today but that a surviving mutation showed
// no other test checks (the mutant IDs are in each test name; AUDIT-38.md has the diffs).
//
// They run in-process, so coverage sees them, and they are deterministic: the decision under test
// is driven by hooks rather than by a real failing disk.
// - `hook.integrity(name, n)` answers the check connection's `integrity_check` (call `n` of this
//   test) when it returns a string;
// - `hook.read(path)` runs before `readSync` (it may throw, or return a byte count);
// - `hook.locks(real)` rewrites what `readFileSync('/proc/locks')` returns (it may throw);
// - `hook.dev(path)` replaces `st_dev` in a bigint `statSync`;
// - `hook.link(path)` and `hook.rename(from)` run before `linkSync` and `renameSync`;
// - `hook.open(name)` runs before a connection is opened, `hook.exec(name, sql)` before `exec`.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { SAMPLE } from '../cli/helpers.js';

const hook = vi.hoisted(() => ({
  integrity: undefined as ((name: string, n: number) => string | undefined) | undefined,
  checks: 0,
  read: undefined as ((path: string) => number | undefined) | undefined,
  locks: undefined as ((real: string) => string) | undefined,
  dev: undefined as ((path: string) => bigint | undefined) | undefined,
  link: undefined as ((path: string) => void) | undefined,
  rename: undefined as ((from: string) => void) | undefined,
  open: undefined as ((name: string) => void) | undefined,
  exec: undefined as ((name: string, sql: string) => void) | undefined,
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default;
  class Hooked extends Real {
    constructor(name: string, options?: Database.Options) {
      hook.open?.(name);
      super(name, options);
    }
    pragma(source: string, options?: Database.PragmaOptions): unknown {
      if (source.startsWith('integrity_check') && hook.integrity) {
        const r = hook.integrity(this.name, hook.checks++);
        if (r !== undefined) return r;
      }
      return super.pragma(source, options);
    }
    exec(source: string): this {
      hook.exec?.(this.name, source);
      return super.exec(source);
    }
  }
  return { default: Hooked };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const fdPath = (fd: number): string => {
    try {
      return real.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return '';
    }
  };
  const readSync = ((fd: number, ...rest: unknown[]) => {
    const n = hook.read?.(fdPath(fd));
    if (n !== undefined) return n;
    return (real.readSync as (...a: unknown[]) => number)(fd, ...rest);
  }) as typeof real.readSync;
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const out = real.readFileSync(...args);
    return args[0] === '/proc/locks' && hook.locks ? hook.locks(String(out)) : out;
  }) as typeof real.readFileSync;
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    const st = real.statSync(...args);
    const dev = st && typeof st.dev === 'bigint' ? hook.dev?.(String(args[0])) : undefined;
    return dev === undefined ? st : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev });
  }) as typeof real.statSync;
  const linkSync = ((...args: Parameters<typeof real.linkSync>) => {
    hook.link?.(String(args[1]));
    return real.linkSync(...args);
  }) as typeof real.linkSync;
  const renameSync = ((...args: Parameters<typeof real.renameSync>) => {
    hook.rename?.(String(args[0]));
    return real.renameSync(...args);
  }) as typeof real.renameSync;
  const fns = { readSync, readFileSync, statSync, linkSync, renameSync };
  return { ...real, ...fns, default: { ...real, ...fns } };
});

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
let stderr: string[] = [];

afterEach(() => {
  Object.assign(hook, {
    integrity: undefined,
    checks: 0,
    read: undefined,
    locks: undefined,
    dev: undefined,
    link: undefined,
    rename: undefined,
    open: undefined,
    exec: undefined,
  });
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit38-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');
const aside = (root: string): string[] =>
  readdirSync(join(root, '.atlas')).filter((f) => f.includes('.foreign-'));

// The sample indexed by the CLI once (closed: no `-wal`), and the same with one more function.
let sample = '';
let replacement = '';
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'atlas-audit38-base-'));
  dirs.push(base);
  const index = (root: string, extra?: string): string => {
    cpSync(SAMPLE, root, { recursive: true });
    if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
    const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'index', root], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
    return root;
  };
  sample = index(join(base, 'sample'));
  replacement = index(join(base, 'replacement'), REPLACEMENT_FN);
  dirs.splice(dirs.indexOf(base), 1);
  return () => rmSync(base, { recursive: true, force: true });
}, 60_000);

/** A fresh copy of an indexed project. */
function copyOf(src: string): string {
  const root = join(tmp(), 'repo');
  cpSync(src, root, { recursive: true });
  return root;
}

const KILLED_RUN = "UPDATE symbols SET docstring = 'STALE-WAL-' || id";

/** A committed write SIGKILLed before any checkpoint: its WAL and -shm stay beside `dbPath`. */
function killedWriter(dbPath: string, sql = KILLED_RUN): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec(${JSON.stringify(sql)});
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
  expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(32);
}

/** A process that commits a write and keeps the index open (a live `atlas mcp`/`atlas serve`). */
async function liveWriter(dbPath: string): Promise<ChildProcess> {
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${BSQ});
       const db = new D(${JSON.stringify(dbPath)});
       db.exec("UPDATE symbols SET docstring = 'LIVE-' || id");
       process.stdout.write('written\\n');
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cleanup.push(() => void holder.kill('SIGKILL'));
  await new Promise<void>((ok) => holder.stdout!.once('data', () => ok()));
  return holder;
}

/** The project's index with a killed writer's own WAL beside it. */
function ownWal(): string {
  const root = copyOf(sample);
  killedWriter(dbOf(root));
  return root;
}

/** The project's index replaced (in place) by another checkout's, beside a killed writer's WAL. */
function foreignWal(): string {
  const root = copyOf(sample);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(replacement), dbOf(root));
  return root;
}

/** Opens the index in-process (as every surface does), capturing stderr. */
function open(root: string, readonly = false): DB {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
  const db = openDatabase(dbOf(root), { readonly });
  cleanup.push(() => db.open && closeDatabase(db));
  vi.mocked(process.stderr.write).mockRestore();
  return db;
}

const stale = (db: DB): number =>
  (
    db.prepare("SELECT count(*) AS n FROM symbols WHERE docstring LIKE 'STALE-WAL-%'").get() as {
      n: number;
    }
  ).n;
const replaced = (db: DB): number =>
  (db.prepare("SELECT count(*) AS n FROM symbols WHERE name = 'replacementOnlyFn'").get() as { n: number })
    .n;

/** The check of the leftover WAL (its hard link) answers `rows[n]` on its n-th run. */
const checkSays =
  (...rows: (string | undefined)[]) =>
  (name: string, n: number): string | undefined =>
    name.endsWith('.check') ? rows[n] : undefined;

/** An own WAL is kept and refused with the cause: nothing set aside, and its rows come back. */
function expectKeptAndRefused(root: string, cause: RegExp): void {
  expect(() => open(root)).toThrow(cause);
  expect(aside(root)).toEqual([]);
  expect(statSync(`${dbOf(root)}-wal`).size).toBeGreaterThan(32);
  hook.integrity = undefined;
  hook.read = undefined;
  expect(stale(open(root))).toBeGreaterThan(0);
}

const readShm = (p: string): Buffer => Buffer.from(readFileSync(p));
const writeShm = (p: string, b: Buffer): void => writeFileSync(p, b);

const IOERR_ROW = 'Tree 37 page 37: unable to get the page. error code=8458';
const CANNOT_CHECK = /cannot check .*index\.db-wal, left by a process that stopped \(.*\); it is kept/;

describe('SG150 the two checks and the result rows (pinned)', () => {
  it('I08: a result row with an I/O error code, the same in both checks, keeps the WAL and names the row', () => {
    // What a persistent bad sector in index.db gives (AUDIT-36: `error code=8458`, i.e.
    // SQLITE_IOERR_CORRUPTFS). Without the error-code test the two checks agree and the WAL goes.
    const root = ownWal();
    hook.integrity = checkSays(IOERR_ROW, IOERR_ROW);
    expectKeptAndRefused(root, /a page could not be read: Tree 37 page 37: unable to get the page\. error code=8458/);
  }, 30_000);

  it('I07: two checks that disagree keep the WAL', () => {
    // An intermittent error (a soft NFS mount, a flaky USB link) fails a different page each time.
    const root = ownWal();
    hook.integrity = checkSays(
      'Tree 29 page 29 cell 0: failed to get page 70',
      'Tree 31 page 31 cell 2: failed to get page 88',
    );
    expectKeptAndRefused(root, /cannot check .*a page could not be read: Tree 29 page 29/);
  }, 30_000);

  it('I05, I06, I13: a first check spoilt by a transient error and a clean second one keep the WAL and open', () => {
    const root = ownWal();
    hook.integrity = checkSays('Tree 29 page 29 cell 0: failed to get page 70');
    const db = open(root);
    expect(stderr.join('')).toBe('');
    expect(aside(root)).toEqual([]);
    expect(stale(db)).toBe(24);
    // The check's hard links (`index.db.<pid>.<ms>.check`, `-wal`, `-shm`) are gone.
    expect(readdirSync(join(root, '.atlas')).filter((f) => f.includes('.check'))).toEqual([]);
  }, 30_000);

  it('I08, I09: a row whose error code is SQLITE_CORRUPT (or an extended one) is corruption: a foreign WAL is set aside', () => {
    for (const code of [11, 267, 779]) {
      const root = foreignWal();
      const row = `Tree 5 page 5: unable to get the page. error code=${code}`;
      hook.checks = 0;
      hook.integrity = checkSays(row, row);
      const db = open(root);
      expect(stderr.join(''), `code ${code}`).toMatch(/does not belong to .*; moved it to/);
      expect(aside(root)).toHaveLength(1);
      expect(replaced(db)).toBe(1);
      expect(stale(db)).toBe(0);
    }
  }, 60_000);

  it('I03: an EIO reading index.db between the checks keeps the WAL, even when both checks agree', () => {
    // A bad sector that the check meets the same way twice (the schema pages: SQLite throws
    // SQLITE_CORRUPT both times) is told apart from corruption only by the plain read.
    const root = ownWal();
    const row = 'SQLITE_CORRUPT: database disk image is malformed';
    hook.integrity = checkSays(row, row);
    hook.read = (p) => {
      if (p.endsWith('.check')) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return undefined;
    };
    expectKeptAndRefused(root, /cannot check .*index\.db-wal.*\(EIO: i\/o error, read\); it is kept/);
  }, 30_000);

  it('I04: an EIO reading the WAL between the checks keeps the WAL', () => {
    const root = ownWal();
    const row = '*** in database main ***\nPage 12: never used';
    hook.integrity = checkSays(row, row);
    hook.read = (p) => {
      if (p.endsWith('.check-wal')) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return undefined;
    };
    expectKeptAndRefused(root, CANNOT_CHECK);
  }, 30_000);

  it('A01: a short read (0 bytes before the end) between the checks keeps the WAL', () => {
    const root = ownWal();
    const row = '*** in database main ***\nPage 12: never used';
    hook.integrity = checkSays(row, row);
    hook.read = (p) => (p.endsWith('.check') ? 0 : undefined);
    expectKeptAndRefused(root, /cannot check .*\(short read of .*\.check at byte 0 of \d+\); it is kept/);
  }, 30_000);
});

describe('SG130/SG135 decisions without a product test (pinned)', () => {
  it('S02: a foreign WAL that cannot be renamed aside is refused, never replayed', () => {
    const root = foreignWal();
    hook.rename = (from) => {
      if (from.endsWith('index.db-wal')) {
        throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
      }
    };
    expect(() => open(root)).toThrow(/is unreadable \(database disk image is malformed\)/);
    expect(aside(root)).toEqual([]);
    expect(statSync(`${dbOf(root)}-wal`).size).toBeGreaterThan(32);
  }, 30_000);

  it('T01: once the index has a WAL of its own, the set-aside WAL is no longer offered back', () => {
    const root = foreignWal();
    closeDatabase(open(root, true));
    expect(aside(root)).toHaveLength(1);
    // Still as it was: offered back.
    closeDatabase(open(root, true));
    expect(stderr.join('')).toMatch(/move it back to .*index\.db-wal before anything writes/);
    // A writer commits and is killed: index.db's size and mtime are unchanged (the commit is in
    // its new WAL), but moving the old WAL back now would overwrite that commit.
    const st = statSync(dbOf(root), { bigint: true });
    killedWriter(dbOf(root), "UPDATE symbols SET docstring = 'NEW-' || id");
    expect(statSync(dbOf(root), { bigint: true })).toMatchObject({ size: st.size, mtimeNs: st.mtimeNs });
    const db = open(root);
    expect(stderr.join('')).not.toMatch(/move it back/);
    expect(stderr.join('')).toMatch(/may have been written since: moving it back would corrupt/);
    expect(
      (db.prepare("SELECT count(*) AS n FROM symbols WHERE docstring LIKE 'NEW-%'").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  }, 30_000);

  it('H04: /proc/locks minors above 255 are decoded: a live writer on a renamed-over index is refused by name', async () => {
    // Anonymous devices (tmpfs, overlayfs, FUSE) get minors past 255 on hosts with many mounts
    // (AUDIT-36: `0:341`, printed `00:155` in /proc/locks). Here the index's device is made to
    // read as 0:341 in both places.
    const root = copyOf(sample);
    await liveWriter(dbOf(root));
    const wal = `${dbOf(root)}-wal`;
    const ino = statSync(wal).ino;
    renameSync(dbOf(copyOf(replacement)), dbOf(root));
    const dev = statSync(root).dev;
    const real = `${(dev >> 8).toString(16).padStart(2, '0')}:${(dev & 0xff).toString(16).padStart(2, '0')}:`;
    const inodes = new Set(
      [dbOf(root), wal, `${dbOf(root)}-shm`].map((f) => String(statSync(f).ino)),
    );
    hook.locks = (table) =>
      table.replace(/ ([0-9a-f]+:[0-9a-f]+:)(\d+) /g, (m, d: string, i: string) =>
        d === real && inodes.has(i) ? ` 00:155:${i} ` : m,
      );
    // glibc's encoding of makedev(0, 341).
    hook.dev = (p) => (p.startsWith(root) ? 0x100055n : undefined);
    expect(() => open(root)).toThrow(/another process still has the replaced index open/);
    expect(statSync(wal).ino).toBe(ino);
    expect(aside(root)).toEqual([]);
  }, 30_000);

  it('P01: without /proc/locks, a probe that cannot run counts as a holder: a live writer’s WAL is not set aside', async () => {
    // No /proc/locks (macOS, BSD, a sandbox) and no hard links for the probe (FAT/exFAT, some
    // FUSE and SMB mounts): the live writer of a renamed-over index must keep its WAL.
    const root = copyOf(sample);
    await liveWriter(dbOf(root));
    const wal = `${dbOf(root)}-wal`;
    const ino = statSync(wal).ino;
    renameSync(dbOf(copyOf(replacement)), dbOf(root));
    hook.locks = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    hook.link = (to) => {
      if (to.endsWith('.probe')) throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
    };
    expect(() => open(root)).toThrow(/is unreadable \(database disk image is malformed\)/);
    expect(statSync(wal).ino).toBe(ino);
    expect(aside(root)).toEqual([]);
  }, 30_000);

  it('K04: an open lock that cannot be created (a read-only directory) still lets a reader open beside its own WAL', () => {
    const root = ownWal();
    hook.open = (name) => {
      if (name.endsWith('.open.lock')) {
        throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
      }
    };
    expect(stale(open(root))).toBe(24);
    expect(aside(root)).toEqual([]);
  }, 30_000);

  it('K02, K05: the open lock refuses only when another opener holds it; any other error proceeds unlocked', () => {
    const root = ownWal();
    hook.exec = (name, sql) => {
      if (name.endsWith('.open.lock') && sql === 'BEGIN EXCLUSIVE') {
        throw Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY' });
      }
    };
    expect(stale(open(root))).toBe(24);
    hook.exec = (name, sql) => {
      if (name.endsWith('.open.lock') && sql === 'BEGIN EXCLUSIVE') {
        throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
      }
    };
    const again = copyOf(sample);
    killedWriter(dbOf(again));
    expect(() => open(again)).toThrow(
      'open: database is locked (another process is writing the index; retry when it finishes)',
    );
  }, 30_000);
});

/** Whether another process can take `<db>.open.lock` right now (no wait). */
function lockFree(dbPath: string): boolean {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const l = new D(${JSON.stringify(`${dbPath}.open.lock`)}, { timeout: 0 });
     try { l.exec('BEGIN EXCLUSIVE'); process.stdout.write('free'); }
     catch (e) { process.stdout.write(e.code); }`,
  ]);
  return String(r.stdout) === 'free';
}

describe('SG135 the open lock (pinned)', () => {
  it('K01, K03, C03: other openers are locked out from the check until the index is open', () => {
    const root = ownWal();
    const path = dbOf(root);
    const seenLock: string[] = [];
    hook.integrity = (name) => {
      if (name.endsWith('.check')) seenLock.push(`check:${lockFree(path) ? 'free' : 'held'}`);
      return undefined;
    };
    hook.open = (name) => {
      if (name === path) seenLock.push(`open:${lockFree(path) ? 'free' : 'held'}`);
    };
    expect(stale(open(root))).toBe(24);
    expect(seenLock).toEqual(['check:held', 'open:held']);
    expect(lockFree(path)).toBe(true);
  }, 30_000);
});

describe('SG130 the -shm decides whether a WAL may be set aside (pinned)', () => {
  // A WAL that fails the check is set aside only when its -shm describes this WAL (same salts),
  // has frames, and says no checkpoint of it ever started. Anything else is refused: the index
  // may already hold some of the WAL's pages, so removing the WAL could leave it torn.
  const shmCases: [string, (shm: Buffer) => void][] = [
    ['N01 salts of another WAL', (shm) => void (shm[32] = shm[32]! ^ 1)],
    ['N02 no frames', (shm) => shm.writeUInt32LE(0, 16)],
    ['N03 nBackfill set', (shm) => shm.writeUInt32LE(1, 96)],
    ['N04 nBackfillAttempted set', (shm) => shm.writeUInt32LE(1, 128)],
  ];
  for (const [label, patch] of shmCases) {
    it(`${label}: a WAL that fails the check is refused, not set aside`, () => {
      const root = foreignWal();
      const shmPath = `${dbOf(root)}-shm`;
      const shm = readShm(shmPath);
      patch(shm);
      writeShm(shmPath, shm);
      expect(() => open(root)).toThrow(/is unreadable \(database disk image is malformed\)/);
      expect(aside(root)).toEqual([]);
    }, 30_000);
  }

  it('N05: a WAL with no -shm that fails the check is refused, not set aside', () => {
    const root = foreignWal();
    rmSync(`${dbOf(root)}-shm`);
    // The check (on hard links) gives the same verdict with or without the -shm.
    hook.integrity = checkSays('*** in database main ***\nPage 12: never used', '*** in database main ***\nPage 12: never used');
    expect(() => open(root)).toThrow(/is unreadable \(database disk image is malformed\)/);
    expect(aside(root)).toEqual([]);
  }, 30_000);
});
