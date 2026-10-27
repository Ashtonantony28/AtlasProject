// AUDIT-42: soundness, round 13 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-42.md (IDs A42-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held:
// SG190 in `openDatabase` (`reportAside` offers the move-back only when `inUse` sees no live
// connection, reading `holders` and falling back to a probe under `<db>.open.lock`; a read-only
// open reads `schema_version` once and ignores any error from it).
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. Emulations keep the tests deterministic and unprivileged (AUDIT-42.md has
// the real repros):
// - a `--require` preload makes `/proc/locks` read as an empty file, as it reads from a CLI in
//   another pid namespace than the holder (a dev container beside `atlas serve` on the host), or
//   be missing (ENOENT), as on macOS/BSD;
// - a connection opened in the test process stands in for a running `atlas serve` (read-only) or
//   `atlas mcp` (writable), and a `BEGIN EXCLUSIVE` on `<db>.open.lock` held by the test process
//   stands in for another opener inside `openDatabase` (a long check, or a stopped process).
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
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
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { openProjectIndex } from '../../src/core/project.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const NODE_ARGS = ['--import', 'tsx'];
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';

const dirs: string[] = [];
const cleanup: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit42-'));
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
  ms: number;
}

/** The real CLI in another process, with extra node arguments (a preload) and env. */
function cli(args: string[], nodeArgs: string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  const t = Date.now();
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...nodeArgs, CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status, ms: Date.now() - t };
}

/**
 * A preload that makes `/proc/locks` read as the file named by `ATLAS_AUDIT42_LOCKS` (an empty
 * file: what a CLI in another pid namespace than the holder reads), or be missing (ENOENT) when
 * that variable is empty: macOS/BSD.
 */
function procLocks(fake: 'filtered' | 'missing'): { nodeArgs: string[]; env: NodeJS.ProcessEnv } {
  const dir = tmp();
  const pre = join(dir, 'proc-locks.cjs');
  writeFileSync(
    pre,
    `const fs = require('fs');
     const orig = fs.readFileSync;
     fs.readFileSync = function (p, ...rest) {
       if (p === '/proc/locks') {
         const fake = process.env.ATLAS_AUDIT42_LOCKS;
         if (!fake) throw Object.assign(new Error("ENOENT: no such file or directory, open '/proc/locks'"), { code: 'ENOENT' });
         return orig.call(this, fake, ...rest);
       }
       return orig.call(this, p, ...rest);
     };
     require('module').syncBuiltinESMExports();`,
  );
  const empty = join(dir, 'locks');
  writeFileSync(empty, '');
  return {
    nodeArgs: ['--require', pre],
    env: { ATLAS_AUDIT42_LOCKS: fake === 'filtered' ? empty : '' },
  };
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

/** A committed write (rows and one doc per file) SIGKILLed before any checkpoint. */
function killedWriter(dbPath: string): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id; INSERT INTO docs (target_kind, target_id, content, source_hash, generated_at) SELECT 'file', id, 'DOC-FOR-' || path, 'h', '2026-10-27' FROM files");
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
  expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(32);
}

/** A replaced index beside a killed writer's WAL, which the first read sets aside. */
function setAsideByRead(): string {
  const root = indexed();
  const other = indexed(REPLACEMENT_FN);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(other), dbOf(root)); // restore a backup over an index after a crash
  const first = cli(['search', 'add', '--cwd', root, '--limit', '1']);
  expect(first.code, first.err).toBe(0);
  expect(first.err).toMatch(/does not belong to .*; moved it to .*-wal\.foreign-/);
  return root;
}

/**
 * A killed writer's own WAL set aside as `setAside` names it (`-<size>-<mtimeNs>` of the index),
 * with its `-shm` gone, as A39-01 (a bad page) or A36-01 (an I/O error) leaves it.
 */
function ownAside(): { root: string; name: string } {
  const root = indexed();
  killedWriter(dbOf(root));
  const st = statSync(dbOf(root), { bigint: true });
  const name = `${dbOf(root)}-wal.foreign-${Date.now()}-${st.size}-${st.mtimeNs}`;
  renameSync(`${dbOf(root)}-wal`, name);
  rmSync(`${dbOf(root)}-shm`, { force: true });
  return { root, name };
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

/** A connection in this process, as a running `atlas serve` (read-only) or `atlas mcp` holds. */
function hold(root: string, readonly: boolean): Database.Database {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const db = readonly
    ? openProjectIndex(root, { readonly: true }).db
    : openDatabase(dbOf(root), { fileMustExist: true });
  cleanup.push(() => db.open && closeDatabase(db));
  return db;
}

/** Another opener inside `openDatabase`: `<db>.open.lock` held with `BEGIN EXCLUSIVE`. */
function holdOpenLock(root: string): () => void {
  const lock = new Database(`${dbOf(root)}.open.lock`);
  lock.exec('BEGIN EXCLUSIVE');
  const release = (): void => {
    if (lock.open) lock.close();
  };
  cleanup.push(release);
  return release;
}

describe('A42-01 (medium) `inUse` trusts a `/proc/locks` that does not list every holder', () => {
  it.fails(
    'A42-01 from a CLI whose /proc/locks does not list the holder (another pid namespace), the reminder does not offer the move-back while `atlas serve` holds the index',
    () => {
      const root = setAsideByRead();
      hold(root, true); // `atlas serve` on the host
      const { nodeArgs, env } = procLocks('filtered'); // the CLI in a dev container
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1'], nodeArgs, env);
      expect(r.code, r.err).toBe(0);
      // Today: "… if its writes belong there, stop every Atlas process on the project, then move
      // it back to …index.db-wal before anything writes the index". The host's `atlas serve` is
      // not an Atlas process the container can see. Followed (AUDIT-42.md, real namespaces): the
      // container's CLI exits 1 "unreadable … delete …index.db with its -wal and -shm", the
      // host's CLI exits 0 and /api/stats answers 200, and the WAL stays beside the index.
      expect(r.err).not.toMatch(/move it back/);
      expect(r.err).toMatch(/has open/);
    },
    60_000,
  );

  it('the same holder is seen through the real /proc/locks, and by the probe where there is none', () => {
    const root = setAsideByRead();
    hold(root, true);
    const own = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(own.code, own.err).toBe(0);
    expect(own.err).toMatch(/which a running Atlas process has open: stop every Atlas process/);
    const { nodeArgs, env } = procLocks('missing');
    const none = cli(['search', 'add', '--cwd', root, '--limit', '1'], nodeArgs, env);
    expect(none.code, none.err).toBe(0);
    expect(none.err).toMatch(/which a running Atlas process has open/);
    expect(none.err).not.toMatch(/move it back/);
  }, 60_000);
});

describe('A42-02 (low) a moved-back WAL that a live connection will not read is dropped with no message', () => {
  it.fails(
    'A42-02 an own WAL moved back while `atlas mcp` holds the index (an MCP client started it again) is reported, or its rows and docs survive the next write',
    () => {
      const { root, name } = ownAside();
      const offer = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      expect(offer.err).toMatch(/stop every Atlas process on the project, then move it back/);
      const mcp = hold(root, false); // relaunched by the MCP client after the user stopped it
      renameSync(name, `${dbOf(root)}-wal`); // as the reminder says
      const after = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      expect(after.code, after.err).toBe(0);
      // The next `atlas_index`: any write through the live connection, then it stops.
      mcp.prepare('UPDATE files SET loc = loc + 1').run();
      closeDatabase(mcp);
      const s = seen(root);
      // Today: `after` exits 0 with an empty stderr (the live -shm says the WAL is empty, and no
      // check runs beside a live holder), `atlas drift` says "no docs found in the index", the
      // write restarts the WAL over the moved-back frames: 0 rows, 0 docs, nothing on any
      // surface. Without the holder the same move-back restores 24 rows and 4 docs (pinned).
      expect(
        /index\.db-wal/.test(after.err) || (s.stale === 24 && s.docs === 4),
        `stderr ${JSON.stringify(after.err)}, seen ${JSON.stringify(s)}`,
      ).toBe(true);
    },
    60_000,
  );

  it('with every Atlas process stopped, the same move-back restores every row and doc', () => {
    const { root, name } = ownAside();
    const offer = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(offer.err).toMatch(/then move it back/);
    renameSync(name, `${dbOf(root)}-wal`);
    const r = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
    expect(seen(root)).toMatchObject({ stale: 24, docs: 4 });
  }, 60_000);
});

describe('A42-03 (low) where `holders` cannot tell, a set-aside file makes every read wait on the open lock', () => {
  it.fails(
    'A42-03 without /proc/locks (macOS, BSD), a read beside a set-aside WAL does not wait 60 s for another opener and fail as "database is locked"',
    () => {
      const root = setAsideByRead();
      holdOpenLock(root);
      const { nodeArgs, env } = procLocks('missing');
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1'], nodeArgs, env);
      // Today: after 60 s, exit 1 "atlas: open: database is locked (another process is writing
      // the index; retry when it finishes)": `reportAside` takes the open lock to probe, although
      // no leftover WAL needs checking. Without the set-aside file the same read returns at once
      // (pinned below).
      expect(r.code, r.err).toBe(0);
      expect(r.ms).toBeLessThan(10_000);
    },
    120_000,
  );

  it('without a set-aside file the same read does not wait for the open lock', () => {
    const root = indexed();
    holdOpenLock(root);
    const { nodeArgs, env } = procLocks('missing');
    const r = cli(['search', 'add', '--cwd', root, '--limit', '1'], nodeArgs, env);
    expect(r.code, r.err).toBe(0);
    expect(r.ms).toBeLessThan(10_000);
  }, 60_000);
});

describe('SG190 held (pinned)', () => {
  it('the read-only open holds no transaction and blocks no writer, TRUNCATE checkpoint or exclusive lock', () => {
    const root = indexed();
    const ro = hold(root, true);
    expect(ro.inTransaction).toBe(false);
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const D = require(${BSQ});
         const d = new D(${JSON.stringify(dbOf(root))}, { timeout: 0 });
         const out = [d.prepare('UPDATE files SET loc = loc + 1').run().changes];
         out.push(d.pragma('wal_checkpoint(TRUNCATE)')[0].busy);
         d.exec('BEGIN EXCLUSIVE'); d.exec('COMMIT');
         console.log(JSON.stringify(out));`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([4, 0]);
  }, 60_000);

  it('an error from the read-only open’s read is not lost: the first query names it', () => {
    const root = indexed();
    writeFileSync(dbOf(root), Buffer.alloc(statSync(dbOf(root)).size, 7));
    const { db } = openProjectIndex(root, { readonly: true });
    cleanup.push(() => closeDatabase(db));
    expect(() => db.prepare('SELECT count(*) FROM files').get()).toThrow(/file is not a database/);
    const r = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is unreadable \(file is not a database\)/);
  }, 60_000);

  it('after `atlas mcp` writes (atlas_index), the reminder says to delete the WAL, while it runs and after it stops', () => {
    const root = setAsideByRead();
    const mcp = hold(root, false);
    mcp.prepare('UPDATE files SET loc = loc + 1').run();
    const during = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(during.err).toMatch(/which may have been written since: moving it back would corrupt/);
    closeDatabase(mcp);
    const after = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(after.err).toMatch(/which may have been written since: moving it back would corrupt/);
    expect(aside(root)).toHaveLength(1);
  }, 60_000);
});
