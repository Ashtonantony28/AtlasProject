// SG130–SG150 (moved from AUDIT-38 by SG160): `openDatabase`'s check of a WAL left beside the index.
// An own WAL is kept; a foreign one is set aside and reported; anything the check cannot decide is
// refused with the WAL left in place. Runs in-process: failing disks, `/proc/locks` and the open
// lock are driven through `hook` (see the mocks below), so no `cc` or privileges are needed.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { SAMPLE } from '../cli/helpers.js';

const hook = vi.hoisted(() => ({
  /** Answers the check connection's `n`-th `integrity_check` of this test when it returns a string. */
  integrity: undefined as ((name: string, n: number) => string | undefined) | undefined,
  checks: 0,
  /** Runs before `readSync`: may throw, or return a byte count. */
  read: undefined as ((path: string) => number | undefined) | undefined,
  /** Rewrites what `readFileSync('/proc/locks')` returns (may throw). */
  locks: undefined as ((real: string) => string) | undefined,
  /** Replaces `st_dev` in a bigint `statSync`. */
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
    return dev === undefined
      ? st
      : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev });
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
  const d = mkdtempSync(join(tmpdir(), 'atlas-leftover-wal-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');
const aside = (root: string): string[] =>
  readdirSync(join(root, '.atlas')).filter((f) => f.includes('.foreign-'));

// The sample indexed by the CLI (closed: no `-wal`), and the same with one more function.
let sample = '';
let replacement = '';
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'atlas-leftover-wal-base-'));
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
  return () => rmSync(base, { recursive: true, force: true });
}, 60_000);

function copyOf(src: string): string {
  const root = join(tmp(), 'repo');
  cpSync(src, root, { recursive: true });
  return root;
}

const KILLED_RUN = "UPDATE symbols SET docstring = 'STALE-WAL-' || id";

/** A committed write SIGKILLed before any checkpoint: its WAL and `-shm` stay beside `dbPath`. */
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

/** The project's index replaced in place by another checkout's, beside a killed writer's WAL. */
function foreignWal(): string {
  const root = copyOf(sample);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(replacement), dbOf(root));
  return root;
}

/** A live writer's index renamed over by another checkout's: the writer still holds the old one. */
async function renamedOver(): Promise<{ root: string; wal: string; ino: number }> {
  const root = copyOf(sample);
  await liveWriter(dbOf(root));
  const wal = `${dbOf(root)}-wal`;
  const ino = statSync(wal).ino;
  renameSync(dbOf(copyOf(replacement)), dbOf(root));
  return { root, wal, ino };
}

/** Opens the index in-process (as every surface does), capturing stderr. */
function open(root: string, readonly = false, path = dbOf(root)): DB {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
  try {
    const db = openDatabase(path, { readonly });
    cleanup.push(() => db.open && closeDatabase(db));
    return db;
  } finally {
    vi.mocked(process.stderr.write).mockRestore();
  }
}

const count = (db: DB, where: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM symbols WHERE ${where}`).get() as { n: number }).n;
const stale = (db: DB): number => count(db, "docstring LIKE 'STALE-WAL-%'");
const replaced = (db: DB): number => count(db, "name = 'replacementOnlyFn'");

/** The check of the leftover WAL (its hard link) answers `rows[n]` on its n-th run. */
const checkSays =
  (...rows: (string | undefined)[]) =>
  (name: string, n: number): string | undefined =>
    name.endsWith('.check') ? rows[n] : undefined;

const ioError = (msg: string, code: string): Error => Object.assign(new Error(msg), { code });

/** An own WAL is kept and refused with the cause: nothing set aside, and its rows come back. */
function expectKeptAndRefused(root: string, cause: RegExp | string): void {
  expect(() => open(root)).toThrow(cause);
  expect(aside(root)).toEqual([]);
  expect(statSync(`${dbOf(root)}-wal`).size).toBeGreaterThan(32);
  hook.integrity = undefined;
  hook.read = undefined;
  hook.open = undefined;
  expect(stale(open(root))).toBe(24);
}

const MALFORMED = /is unreadable \(database disk image is malformed\)/;
const IOERR_ROW = 'Tree 37 page 37: unable to get the page. error code=8458';
const UNUSED_ROW = '*** in database main ***\nPage 12: never used';
const CANNOT_CHECK =
  /cannot check .*index\.db-wal, left by a process that stopped \(.*\); it is kept/;

describe('an own WAL is kept and replayed', () => {
  it('in place', () => {
    const root = ownWal();
    const db = open(root);
    expect(stale(db)).toBe(24);
    expect(stderr.join('')).toBe('');
    expect(aside(root)).toEqual([]);
    expect(readdirSync(join(root, '.atlas')).filter((f) => f.includes('.check'))).toEqual([]);
  });

  it('copied or moved with its index', () => {
    const copied = copyOf(ownWal());
    expect(stale(open(copied))).toBe(24);
    const moved = join(tmp(), 'moved');
    renameSync(ownWal(), moved);
    expect(stale(open(moved))).toBe(24);
    expect([...aside(copied), ...aside(moved)]).toEqual([]);
  });

  it('beside the target of a symlinked index', () => {
    const target = ownWal();
    const root = join(tmp(), 'linked');
    mkdirSync(join(root, '.atlas'), { recursive: true });
    symlinkSync(dbOf(target), dbOf(root));
    expect(stale(open(root))).toBe(24);
    expect(aside(target)).toEqual([]);
  });
});

describe('a foreign WAL', () => {
  it('is set aside, reported, and offered back until the index is written', () => {
    const root = foreignWal();
    const db = open(root);
    expect(stderr.join('')).toMatch(
      /index\.db-wal does not belong to .*index\.db; moved it to .*-wal\.foreign-/,
    );
    expect(aside(root)).toHaveLength(1);
    expect(replaced(db)).toBe(1);
    expect(stale(db)).toBe(0);
    closeDatabase(db);
    closeDatabase(open(root, true));
    expect(stderr.join('')).toMatch(/move it back to .*index\.db-wal before anything writes/);
  });

  it('is withdrawn from the move-back once the index has a WAL of its own', () => {
    const root = foreignWal();
    closeDatabase(open(root, true));
    expect(aside(root)).toHaveLength(1);
    // A writer commits and is killed: index.db's size and mtime are unchanged (the commit is in
    // its new WAL), but moving the old WAL back now would overwrite that commit.
    const st = statSync(dbOf(root), { bigint: true });
    killedWriter(dbOf(root), "UPDATE symbols SET docstring = 'NEW-' || id");
    expect(statSync(dbOf(root), { bigint: true })).toMatchObject({
      size: st.size,
      mtimeNs: st.mtimeNs,
    });
    const db = open(root);
    expect(stderr.join('')).not.toMatch(/move it back/);
    expect(stderr.join('')).toMatch(/may have been written since: moving it back would corrupt/);
    expect(count(db, "docstring LIKE 'NEW-%'")).toBeGreaterThan(0);
  });

  it('that cannot be renamed aside is refused, never replayed', () => {
    const root = foreignWal();
    hook.rename = (from) => {
      if (from.endsWith('index.db-wal'))
        throw ioError('EACCES: permission denied, rename', 'EACCES');
    };
    expect(() => open(root)).toThrow(MALFORMED);
    expect(aside(root)).toEqual([]);
    expect(statSync(`${dbOf(root)}-wal`).size).toBeGreaterThan(32);
  });

  it('with a row error code of SQLITE_CORRUPT (or an extended one) in both checks is set aside', () => {
    for (const code of [11, 267, 779]) {
      const root = foreignWal();
      const row = `Tree 5 page 5: unable to get the page. error code=${code}`;
      hook.checks = 0;
      hook.integrity = checkSays(row, row);
      const db = open(root);
      expect(stderr.join(''), `code ${code}`).toMatch(/does not belong to .*; moved it to/);
      expect(aside(root)).toHaveLength(1);
      expect(replaced(db)).toBe(1);
    }
  });
});

/** A foreign WAL set aside by an open that is closed again: the move-back is on offer. */
function setAside(): string {
  const root = foreignWal();
  closeDatabase(open(root));
  expect(aside(root)).toHaveLength(1);
  return root;
}

const HAS_OPEN =
  /which a running Atlas process has open: stop every Atlas process on the project \(`atlas serve`, `atlas mcp`\) first, then run any `atlas` command to see what to do with it/;

describe('a set-aside WAL while an Atlas process has the index open (SG190)', () => {
  it('held by a writable connection (`atlas mcp`) is never offered back', () => {
    const root = setAside();
    open(root);
    open(root, true);
    expect(stderr.join('')).toMatch(HAS_OPEN);
    expect(stderr.join('')).not.toMatch(/move it back/);
  });

  it('held by a read-only connection that has not queried yet (`atlas serve`)', () => {
    const root = setAside();
    open(root, true);
    open(root, true);
    expect(stderr.join('')).toMatch(HAS_OPEN);
    expect(stderr.join('')).not.toMatch(/move it back/);
  });

  it('held by a connection found only by the probe (no /proc/locks)', () => {
    const root = setAside();
    open(root);
    hook.locks = () => {
      throw ioError('ENOENT: no such file or directory', 'ENOENT');
    };
    open(root, true);
    expect(stderr.join('')).toMatch(HAS_OPEN);
    expect(stderr.join('')).not.toMatch(/move it back/);
  });

  it('once every holder is closed, is offered back after stopping every Atlas process', () => {
    const root = setAside();
    closeDatabase(open(root));
    open(root, true);
    expect(stderr.join('')).toContain(
      `; if its writes belong there, stop every Atlas process on the project, then move it back to ${dbOf(root)}-wal before anything writes the index, otherwise delete it\n`,
    );
    expect(stderr.join('')).not.toMatch(/has open/);
  });

  it("an error from the read-only open's read is not lost: the first query names it", () => {
    const root = copyOf(sample);
    writeFileSync(dbOf(root), Buffer.alloc(statSync(dbOf(root)).size, 7));
    const db = open(root, true);
    expect(() => db.prepare('SELECT count(*) FROM files').get()).toThrow(/file is not a database/);
  });
});

describe('a WAL the check cannot decide is kept and the open refused', () => {
  it('when the check cannot run (full disk, I/O error)', () => {
    const FREE = 'free disk space (or fix the cause) and retry';
    const FIX = 'fix the cause and retry';
    for (const [code, msg, remedy] of [
      ['SQLITE_FULL', 'database or disk is full', FREE],
      ['SQLITE_IOERR_SHMSIZE', 'disk I/O error', FREE],
      ['SQLITE_IOERR_WRITE', 'disk I/O error', FREE],
      ['SQLITE_IOERR_READ', 'disk I/O error', FIX],
      ['SQLITE_IOERR_SHORT_READ', 'disk I/O error', FIX],
      ['SQLITE_IOERR', 'disk I/O error', FIX],
    ] as const) {
      const root = ownWal();
      hook.open = (name) => {
        if (name.endsWith('.check')) throw new Database.SqliteError(msg, code);
      };
      const db = dbOf(root);
      expectKeptAndRefused(
        root,
        `index ${db}: cannot check ${db}-wal, left by a process that stopped (${code}: ${msg}); it is kept: ${remedy}`,
      );
    }
  });

  it('when index.db cannot be read between the checks, even when both checks agree', () => {
    // A bad sector the check meets the same way twice (SQLite throws SQLITE_CORRUPT both times).
    const root = ownWal();
    const row = 'SQLITE_CORRUPT: database disk image is malformed';
    hook.integrity = checkSays(row, row);
    hook.read = (p) => {
      if (p.endsWith('.check')) throw ioError('EIO: i/o error, read', 'EIO');
      return undefined;
    };
    expectKeptAndRefused(
      root,
      /cannot check .*index\.db-wal.*\(EIO: i\/o error, read\); it is kept/,
    );
  });

  it('when the WAL cannot be read between the checks', () => {
    const root = ownWal();
    hook.integrity = checkSays(UNUSED_ROW, UNUSED_ROW);
    hook.read = (p) => {
      if (p.endsWith('.check-wal')) throw ioError('EIO: i/o error, read', 'EIO');
      return undefined;
    };
    expectKeptAndRefused(root, CANNOT_CHECK);
  });

  for (const [suffix, name] of [
    ['.check', 'index.db'],
    ['.check-wal', 'index.db-wal'],
  ] as const) {
    it(`on a short read of ${name} between the checks`, () => {
      const root = ownWal();
      hook.integrity = checkSays(UNUSED_ROW, UNUSED_ROW);
      hook.read = (p) => (p.endsWith(suffix) ? 0 : undefined);
      expectKeptAndRefused(
        root,
        new RegExp(
          `cannot check [^ ]*-wal, left by a process that stopped \\(short read of ${root}/\\.atlas/${name.replace('.', '\\.')} at byte 0 of \\d+\\); it is kept`,
        ),
      );
    });
  }

  it('when the two checks disagree', () => {
    // An intermittent error (a soft NFS mount, a flaky USB link) fails a different page each time.
    const root = ownWal();
    hook.integrity = checkSays(
      'Tree 29 page 29 cell 0: failed to get page 70',
      'Tree 31 page 31 cell 2: failed to get page 88',
    );
    expectKeptAndRefused(root, /cannot check .*a page could not be read: Tree 29 page 29/);
  });

  it('when a row carries an I/O error code, the same in both checks', () => {
    const root = ownWal();
    hook.integrity = checkSays(IOERR_ROW, IOERR_ROW);
    expectKeptAndRefused(
      root,
      /a page could not be read: Tree 37 page 37: unable to get the page\. error code=8458/,
    );
  });

  it('but a first check spoilt by a transient error and a clean second one open it', () => {
    const root = ownWal();
    hook.integrity = checkSays('Tree 29 page 29 cell 0: failed to get page 70');
    const db = open(root);
    expect(stderr.join('')).toBe('');
    expect(aside(root)).toEqual([]);
    expect(stale(db)).toBe(24);
    expect(readdirSync(join(root, '.atlas')).filter((f) => f.includes('.check'))).toEqual([]);
  });
});

describe('a WAL that fails the check is set aside only when its -shm says no checkpoint started', () => {
  const shmCases: [string, (shm: Buffer) => void][] = [
    ['salts of another WAL', (shm) => void (shm[32] = shm[32]! ^ 1)],
    ['no frames', (shm) => shm.writeUInt32LE(0, 16)],
    ['nBackfill set', (shm) => shm.writeUInt32LE(1, 96)],
    ['nBackfillAttempted set', (shm) => shm.writeUInt32LE(1, 128)],
  ];
  for (const [label, patch] of shmCases) {
    it(`refused: ${label}`, () => {
      const root = foreignWal();
      const shmPath = `${dbOf(root)}-shm`;
      const shm = Buffer.from(readFileSync(shmPath));
      patch(shm);
      writeFileSync(shmPath, shm);
      expect(() => open(root)).toThrow(MALFORMED);
      expect(aside(root)).toEqual([]);
    });
  }

  it('refused: no -shm', () => {
    const root = foreignWal();
    rmSync(`${dbOf(root)}-shm`);
    // The check (on hard links) gives the same verdict with or without the -shm.
    hook.integrity = checkSays(UNUSED_ROW, UNUSED_ROW);
    expect(() => open(root)).toThrow(MALFORMED);
    expect(aside(root)).toEqual([]);
  });
});

describe('a live writer keeps its WAL', () => {
  it('found by a probe without /proc/locks', async () => {
    const root = copyOf(sample);
    await liveWriter(dbOf(root));
    hook.locks = () => {
      throw ioError('ENOENT: no such file or directory', 'ENOENT');
    };
    expect(count(open(root), "docstring LIKE 'LIVE-%'")).toBe(24);
    expect(aside(root)).toEqual([]);
  });

  it('of a renamed-over index, found in /proc/locks with a minor over 255', async () => {
    // Anonymous devices (tmpfs, overlayfs, FUSE) get minors past 255 on hosts with many mounts:
    // the index's device is made to read as 0:341 (`00:155` in /proc/locks) in both places.
    const { root, wal, ino } = await renamedOver();
    const dev = statSync(root).dev;
    const real = `${(dev >> 8).toString(16).padStart(2, '0')}:${(dev & 0xff).toString(16).padStart(2, '0')}:`;
    const inodes = new Set(
      [dbOf(root), wal, `${dbOf(root)}-shm`].map((f) => String(statSync(f).ino)),
    );
    hook.locks = (table) =>
      table.replace(/ ([0-9a-f]+:[0-9a-f]+:)(\d+) /g, (m, d: string, i: string) =>
        d === real && inodes.has(i) ? ` 00:155:${i} ` : m,
      );
    hook.dev = (p) => (p.startsWith(root) ? 0x100055n : undefined);
    expect(() => open(root)).toThrow(/another process still has the replaced index open/);
    expect(statSync(wal).ino).toBe(ino);
    expect(aside(root)).toEqual([]);
  });

  it('of a renamed-over index, when neither /proc/locks nor a probe can tell', async () => {
    const { root, wal, ino } = await renamedOver();
    hook.locks = () => {
      throw ioError('ENOENT: no such file or directory', 'ENOENT');
    };
    hook.link = (to) => {
      if (to.endsWith('.probe')) throw ioError('EPERM: operation not permitted, link', 'EPERM');
    };
    expect(() => open(root)).toThrow(MALFORMED);
    expect(statSync(wal).ino).toBe(ino);
    expect(aside(root)).toEqual([]);
  });
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

describe('the open lock', () => {
  it('locks other openers out from the check until the index is open', () => {
    const root = ownWal();
    const path = dbOf(root);
    const seen: string[] = [];
    hook.integrity = (name) => {
      if (name.endsWith('.check')) seen.push(`check:${lockFree(path) ? 'free' : 'held'}`);
      return undefined;
    };
    hook.open = (name) => {
      if (name === path) seen.push(`open:${lockFree(path) ? 'free' : 'held'}`);
    };
    expect(stale(open(root))).toBe(24);
    expect(seen).toEqual(['check:held', 'open:held']);
    expect(lockFree(path)).toBe(true);
  });

  it('that cannot be created (a read-only directory) still lets a reader open beside its own WAL', () => {
    const root = ownWal();
    hook.open = (name) => {
      if (name.endsWith('.open.lock'))
        throw ioError('unable to open database file', 'SQLITE_CANTOPEN');
    };
    expect(stale(open(root))).toBe(24);
    expect(aside(root)).toEqual([]);
  });

  it('refuses only when another opener holds it; any other error proceeds unlocked', () => {
    const lockError = (err: Error) => (name: string, sql: string) => {
      if (name.endsWith('.open.lock') && sql === 'BEGIN EXCLUSIVE') throw err;
    };
    hook.exec = lockError(
      new Database.SqliteError('attempt to write a readonly database', 'SQLITE_READONLY'),
    );
    expect(stale(open(ownWal()))).toBe(24);
    hook.exec = lockError(new Database.SqliteError('database is locked', 'SQLITE_BUSY'));
    expect(() => open(ownWal())).toThrow(
      'open: database is locked (another process is writing the index; retry when it finishes)',
    );
  });
});
