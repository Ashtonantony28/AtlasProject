// AUDIT-39: soundness, round 12 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-39.md (IDs A39-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held:
// SG150 in `openDatabase` (`integrityOk` sets a WAL aside only when two checks fail the same way
// and every byte of the index and WAL reads back; the set-aside name records the index's size and
// mtime, and `reportAside` offers the move-back only while they match).
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. Emulations keep the tests deterministic and unprivileged (AUDIT-39.md has
// the real repros):
// - one byte written into an index b-tree page stands in for a bad page on a disk that returns
//   wrong data instead of an error (bit rot, a remapped sector);
// - `utimesSync` to a whole second stands in for a filesystem with 1 s timestamps (ext4 with
//   128-byte inodes, ext3, HFS+, some NFS servers), where a write in the same second keeps the
//   index's mtime;
// - an `LD_PRELOAD` shim (built with `cc`; skipped without one) fails a window of `pread` calls
//   on the integrity check's hard link, as a transient I/O error does.
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
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

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit39-'));
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

/** The real CLI in another process. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/**
 * An `LD_PRELOAD` shim: `pread` calls number `EIO_FROM` to `EIO_FROM + EIO_COUNT - 1` on a file
 * whose path ends with `EIO_SUFFIX` fail with EIO; the others succeed (a transient error).
 */
function eioWindowShim(): string {
  const dir = tmp();
  writeFileSync(
    join(dir, 'win.c'),
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
  if (matches(fd)) {
    long k = seen++, from = atol(getenv("EIO_FROM") ? getenv("EIO_FROM") : "0");
    long count = atol(getenv("EIO_COUNT") ? getenv("EIO_COUNT") : "1");
    if (k >= from && k < from + count) {
      errno = EIO;
      return -1;
    }
  }
  return real(fd, buf, c, o);
}
ssize_t pread(int fd, void *buf, size_t c, off_t o) __attribute__((alias("pread64")));
`,
  );
  const so = join(dir, 'win.so');
  const r = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-o', so, join(dir, 'win.c'), '-ldl'], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return so;
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
const KILLED_RUN = `UPDATE symbols SET docstring = 'STALE-WAL-' || id;
  INSERT INTO docs (target_kind, target_id, content, source_hash, generated_at)
  SELECT 'file', id, 'DOC-FOR-' || path, 'h', '2026-10-27' FROM files`;

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

/** The last page of `name`'s b-tree in a closed index (no WAL beside it). */
function pageOf(dbPath: string, name: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT max(pageno) AS p FROM dbstat WHERE name = ?')
      .get(name) as { p: number };
    return row.p;
  } finally {
    db.close();
  }
}

/** One byte of rot: page `page`'s b-tree page type becomes invalid. */
function rot(dbPath: string, page: number): void {
  const fd = openSync(dbPath, 'r+');
  try {
    writeSync(fd, Buffer.from([0x01]), 0, 1, (page - 1) * 4096);
  } finally {
    closeSync(fd);
  }
}

describe('A39-01 (medium) a bad page in index.db itself is taken as proof that its own WAL is foreign', () => {
  it.fails(
    'A39-01 a killed writer’s WAL beside an index.db with one bad page is not renamed aside as foreign, and its rows and docs are not dropped with exit 0',
    () => {
      const root = indexed();
      const page = pageOf(dbOf(root), 'idx_edges_kind');
      killedWriter(dbOf(root));
      // A page the WAL does not touch and `atlas search` does not read. `index.db` alone fails
      // `PRAGMA integrity_check` the same way ("Tree 16 page 16: btreeInitPage() returns error
      // code 11"), with or without the WAL, so the WAL is not what makes it fail.
      rot(dbOf(root), page);
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      // Today: exit 0 (`0.023 function add`), "index.db-wal does not belong to index.db; moved
      // it to …-wal.foreign-<ms>-<size>-<mtime>"; the 24 rows and 4 docs are gone from every
      // answer, and `atlas drift` says "no docs found in the index".
      expect(r.err).not.toMatch(/does not belong to/);
      expect(aside(root)).toEqual([]);
      expect(statSync(`${dbOf(root)}-wal`).size).toBeGreaterThan(32);
    },
    60_000,
  );
});

describe('A39-02 (low) the move-back is still offered after a write that keeps the index’s size and mtime', () => {
  it.fails(
    'A39-02 on a filesystem with 1 s timestamps, a write in the same second as the set-aside makes the reminder stop offering the move-back',
    () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root));
      cpSync(dbOf(other), dbOf(root));
      // 1 s timestamps: the index's mtime is a whole second.
      const second = Math.floor(Date.now() / 1000) - 5;
      utimesSync(dbOf(root), second, second);
      expect(cli(['search', 'add', '--cwd', root]).err).toMatch(/does not belong to/);
      expect(cli(['search', 'add', '--cwd', root]).err).toMatch(/move it back/);
      const size = statSync(dbOf(root)).size;
      appendFileSync(join(root, 'src', 'app.ts'), '\n// edited\n');
      expect(cli(['index', root]).code).toBe(0);
      // Atlas index files keep their size on such a write (sample, express, flask, got), and a
      // write in the same second keeps the mtime: what a 1 s filesystem shows after it.
      expect(statSync(dbOf(root)).size).toBe(size);
      utimesSync(dbOf(root), second, second);
      const after = cli(['search', 'add', '--cwd', root]);
      // Today: "… if its writes belong there, move it back to …index.db-wal before anything
      // writes the index", although `atlas index` has written it. On a real ext4 with 128-byte
      // inodes, following it gives the A36-02 result (AUDIT-39.md).
      expect(after.err).not.toMatch(/move it back/);
    },
    60_000,
  );
});

describe('A39-03 (low) a WAL set aside before SG150 is always to be deleted', () => {
  it.fails(
    'A39-03 a killed writer’s own WAL that SG140 set aside (A36-01) is not called unsafe to move back while nothing has written the index',
    () => {
      const root = indexed();
      killedWriter(dbOf(root));
      const wal = `${dbOf(root)}-wal`;
      // The name SG130/SG140 gave it (no size or mtime), as A36-01 left it after an EIO.
      renameSync(wal, `${wal}.foreign-1793000000000`);
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      // Today: "… which may have been written since: moving it back would corrupt the index;
      // delete it". Nothing has written it; moving it back restores every row (pinned below).
      expect(r.err).not.toMatch(/moving it back would corrupt the index/);
    },
    60_000,
  );

  it('a WAL SG140 set aside from its own index still restores every row and doc when moved back', () => {
    const root = indexed();
    killedWriter(dbOf(root));
    const wal = `${dbOf(root)}-wal`;
    renameSync(wal, `${wal}.foreign-1793000000000`);
    expect(cli(['search', 'add', '--cwd', root]).code).toBe(0);
    renameSync(`${wal}.foreign-1793000000000`, wal);
    const r = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
    expect(seen(root)).toMatchObject({ stale: 24, docs: 4 });
  }, 60_000);
});

describe('SG150 held (pinned)', () => {
  (CC ? it : it.skip)(
    'a transient EIO in one check keeps an own WAL with every row, and never keeps a foreign one',
    () => {
      const so = eioWindowShim();
      const own = indexed();
      killedWriter(dbOf(own));
      for (const from of ['3', '50', '300']) {
        const r = cli(['search', 'add', '--cwd', own, '--limit', '1'], {
          LD_PRELOAD: so,
          EIO_SUFFIX: '.check',
          EIO_FROM: from,
          EIO_COUNT: '1',
        });
        expect(r.err).not.toMatch(/does not belong to/);
        expect(aside(own)).toEqual([]);
        if (r.code === 0) break;
        expect(r.err).toMatch(/cannot check .*; it is kept/);
      }
      expect(seen(own)).toMatchObject({ stale: 24, docs: 4 });

      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root));
      cpSync(dbOf(other), dbOf(root));
      const hit = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1'], {
        LD_PRELOAD: so,
        EIO_SUFFIX: '.check',
        EIO_FROM: '50',
        EIO_COUNT: '1',
      });
      expect(hit.code, hit.err).toBe(1);
      // "(a page could not be read: *** in database main ***\nTree 29 page 29 cell 0: failed to get
      // page 71); it is kept": the two checks differ, so the WAL is kept, and the next run decides.
      expect(hit.err).toMatch(/cannot check .*\(a page could not be read: [^]*; it is kept/);
      expect(aside(root)).toEqual([]);
      const next = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
      expect(next.code, next.err).toBe(0);
      expect(next.out).toMatch(/replacementOnlyFn/);
      expect(aside(root)).toHaveLength(1);
    },
    90_000,
  );
});
