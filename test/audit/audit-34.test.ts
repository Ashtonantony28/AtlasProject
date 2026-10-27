// AUDIT-34: soundness, round 10 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-34.md (IDs A34-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held:
// SG130/SG135, the leftover-WAL check in `openDatabase` (`checkLeftoverWal`: `/proc/locks`, the
// `<db>.open.lock`, the hard-link integrity check, the `-shm` checkpoint state, the
// `-wal.foreign-<ms>` rename, symlinks, and the fallbacks without `/proc/locks` or hard links).
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. Two process-level emulations keep the tests deterministic and
// unprivileged (AUDIT-34.md has the real repros: a full tmpfs, two loop-mounted ext4 images, a
// pid namespace, a mount namespace without procfs):
// - `ulimit -f` (with SIGXFSZ ignored) makes growing a file fail with EFBIG, as a full disk or an
//   exhausted quota makes it fail with ENOSPC/EDQUOT;
// - a `--require` preload replaces what `readFileSync('/proc/locks')` returns (another device's
//   locks, or no `/proc/locks` at all as on macOS).
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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

const dirs: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit34-'));
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

/** The real CLI where growing any file past 16 KiB fails (EFBIG), as on a full disk. */
function cliOnFullDisk(args: string[]): Run {
  const cmd = [process.execPath, ...NODE_ARGS, ...args].map((a) => `'${a}'`).join(' ');
  const r = spawnSync('bash', ['-c', `trap '' XFSZ; ulimit -f 16; exec ${cmd}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/**
 * A preload that makes `/proc/locks` read as the file named by `ATLAS_AUDIT34_LOCKS`, or be
 * missing (ENOENT) when that variable is empty: macOS/BSD, or a sandbox without procfs.
 */
function procLocksPreload(): string {
  const file = join(tmp(), 'proc-locks.cjs');
  writeFileSync(
    file,
    `const fs = require('fs');
     const orig = fs.readFileSync;
     fs.readFileSync = function (p, ...rest) {
       if (p === '/proc/locks') {
         const fake = process.env.ATLAS_AUDIT34_LOCKS;
         if (!fake) throw Object.assign(new Error("ENOENT: no such file or directory, open '/proc/locks'"), { code: 'ENOENT' });
         return orig.call(this, fake, ...rest);
       }
       return orig.call(this, p, ...rest);
     };
     require('module').syncBuiltinESMExports();`,
  );
  return file;
}

/** A copy of the sample (optionally with `extra` appended to src/app.ts), indexed and closed. */
function indexed(extra?: string, extraFile?: [string, string]): string {
  const root = join(tmp(), 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
  if (extraFile) {
    mkdirSync(join(root, extraFile[0], '..'), { recursive: true });
    writeFileSync(join(root, extraFile[0]), extraFile[1]);
  }
  const r = cli(['index', root]);
  expect(r.code, r.err).toBe(0);
  expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
  return root;
}

/** A committed write SIGKILLed before any checkpoint: its WAL and -shm stay beside `dbPath`. */
function killedWriter(
  dbPath: string,
  sql = "UPDATE symbols SET docstring = 'STALE-WAL-' || id",
): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec(${JSON.stringify(sql)});
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
  expect(statSync(`${realpathSync(dbPath)}-wal`).size).toBeGreaterThan(32);
}

/** What `atlas docs` commits for every file: one doc row naming the file it was written for. */
const DOCS_WRITER = `INSERT INTO docs (target_kind, target_id, content, source_hash, generated_at)
  SELECT 'file', id, 'DOC-FOR-' || path, 'h', '2026-10-27' FROM files`;

/** What a read sees: the killed writer's rows, its docs, and the replacement's symbol. */
function seen(root: string): { stale: number; docs: number; replacement: number } {
  const { db } = openProjectIndex(root, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT (SELECT count(*) FROM symbols WHERE docstring LIKE 'STALE-WAL-%') AS stale,
                (SELECT count(*) FROM docs WHERE content LIKE 'DOC-FOR-%') AS docs,
                (SELECT count(*) FROM symbols WHERE name = 'replacementOnlyFn') AS replacement`,
      )
      .get() as { stale: number; docs: number; replacement: number };
  } finally {
    closeDatabase(db);
  }
}

function integrity(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('integrity_check', { simple: true }) as string;
  } finally {
    db.close();
  }
}

/** What a race-free open of a replaced index must give: the replacement, or a named refusal. */
function expectReplacementOrRefusal(search: Run, root: string): void {
  if (search.code === 0) {
    expect(search.out).toMatch(/replacementOnlyFn/);
    expect(integrity(dbOf(root))).toBe('ok');
  } else {
    expect(search.err).toMatch(/-wal it does not belong to/);
  }
}

/** `/proc/locks` lines for `files`' inode numbers on a device the index is not on. */
function locksOnAnotherDevice(files: string[]): string {
  const file = join(tmp(), 'locks');
  const lines = files.map((f, i) => {
    const ino = statSync(f, { bigint: true }).ino;
    return `${i + 1}: POSIX  ADVISORY  READ 4242 fd:7f:${ino} 128 128`;
  });
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
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

describe('A34-01 (high) a WAL that belongs to the index is renamed aside when the check cannot run', () => {
  it.fails(
    'A34-01 on a full disk (growing a file fails) a killed writer’s own WAL is kept: its rows and docs are not lost',
    () => {
      const root = indexed();
      killedWriter(dbOf(root), `UPDATE symbols SET docstring = 'STALE-WAL-' || id; ${DOCS_WRITER}`);
      // The first command after the crash runs while the disk is full (the usual reason a writer
      // dies). The check's read-only connection cannot grow its `.check-shm` to 32 KiB
      // (SQLITE_IOERR_SHMSIZE), `integrityOk` reads any non-busy error as "fails integrity", the
      // -shm says never checkpointed, and the WAL is renamed to `index.db-wal.foreign-<ms>` with
      // "does not belong to" on stderr. Real repro: AUDIT-34.md (40 MB tmpfs, 60 docs -> 0).
      cliOnFullDisk(['search', 'add', '--cwd', root, '--limit', '1']);
      // Space is back. Today: { stale: 0, docs: 0 }, exit 0 on every surface.
      expect(seen(root)).toMatchObject({ stale: 24, docs: 4 });
      expect(aside(root)).toEqual([]);
    },
    60_000,
  );
});

describe('A34-02 (medium) `/proc/locks` is matched by inode number on any device', () => {
  it.fails(
    'A34-02 locks on the same inode numbers on another filesystem do not skip the check: a replaced index is not mixed with a foreign WAL',
    () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root));
      copyFileSync(dbOf(other), dbOf(root)); // in place: same inode, beside the stale WAL
      // A process on another filesystem (a btrfs/ZFS snapshot or clone of the project, a copied
      // disk image) holds files with the same inode numbers as index.db and its -shm. Real repro:
      // two loop-mounted copies of one ext4 image (AUDIT-34.md).
      const fake = locksOnAnotherDevice([dbOf(root), `${dbOf(root)}-shm`]);
      const search = cli(
        ['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1'],
        ['--require', procLocksPreload()],
        { ATLAS_AUDIT34_LOCKS: fake },
      );
      // Today: `liveWal` is true, the check is skipped and SQLite replays the foreign WAL: exit 0
      // with `add`, and the close checkpoints the mix (`wrong # of entries in index ...`).
      expectReplacementOrRefusal(search, root);
    },
    60_000,
  );

  it.fails(
    'A34-02 a lock on the -shm’s inode number on another filesystem does not refuse an index beside its own WAL',
    () => {
      const root = indexed();
      killedWriter(dbOf(root));
      const fake = locksOnAnotherDevice([`${dbOf(root)}-shm`]);
      const search = cli(
        ['search', 'add', '--cwd', root, '--limit', '1'],
        ['--require', procLocksPreload()],
        { ATLAS_AUDIT34_LOCKS: fake },
      );
      // Today: exit 1, "unreadable (another process still has the replaced index open) ... delete
      // index.db with its -wal and -shm", which deletes the WAL's commits if followed.
      expect(search.err).toBe('');
      expect(search.code).toBe(0);
      expect(seen(root).stale).toBe(24);
    },
    60_000,
  );
});

describe('A34-03 (medium) a foreign WAL that only adds rows passes the integrity check and is replayed', () => {
  it.fails(
    'A34-03 a killed `atlas docs` WAL beside another checkout’s index does not graft its docs onto other files',
    () => {
      const root = indexed();
      // Another checkout of the same project with one more file early in walk order, so file
      // ids shift by one. The same holds with ids unchanged (13 of 18 real trials, AUDIT-34.md).
      const other = indexed(undefined, ['a/first.ts', 'export function zFirst() { return 1; }\n']);
      killedWriter(dbOf(root), DOCS_WRITER); // `atlas docs` SIGKILLed (or SIGHUP) mid-run
      copyFileSync(dbOf(other), dbOf(root));
      const show = cli(['docs', '--show', 'src/app.ts', '--cwd', root]);
      // Today: exit 0 printing `DOC-FOR-src/math.ts` or another file's doc: the WAL holds only
      // new docs pages (and page 1), the mix is structurally valid, so it is kept and replayed.
      if (show.code === 0) expect(show.out).not.toMatch(/DOC-FOR-(?!src\/app\.ts\b)/);
      else expect(show.err).toMatch(/-wal it does not belong to|no doc/i);
    },
    60_000,
  );
});

describe('A34-04 (low) without a usable `/proc/locks` a live holder’s WAL is renamed aside (A33-05)', () => {
  it.fails(
    'A34-04 with no /proc/locks (macOS, BSD) the WAL of a live process on a renamed-over index is kept and the CLI names the cause',
    async () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      await liveWriter(dbOf(root));
      const wal = `${dbOf(root)}-wal`;
      const ino = statSync(wal).ino;
      renameSync(dbOf(other), dbOf(root));
      const search = cli(
        ['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1'],
        ['--require', procLocksPreload()],
        { ATLAS_AUDIT34_LOCKS: '' },
      );
      // Today: the probe sees nobody on the new inode, the integrity check fails, the -shm says
      // never checkpointed: the live writer's WAL is renamed aside, then `atlas: disk I/O error`.
      // The same happens with /proc/locks from another pid namespace (a container): AUDIT-34.md.
      expect(search.err).not.toMatch(/^atlas: disk I\/O error$/m);
      expect(statSync(wal).ino).toBe(ino);
    },
    60_000,
  );
});

describe('SG130/SG135 held (pinned)', () => {
  it('a killed `atlas docs` copied with `cp -a` keeps its docs; in place, after `mv` and after a copy without -shm', () => {
    const src = indexed();
    killedWriter(dbOf(src), DOCS_WRITER);
    const a = join(tmp(), 'cpa');
    cpSync(src, a, { recursive: true, preserveTimestamps: true });
    const b = join(tmp(), 'noshm');
    cpSync(src, b, { recursive: true, preserveTimestamps: true });
    rmSync(`${dbOf(b)}-shm`);
    for (const f of ['', '-shm', '-wal']) {
      renameSync(dbOf(src) + f, `${dbOf(src)}${f}.moved`);
      renameSync(`${dbOf(src)}${f}.moved`, dbOf(src) + f);
    }
    for (const root of [src, a, b]) {
      const list = cli(['docs', '--list', '--cwd', root]);
      expect(list.code, list.err).toBe(0);
      expect(seen(root).docs).toBe(4);
      expect(aside(root)).toEqual([]);
    }
  }, 60_000);

  it('three CLI processes opening a replaced index at once never answer from the mix', async () => {
    const root = indexed();
    const other = indexed(REPLACEMENT_FN);
    killedWriter(dbOf(root));
    copyFileSync(dbOf(other), dbOf(root));
    const runs = await Promise.all(
      [0, 1, 2].map(
        () =>
          new Promise<Run>((ok) => {
            const c = spawn(
              process.execPath,
              [...NODE_ARGS, 'search', 'replacementOnlyFn', '--cwd', root, '--limit', '1'],
              { cwd: ROOT },
            );
            let out = '';
            let err = '';
            c.stdout.on('data', (d) => (out += d));
            c.stderr.on('data', (d) => (err += d));
            c.on('exit', (code) => ok({ out, err: err.trim(), code }));
          }),
      ),
    );
    for (const r of runs) expect(r.out).toMatch(/replacementOnlyFn/);
    expect(seen(root)).toMatchObject({ stale: 0, replacement: 1 });
    expect(integrity(dbOf(root))).toBe('ok');
    expect(aside(root)).toHaveLength(1);
  }, 60_000);

  it('check links left by an opener SIGKILLed mid-check confuse no later open', () => {
    const root = indexed();
    killedWriter(dbOf(root));
    // What `integrityOk` leaves when killed between its links and its cleanup.
    const left = `${dbOf(root)}.99999.1793000000000.check`;
    linkSync(dbOf(root), left);
    linkSync(`${dbOf(root)}-wal`, `${left}-wal`);
    writeFileSync(`${left}-shm`, Buffer.alloc(32768));
    expect(seen(root).stale).toBe(24);
    expect(aside(root)).toEqual([]);
    const other = indexed(REPLACEMENT_FN);
    killedWriter(dbOf(root));
    copyFileSync(dbOf(other), dbOf(root));
    expectReplacementOrRefusal(cli(['search', 'replacementOnlyFn', '--cwd', root]), root);
  }, 60_000);

  it('an open lock left by a SIGKILLed opener (with its -journal) blocks no later open', () => {
    const root = indexed();
    killedWriter(dbOf(root));
    const lock = `${dbOf(root)}.open.lock`;
    const r = spawnSync(process.execPath, [
      '-e',
      `const D = require(${BSQ});
       const l = new D(${JSON.stringify(lock)});
       l.exec('BEGIN EXCLUSIVE');
       process.kill(process.pid, 'SIGKILL');`,
    ]);
    expect(r.signal).toBe('SIGKILL');
    const start = Date.now();
    const search = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(search.code, search.err).toBe(0);
    expect(Date.now() - start).toBeLessThan(15_000); // not the 60 s open-lock wait
    expect(seen(root).stale).toBe(24);
  }, 60_000);

  it('a two-level relative symlink chain: its own WAL is kept, a foreign one is not mixed in', () => {
    const root = indexed();
    const other = indexed(REPLACEMENT_FN);
    const base = tmp();
    mkdirSync(join(base, 'store'));
    mkdirSync(join(base, 'store2'));
    renameSync(dbOf(root), join(base, 'store2', 'real.db'));
    symlinkSync('../store2/real.db', join(base, 'store', 'link.db'));
    symlinkSync(join(base, 'store', 'link.db'), dbOf(root));
    killedWriter(dbOf(root));
    expect(existsSync(join(base, 'store2', 'real.db-wal'))).toBe(true);
    expect(seen(root).stale).toBe(24);
    killedWriter(dbOf(root), "UPDATE symbols SET docstring = 'STALE-WAL-2-' || id");
    copyFileSync(dbOf(other), dbOf(root)); // through the links, into store2/real.db
    expectReplacementOrRefusal(cli(['search', 'replacementOnlyFn', '--cwd', root]), root);
  }, 60_000);

  it('without /proc/locks (the probe fallback) a copied WAL is kept and a foreign one is not mixed in', () => {
    const preload = procLocksPreload();
    const env = { ATLAS_AUDIT34_LOCKS: '' };
    const src = indexed();
    killedWriter(dbOf(src));
    const copy = join(tmp(), 'copy');
    cpSync(src, copy, { recursive: true, preserveTimestamps: true });
    const kept = cli(['search', 'add', '--cwd', copy, '--limit', '1'], ['--require', preload], env);
    expect(kept.code, kept.err).toBe(0);
    expect(seen(copy).stale).toBe(24);
    const other = indexed(REPLACEMENT_FN);
    copyFileSync(dbOf(other), dbOf(src));
    const search = cli(
      ['search', 'replacementOnlyFn', '--cwd', src, '--limit', '1'],
      ['--require', preload],
      env,
    );
    expectReplacementOrRefusal(search, src);
  }, 60_000);
});
