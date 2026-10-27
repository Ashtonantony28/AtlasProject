// AUDIT-36: soundness, round 11 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-36.md (IDs A36-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held:
// SG140 in `openDatabase` (`integrityOk` fails closed on errors that stop the check, `holders`
// matches `/proc/locks` on device and inode, `reportAside` repeats on every open).
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. Two process-level emulations keep the tests deterministic and
// unprivileged (AUDIT-36.md has the real repros: a loop-mounted ext4 whose device is shrunk so
// reads past it fail with EIO, and 300 tmpfs mounts):
// - an `LD_PRELOAD` shim (built with `cc`; the tests that need it are skipped without one) makes
//   `pread` fail with EIO on the integrity check's hard link after N reads, as a failing disk, a
//   soft NFS/SMB mount or a FUSE drive does;
// - a `--require` preload appends lines to what `readFileSync('/proc/locks')` returns: an
//   unrelated process's lock on another filesystem.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDatabase } from '../../src/core/db/index.js';
import { openProjectIndex } from '../../src/core/project.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const NODE_ARGS = ['--import', 'tsx', CLI];
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';
const CC = spawnSync('cc', ['--version']).status === 0;

const dirs: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit36-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');
const aside = (root: string): string[] =>
  readdirSync(join(root, '.atlas')).filter((f) => f.includes('.foreign-'));

interface Run {
  out: string;
  err: string;
  code: number | null;
}

/** The real CLI in another process; `pre` are node flags before `--import tsx`. */
function cli(args: string[], pre: string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [...pre, ...NODE_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/**
 * An `LD_PRELOAD` shim: `pread` on a file whose path ends with `EIO_SUFFIX` fails with EIO once
 * `EIO_AFTER` reads of it have succeeded. SQLite reads through `pread64`.
 */
function eioShim(): string {
  const dir = tmp();
  writeFileSync(
    join(dir, 'eio.c'),
    `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static long seen = 0;
static int matches(int fd) {
  const char *s = getenv("EIO_SUFFIX");
  char p[64], t[4096];
  if (!s) return 0;
  snprintf(p, sizeof p, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(p, t, sizeof t - 1);
  if (n < 0) return 0;
  t[n] = 0;
  size_t ls = strlen(s);
  return (size_t)n >= ls && strcmp(t + n - ls, s) == 0;
}
ssize_t pread64(int fd, void *buf, size_t c, off_t o) {
  static ssize_t (*real)(int, void *, size_t, off_t);
  if (!real) real = dlsym(RTLD_NEXT, "pread64");
  if (matches(fd) && seen++ >= atol(getenv("EIO_AFTER") ? getenv("EIO_AFTER") : "0")) {
    errno = EIO;
    return -1;
  }
  return real(fd, buf, c, o);
}
ssize_t pread(int fd, void *buf, size_t c, off_t o) __attribute__((alias("pread64")));
`,
  );
  const so = join(dir, 'eio.so');
  const r = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-o', so, join(dir, 'eio.c'), '-ldl'], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return so;
}

/** A preload that appends the lines in the file `ATLAS_AUDIT36_LOCKS` to the real `/proc/locks`. */
function extraLocksPreload(): string {
  const file = join(tmp(), 'extra-locks.cjs');
  writeFileSync(
    file,
    `const fs = require('fs');
     const orig = fs.readFileSync;
     fs.readFileSync = function (p, ...rest) {
       const real = orig.call(this, p, ...rest);
       if (p !== '/proc/locks' || !process.env.ATLAS_AUDIT36_LOCKS) return real;
       return real + orig.call(this, process.env.ATLAS_AUDIT36_LOCKS, 'utf8');
     };
     require('module').syncBuiltinESMExports();`,
  );
  return file;
}

/** A copy of the sample (optionally with `extra` appended to src/app.ts), indexed and closed. */
function indexed(extra?: string): string {
  const root = join(tmp(), 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
  const r = cli(['index', root]);
  expect(r.code, r.err).toBe(0);
  expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
  return root;
}

/** What `atlas docs` commits for every file: one doc row naming the file it was written for. */
const DOCS_WRITER = `INSERT INTO docs (target_kind, target_id, content, source_hash, generated_at)
  SELECT 'file', id, 'DOC-FOR-' || path, 'h', '2026-10-27' FROM files`;
const KILLED_RUN = `UPDATE symbols SET docstring = 'STALE-WAL-' || id; ${DOCS_WRITER}`;

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

/** What a read sees: the killed writer's rows and its docs. */
function seen(root: string): { stale: number; docs: number } {
  const { db } = openProjectIndex(root, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT (SELECT count(*) FROM symbols WHERE docstring LIKE 'STALE-WAL-%') AS stale,
                (SELECT count(*) FROM docs WHERE content LIKE 'DOC-FOR-%') AS docs`,
      )
      .get() as { stale: number; docs: number };
  } finally {
    closeDatabase(db);
  }
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

describe('A36-01 (high) an I/O error during the integrity check is read as corruption', () => {
  (CC ? it.fails : it.skip)(
    'A36-01 an EIO while the check reads index.db keeps a killed writer’s own WAL: its rows and docs are not lost',
    () => {
      const so = eioShim();
      const root = indexed();
      killedWriter(dbOf(root));
      // The 21st read of the check's hard link fails with EIO. `PRAGMA integrity_check` does not
      // throw on it: it reports "Tree 37 page 37: unable to get the page. error code=8458"
      // (SQLITE_IOERR_CORRUPTFS) or "failed to get page N" as a row, so `integrityOk` returns
      // false, the -shm says never checkpointed, and the WAL is renamed aside as foreign. Real
      // repro: AUDIT-36.md (a loop-mounted ext4 whose device was shrunk).
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1'], [], {
        LD_PRELOAD: so,
        EIO_SUFFIX: '.check',
        EIO_AFTER: '20',
      });
      // Today: exit 0 with the last checkpoint's answer, and "... does not belong to ...".
      expect(r.err).not.toMatch(/does not belong to/);
      expect(aside(root)).toEqual([]);
      // Today: { stale: 0, docs: 0 }; after the next write, moving the WAL back is refused (A36-02).
      expect(seen(root)).toMatchObject({ stale: 24, docs: 4 });
    },
    60_000,
  );
});

describe('A36-02 (medium) the set-aside reminder does not stop the write that overtakes it', () => {
  it.fails(
    'A36-02 following the reminder after `atlas index` has run keeps the set-aside WAL’s rows and docs',
    () => {
      const root = indexed();
      killedWriter(dbOf(root));
      const wal = `${dbOf(root)}-wal`;
      // What `setAside` does to the index's own WAL (A36-01 on an EIO): renamed, -shm left.
      const foreign = `${wal}.foreign-1793000000000`;
      renameSync(wal, foreign);
      appendFileSync(join(root, 'src', 'app.ts'), '\n// edited\n');
      // `atlas index` prints "move it back ... before anything writes the index", then writes
      // (exit 0). `atlas mcp` does the same on its first atlas_index, with stderr hidden.
      cli(['index', root]);
      const later = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      // The next command still gives the same advice; the user follows it.
      if (/move it back/.test(later.err)) {
        renameSync(foreign, wal);
        const after = cli(['search', 'add', '--cwd', root, '--limit', '1']);
        // Today: exit 1, "unreadable (database disk image is malformed) ... delete index.db with
        // its -wal and -shm", which deletes the docs too.
        expect(after.code, after.err).toBe(0);
        expect(seen(root)).toMatchObject({ stale: 24, docs: 4 });
      }
    },
    60_000,
  );
});

describe('A36-03 (low) one unrelated lock on the same inode number on another filesystem disables the passive check', () => {
  it.fails(
    'A36-03 with /proc/locks present, a lock on another device does not bring back A33-05 (a live process’s WAL renamed aside, bare disk I/O error)',
    async () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      await liveWriter(dbOf(root));
      const wal = `${dbOf(root)}-wal`;
      const ino = statSync(wal).ino;
      renameSync(dbOf(other), dbOf(root));
      // Any process on any other filesystem that locks a file with the new index.db's inode
      // number (low numbers recur on every tmpfs, image and snapshot). SG140 then marks the
      // whole table "unsure" and falls back to the probe, which cannot see the live -shm.
      const extra = join(tmp(), 'locks');
      writeFileSync(
        extra,
        `9: POSIX  ADVISORY  WRITE 4242 fd:7f:${statSync(dbOf(root)).ino} 0 EOF\n`,
      );
      const search = cli(
        ['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1'],
        ['--require', extraLocksPreload()],
        { ATLAS_AUDIT36_LOCKS: extra },
      );
      // Without the extra line: refused with "another process still has the replaced index
      // open" (pinned below). With it, today: "does not belong to", then `atlas: disk I/O error`.
      expect(search.err).not.toMatch(/^atlas: disk I\/O error$/m);
      expect(statSync(wal).ino).toBe(ino);
    },
    60_000,
  );
});

describe('SG140 held (pinned)', () => {
  (CC ? it : it.skip)(
    'an EIO on the check’s first read refuses with the cause and keeps the WAL',
    () => {
      const so = eioShim();
      const root = indexed();
      killedWriter(dbOf(root));
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1'], [], {
        LD_PRELOAD: so,
        EIO_SUFFIX: '.check',
        EIO_AFTER: '0',
      });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/cannot check .*index\.db-wal.*\(SQLITE_IOERR\w*: disk I\/O error\)/);
      expect(aside(root)).toEqual([]);
      expect(seen(root)).toMatchObject({ stale: 24, docs: 4 });
    },
    60_000,
  );

  it('a live process on a renamed-over index is refused by name when /proc/locks has no stray lock', async () => {
    const root = indexed();
    const other = indexed(REPLACEMENT_FN);
    await liveWriter(dbOf(root));
    const wal = `${dbOf(root)}-wal`;
    const ino = statSync(wal).ino;
    renameSync(dbOf(other), dbOf(root));
    const search = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
    expect(search.code).toBe(1);
    expect(search.err).toMatch(/another process still has the replaced index open/);
    expect(statSync(wal).ino).toBe(ino);
    expect(aside(root)).toEqual([]);
  }, 60_000);

  it('a foreign WAL that fails the check is set aside once, never reported as a check that could not run', () => {
    const root = indexed();
    const other = indexed(REPLACEMENT_FN);
    killedWriter(dbOf(root), "UPDATE symbols SET docstring = 'STALE-WAL-' || id");
    cpSync(dbOf(other), dbOf(root));
    const search = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
    expect(search.err).not.toMatch(/cannot check/);
    expect(search.code, search.err).toBe(0);
    expect(search.out).toMatch(/replacementOnlyFn/);
    expect(aside(root)).toHaveLength(1);
  }, 60_000);
});
