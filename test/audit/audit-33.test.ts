// AUDIT-33: soundness, round 9 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-33.md (IDs A33-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held: SG120
// (the stale/foreign-WAL check in `openDatabase`, `nameCorrupt`, `closeOnSignal`) and SG105.
//
// Processes run as `node --import tsx` (not the `tsx` binary, which hides signal behaviour; see
// AUDIT-31). A "killed writer" is a process that commits and is SIGKILLed before it checkpoints,
// which is what SIGKILL, an OOM kill, a crash or an editor force-quitting `atlas mcp` leaves.
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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { openProjectIndex } from '../../src/core/project.js';
import { createMcpContext, handleIndexTool, type McpContext } from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const NODE_ARGS = ['--import', 'tsx', CLI];
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';

const dirs: string[] = [];
const contexts: McpContext[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit33-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');

/** The real CLI in another process. */
function cli(args: string[]): { out: string; err: string; code: number | null } {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/** A copy of the sample, indexed by the CLI (closed cleanly: no `-wal`). */
function indexed(extra?: string): string {
  const root = join(tmp(), 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
  const r = cli(['index', root]);
  expect(r.code, r.err).toBe(0);
  expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
  return root;
}

/** A committed write SIGKILLed before any checkpoint: its WAL and -shm stay beside `dbPath`. */
function killedWriter(dbPath: string): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id");
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
}

/** What a read sees: the killed writer's rows, and the replacement's symbol. */
function seen(root: string): { stale: number; replacement: number } {
  const { db } = openProjectIndex(root, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT (SELECT count(*) FROM symbols WHERE docstring LIKE 'STALE-WAL-%') AS stale,
                (SELECT count(*) FROM symbols WHERE name = 'replacementOnlyFn') AS replacement`,
      )
      .get() as { stale: number; replacement: number };
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
function expectReplacementOrRefusal(root: string): void {
  const search = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
  if (search.code === 0) {
    expect(search.out).toMatch(/replacementOnlyFn/);
    expect(integrity(dbOf(root))).toBe('ok');
  } else {
    expect(search.err).toMatch(/-wal it does not belong to/);
  }
}

describe('A33-01 (high) an index moved or copied with its own WAL loses the WAL’s commits', () => {
  it.fails(
    'A33-01 `cp -a` of a project (timestamps preserved) keeps the commits in its index.db-wal',
    () => {
      const src = indexed();
      killedWriter(dbOf(src)); // e.g. `atlas mcp` force-quit by the editor after atlas_index
      const copy = join(tmp(), 'copy');
      cpSync(src, copy, { recursive: true, preserveTimestamps: true }); // cp -a, rsync -a, tar
      // Today: 0. The copy's index.db is newer (ctime) than its own WAL's mtime and the -shm says
      // "never checkpointed", so the WAL is deleted as foreign.
      expect(seen(copy).stale).toBe(24);
    },
    60_000,
  );

  it.fails(
    'A33-01 renaming index.db, -shm and -wal (mv, in place or to another directory) keeps the WAL’s commits',
    () => {
      const root = indexed();
      killedWriter(dbOf(root));
      for (const f of ['', '-shm', '-wal']) {
        renameSync(dbOf(root) + f, `${dbOf(root)}${f}.moved`);
        renameSync(`${dbOf(root)}${f}.moved`, dbOf(root) + f);
      }
      expect(seen(root).stale).toBe(24); // Today: 0
    },
    60_000,
  );

  it('held: the same WAL left in place (not moved) is replayed', () => {
    const root = indexed();
    killedWriter(dbOf(root));
    expect(seen(root).stale).toBe(24);
  }, 60_000);
});

describe('A33-02 (high) two openers racing on a replaced index: one replays the foreign WAL', () => {
  it.fails(
    'A33-02 an opener whose probe meets another opener’s probe does not replay the foreign WAL',
    async () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root));
      copyFileSync(dbOf(other), dbOf(root)); // restore a backup / another checkout's index
      // Another Atlas process running the same check at the same instant: its probe is a hard
      // link opened in exclusive locking mode (exactly `fileInUse`), held while this CLI starts.
      const link = `${dbOf(root)}.other.probe`;
      linkSync(dbOf(root), link);
      const prober: ChildProcess = spawn(
        process.execPath,
        [
          '-e',
          `const D = require(${BSQ});
           const db = new D(${JSON.stringify(link)}, { timeout: 0 });
           db.pragma('locking_mode = EXCLUSIVE');
           db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
           process.stdout.write('held\\n');
           setTimeout(() => { db.close(); require('fs').rmSync(${JSON.stringify(link)}); }, 4500);`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      cleanup.push(() => void prober.kill('SIGKILL'));
      await new Promise<void>((ok) => prober.stdout!.once('data', () => ok()));
      // This opener's probe fails ("in use"), so it skips the drop and the integrity check, waits
      // out the lock and replays the foreign WAL. Today: exit 0 with `add`, and its close
      // checkpoints the mix into index.db (`wrong # of entries in index idx_symbols_qualified`).
      expectReplacementOrRefusal(root);
    },
    60_000,
  );
});

describe('A33-03 (medium) the foreign-WAL check is skipped and SQLite replays the WAL', () => {
  it.fails(
    'A33-03 a symlinked index.db replaced beside its target’s stale WAL is not mixed with it',
    () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      const store = join(tmp(), 'store');
      mkdirSync(store);
      renameSync(dbOf(root), join(store, 'real.db'));
      symlinkSync(join(store, 'real.db'), dbOf(root));
      killedWriter(dbOf(root)); // SQLite resolves the link: the WAL is store/real.db-wal
      copyFileSync(dbOf(other), dbOf(root)); // through the link
      // Today: exit 0 with `add`. Atlas looks for `.atlas/index.db-wal` (none), SQLite replays
      // `store/real.db-wal`; the corrupt message later names the wrong -wal.
      expectReplacementOrRefusal(root);
    },
    60_000,
  );

  it.fails(
    'A33-03 an index replaced beside a stale WAL with no -shm is not mixed with it',
    () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root));
      rmSync(`${dbOf(root)}-shm`); // not copied, cleaned up, or excluded by a backup tool
      copyFileSync(dbOf(other), dbOf(root));
      // Today: `readHead` throws ENOENT, the catch returns false (no drop, no integrity check),
      // and search exits 0 with `add`, then checkpoints the mix into index.db.
      expectReplacementOrRefusal(root);
    },
    60_000,
  );

  it('held: the same replacement with an empty (unreadable) -shm is refused with the named message', () => {
    const root = indexed();
    const other = indexed(REPLACEMENT_FN);
    killedWriter(dbOf(root));
    writeFileSync(`${dbOf(root)}-shm`, '');
    copyFileSync(dbOf(other), dbOf(root));
    const search = cli(['search', 'replacementOnlyFn', '--cwd', root]);
    expect(search.code).toBe(1);
    expect(search.err).toMatch(/-wal it does not belong to/);
  }, 60_000);
});

describe('A33-04 (low) a replacement within one timestamp tick of the WAL is not detected', () => {
  it.fails(
    'A33-04 an index replaced when its ctime does not exceed the WAL’s mtime (1 s/2 s filesystems, clock skew) is not mixed with the WAL',
    () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root));
      copyFileSync(dbOf(other), dbOf(root));
      // On a 1-second filesystem the copy made in the same second has ctime == the WAL's mtime;
      // a WAL written by a host whose clock is ahead has a later mtime. Emulated here.
      const wal = `${dbOf(root)}-wal`;
      const later = new Date(statSync(dbOf(root)).ctimeMs + 1000);
      utimesSync(wal, later, later);
      expectReplacementOrRefusal(root); // Today: exit 0 with `add`
    },
    60_000,
  );
});

describe('A33-05 (low) a live `atlas mcp` whose index is renamed over loses its WAL', () => {
  it.fails(
    'A33-05 the WAL of a live holder is never unlinked, and the CLI never fails with a bare disk I/O error',
    async () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      const ctx = createMcpContext({ root, offline: true });
      contexts.push(ctx);
      appendFileSync(join(root, 'src', 'app.ts'), '\nexport function holderOnlyFn() { return 1; }\n');
      await handleIndexTool(ctx, {}); // a small run: its WAL generation is never checkpointed
      const wal = `${dbOf(root)}-wal`;
      const ino = statSync(wal).ino;
      // Past one timestamp tick, so the rename's ctime is newer than the WAL's mtime (A33-04).
      await new Promise((ok) => setTimeout(ok, 50));
      renameSync(dbOf(other), dbOf(root));
      const search = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
      // Today: the probe tests the new inode (nobody holds it), the -shm says "never
      // checkpointed", so the live server's WAL is deleted; SQLite then reads the server's -shm
      // against a new empty WAL: `atlas: disk I/O error` until the server exits.
      expect(search.err).not.toBe('atlas: disk I/O error');
      expect(statSync(wal).ino).toBe(ino);
    },
    60_000,
  );
});

describe('SG120 held (pinned)', () => {
  it('a touched index beside a live writer in another process keeps the writer’s WAL', async () => {
    const root = indexed();
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(${BSQ});
         const db = new D(${JSON.stringify(dbOf(root))});
         db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id");
         process.stdout.write('written\\n');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    cleanup.push(() => void holder.kill('SIGKILL'));
    await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
    const now = new Date();
    utimesSync(dbOf(root), now, now); // ctime now newer than the WAL's mtime
    expect(seen(root).stale).toBe(24);
    expect(existsSync(`${dbOf(root)}-wal`)).toBe(true);
  }, 60_000);

  it('a second open in the same process as a live writer keeps that writer’s WAL and its locks', () => {
    const path = join(tmp(), 'x.db');
    const holder = openDatabase(path);
    cleanup.push(() => void (holder.open && closeDatabase(holder)));
    holder.exec('CREATE TABLE t (x)');
    holder.pragma('wal_checkpoint(TRUNCATE)');
    holder.prepare("INSERT INTO t VALUES ('live')").run();
    const later = new Date(Date.now() + 1000);
    utimesSync(path, later, later);
    closeDatabase(openDatabase(path)); // probes through a hard link in this process
    const r = spawnSync(process.execPath, [
      '-e',
      `const D = require(${BSQ}); const db = new D(${JSON.stringify(path)}, { timeout: 0 });
       db.pragma('locking_mode = EXCLUSIVE');
       try { db.prepare('SELECT 1 FROM sqlite_master').get(); console.log('free'); }
       catch { console.log('held'); }`,
    ]);
    expect(String(r.stdout).trim()).toBe('held'); // the probe's close did not drop our lock
    expect((holder.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(1);
  });

  it('`atlas index` stopped by SIGTERM mid-run closes the index, dies by SIGTERM, and the next run converges', async () => {
    const root = indexed();
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(root, 'src', `gen${i}.ts`), `export function gen${i}() { return ${i}; }\n`);
    }
    const child = spawn(process.execPath, [...NODE_ARGS, 'index', root, '--force', '--verbose'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanup.push(() => void child.kill('SIGKILL'));
    const exited = new Promise<NodeJS.Signals | null>((ok) =>
      child.once('exit', (_c, sig) => ok(sig)),
    );
    await new Promise<void>((ok) => child.stdout!.once('data', () => ok()));
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
    expect(integrity(dbOf(root))).toBe('ok');
    const again = cli(['index', root]);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/files=404 /);
  }, 60_000);

  it('`atlas mcp` stopped by SIGTERM during an in-flight atlas_index dies by SIGTERM and leaves a closed, healthy index', async () => {
    const root = indexed();
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(root, 'src', `gen${i}.ts`), `export function gen${i}() { return ${i}; }\n`);
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, 'mcp', '--offline', '--cwd', root],
      cwd: ROOT,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'audit33', version: '0.0.0' });
    cleanup.push(() => client.close().catch(() => undefined));
    await client.connect(transport);
    const child = (transport as unknown as { _process: ChildProcess })._process;
    const exited = new Promise<NodeJS.Signals | null>((ok) =>
      child.once('exit', (_c, sig) => ok(sig)),
    );
    void client.callTool({ name: 'atlas_index', arguments: { force: true } }).catch(() => undefined);
    await new Promise((ok) => setTimeout(ok, 300));
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
    expect(integrity(dbOf(root))).toBe('ok');
  }, 60_000);
});
