// AUDIT-29: soundness, round 8 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-29.md (IDs A29-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held: SG90
// (a stale `-wal` beside a deleted index is left to SQLite; `switchToWal` retries the 0-byte race)
// and its interplay with SG65 (`createWalFile`) and SG80 (`immediate`).
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeDatabase,
  counts,
  MIGRATIONS,
  openDatabase,
  upsertFile,
  type DB,
} from '../../src/core/db/index.js';
import { requireIndexed } from '../../src/core/project.js';
import { lockHolder, type LockHolder } from '../helpers/lockHolder.js';

const ROOT = resolve(__dirname, '../..');
const DB_MODULE = JSON.stringify(join(ROOT, 'src/core/db/index.ts'));
const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const dirs: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit29-'));
  dirs.push(d);
  return d;
}

function open(path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }): DB {
  const db = openDatabase(path, opts);
  cleanup.push(() => {
    if (db.open) closeDatabase(db);
  });
  return db;
}

function add(db: DB, n: number, tag: string): void {
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      upsertFile(db, { path: `${tag}${i}.ts`, language: 'typescript', content_hash: 'h', loc: 1 });
    }
  })();
}

const version = (db: DB): number =>
  (db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number }).v;

/** The index at `path` is fresh, healthy, in WAL mode, migrated and keeps what is written to it. */
function expectFresh(path: string): void {
  const db = openDatabase(path);
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(version(db)).toBe(LATEST);
    expect(counts(db).files).toBe(0);
    add(db, 3, 'new');
  } finally {
    closeDatabase(db);
  }
  const again = openDatabase(path);
  try {
    expect(again.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(counts(again).files).toBe(3);
  } finally {
    closeDatabase(again);
  }
}

/**
 * Leaves beside the deleted `real` what a killed run leaves: its `-wal` and `-shm` (a WAL holding
 * every page of a 300-file index). `via` is the path the index was opened by (a symlink, say).
 */
function leftoverWal(real: string, via = real): void {
  const db = openDatabase(via);
  db.pragma('wal_autocheckpoint = 0');
  add(db, 300, 'old');
  for (const f of ['-wal', '-shm']) copyFileSync(real + f, `${real}${f}.saved`);
  closeDatabase(db);
  rmSync(real);
  for (const f of ['-wal', '-shm']) {
    copyFileSync(`${real}${f}.saved`, real + f);
    rmSync(`${real}${f}.saved`);
  }
  expect(existsSync(`${real}-wal`)).toBe(true);
}

interface Holder {
  /** Sends one command (`count`, `write <n>`) and resolves with its JSON answer. */
  ask(cmd: string): Promise<Record<string, unknown>>;
  /** Closes the connection and waits for the process to exit. */
  exit(): Promise<void>;
}

/**
 * Another process that keeps the index open, as `atlas serve` (read-only) and `atlas mcp`
 * (read-write) do for their whole life.
 */
async function startHolder(path: string, readonly: boolean): Promise<Holder> {
  const code = `
    const { openDatabase, counts, upsertFile } = await import(${DB_MODULE});
    const { createInterface } = await import('node:readline');
    const db = openDatabase(${JSON.stringify(path)}, ${readonly ? '{ readonly: true, fileMustExist: true }' : '{}'});
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    say({ files: counts(db).files });
    createInterface({ input: process.stdin }).on('line', (cmd) => {
      try {
        if (cmd === 'count') say({ files: counts(db).files });
        else if (cmd.startsWith('write ')) {
          const n = Number(cmd.slice(6));
          db.transaction(() => {
            for (let i = 0; i < n; i++) upsertFile(db, { path: 'holder' + i + '.ts', language: 'typescript', content_hash: 'h', loc: 1 });
          })();
          say({ files: counts(db).files });
        } else if (cmd === 'exit') { db.close(); process.exit(0); }
      } catch (err) { say({ err: String(err.message) }); }
    });`;
  const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((ok) => p.on('exit', () => ok()));
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buf = '';
  p.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(line);
      else queue.push(line);
    }
  });
  const next = (): Promise<Record<string, unknown>> =>
    new Promise<string>((ok) => {
      const l = queue.shift();
      if (l !== undefined) ok(l);
      else waiting.push(ok);
    }).then((l) => JSON.parse(l) as Record<string, unknown>);
  let done = false;
  const exit = async (): Promise<void> => {
    if (done) return;
    done = true;
    p.stdin.write('exit\n');
    await exited;
  };
  cleanup.push(exit);
  await next();
  return {
    ask: (cmd) => {
      p.stdin.write(`${cmd}\n`);
      return next();
    },
    exit,
  };
}

/** `openDatabase(path)` in a new process (as the next `atlas` command does): its counts or error. */
function openInChild(path: string): { files?: number; ic?: string; code?: string; err?: string } {
  const code = `
    const { openDatabase, counts } = await import(${DB_MODULE});
    try {
      const db = openDatabase(${JSON.stringify(path)});
      process.stdout.write(JSON.stringify({ files: counts(db).files, ic: db.pragma('integrity_check', { simple: true }) }));
      db.close();
    } catch (err) {
      process.stdout.write(JSON.stringify({ code: err.code, err: err.message }));
    }`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(r.stdout) as { files?: number; ic?: string; code?: string; err?: string };
}

/** An `atlas index` run beside the holder: writes 50 files and exits (its frames stay in the WAL). */
function refresh(path: string): void {
  const db = openDatabase(path);
  add(db, 50, 'refresh');
  closeDatabase(db);
}

/** Builds a 500-file index at `path` and leaves it closed. */
function seed(path: string): void {
  const db = openDatabase(path);
  add(db, 500, 'old');
  closeDatabase(db);
}

describe('A29-01 (medium) deleting index.db while `atlas serve` or `atlas mcp` has it open', () => {
  // The holder's WAL holds frames when anything was written since it opened (an `atlas index`
  // refresh while `atlas serve` runs; any `atlas_index` in `atlas mcp`). The new index then shares
  // the holder's `-shm`, whose header points at frames of the deleted index's WAL.
  for (const readonly of [true, false]) {
    it.fails(
      `A29-01 after \`rm index.db\` the next open gives a fresh index or names the process that still holds the deleted one (${readonly ? 'serve' : 'mcp'})`,
      async () => {
        const path = join(tmp(), 'index.db');
        seed(path);
        const holder = await startHolder(path, readonly);
        if (readonly) refresh(path);
        else await holder.ask('write 50');
        rmSync(path);
        const r = openInChild(path);
        // On this build: { code: 'SQLITE_IOERR_SHORT_READ', err: 'disk I/O error' }, for every
        // command (index, drift, search) until the holder exits.
        if (r.err !== undefined) expect(r.err).toMatch(/atlas (serve|mcp)|another process/);
        else expect(r).toEqual({ files: 0, ic: 'ok' });
        // Meanwhile the holder answers from the deleted index (550 files) as if it were current.
        await holder.exit();
      },
      30_000,
    );
  }

  it('A29-01 once the holder exits the next open gives a fresh index (no permanent damage, unlike SG65)', async () => {
    const path = join(tmp(), 'index.db');
    seed(path);
    const holder = await startHolder(path, true);
    refresh(path);
    rmSync(path);
    expect(openInChild(path)).toMatchObject({ code: 'SQLITE_IOERR_SHORT_READ' });
    expect(await holder.ask('count')).toEqual({ files: 550 });
    await holder.exit();
    expect(openInChild(path)).toEqual({ files: 0, ic: 'ok' });
    expectFresh(path);
  }, 30_000);

  it('A29-01 with nothing written since the holder opened, the reset gives a fresh index', async () => {
    const path = join(tmp(), 'index.db');
    seed(path);
    const holder = await startHolder(path, false);
    rmSync(path);
    expect(openInChild(path)).toEqual({ files: 0, ic: 'ok' });
    await holder.exit();
    expectFresh(path);
  }, 30_000);
});

describe('A29-02 (low) a failed open leaks its connection', () => {
  /** Descriptors of this process that point at `path` (Linux). */
  const fds = (path: string): number =>
    readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === path;
      } catch {
        return false;
      }
    }).length;

  (process.platform === 'linux' ? it.fails : it.skip)(
    'A29-02 `openDatabase` closes the connection when the journal-mode switch or migrations throw',
    () => {
      const path = join(tmp(), 'index.db');
      writeFileSync(path, Buffer.alloc(8192, 7)); // not a database
      const before = fds(path);
      expect(() => openDatabase(path)).toThrow(/not a database/);
      // On this build the handle stays open (+1 descriptor, its locks and `-shm` mapping kept).
      expect(fds(path)).toBe(before);
    },
  );
});

describe('SG90 held: kill, delete and reopen', () => {
  it('a WAL left by a SIGKILLed writer (not a copied one) is dropped: the new index is fresh', async () => {
    const path = join(tmp(), 'index.db');
    const code = `
      const { openDatabase, upsertFile } = await import(${DB_MODULE});
      const db = openDatabase(${JSON.stringify(path)});
      db.pragma('wal_autocheckpoint = 0');
      for (let t = 0; ; t++) {
        db.transaction(() => {
          for (let i = 0; i < 100; i++) upsertFile(db, { path: 't' + t + '_' + i + '.ts', language: 'typescript', content_hash: 'h', loc: 1 });
        })();
        if (t === 20) process.stdout.write('go\\n');
      }`;
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((ok) => p.stdout.once('data', () => ok()));
    await new Promise((r) => setTimeout(r, 150));
    const exited = new Promise<void>((ok) => p.on('exit', () => ok()));
    p.kill('SIGKILL');
    await exited;
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    rmSync(path);
    expectFresh(path);
  }, 30_000);

  it('a 0-byte index left by a kill before the switch, beside a stale WAL: a reader never sees the deleted rows, the next writer gets a fresh index', () => {
    const path = join(tmp(), 'index.db');
    leftoverWal(path);
    writeFileSync(path, '');
    const ro = open(path, { readonly: true, fileMustExist: true });
    // No tables (the reader drops the stale WAL of the empty file itself): not the 300 deleted rows.
    expect(() => requireIndexed(ro)).toThrow(/no such table: files/);
    expect(existsSync(`${path}-wal`)).toBe(false);
    closeDatabase(ro);
    expectFresh(path);
  });

  it('a 0-byte file nobody is creating opens at once (the retry only runs on SQLITE_BUSY/DELETE_NOENT)', () => {
    const path = join(tmp(), 'index.db');
    writeFileSync(path, '');
    const t0 = Date.now();
    expectFresh(path);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('the retry does not mask a real lock: a 0-byte file held past the busy timeout fails naming `journal mode`', async () => {
    const path = join(tmp(), 'index.db');
    writeFileSync(path, '');
    const holder: LockHolder = await lockHolder(path);
    cleanup.push(() => holder.close());
    holder.hold(6500);
    const t0 = Date.now();
    expect(() => openDatabase(path)).toThrow(
      /^journal mode: database is locked \(another process is writing the index/,
    );
    expect(Date.now() - t0).toBeGreaterThan(4900);
    expect(Date.now() - t0).toBeLessThan(6400);
    await holder.released();
  }, 20_000);
});

describe('SG90 held: symlinked and relative index paths', () => {
  it('a symlinked index.db whose target was deleted beside a stale WAL comes up fresh, still a symlink', () => {
    // Atlas looks for `-wal` beside the link, SQLite beside the target: the dangling link makes
    // `createWalFile`'s link fail (EEXIST), so SQLite creates the 0-byte target and drops the WAL.
    for (const target of ['abs', 'rel']) {
      const d = tmp();
      mkdirSync(join(d, 'store'));
      mkdirSync(join(d, '.atlas'));
      const real = join(d, 'store/real.db');
      const link = join(d, '.atlas/index.db');
      symlinkSync(target === 'abs' ? real : '../store/real.db', link);
      leftoverWal(real, link);
      expect(existsSync(`${link}-wal`)).toBe(false);
      expectFresh(link);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it('an `.atlas` that is a directory symlink, and a relative path, come up fresh beside a stale WAL', () => {
    const d = tmp();
    mkdirSync(join(d, 'elsewhere'));
    symlinkSync(join(d, 'elsewhere'), join(d, '.atlas'));
    leftoverWal(join(d, 'elsewhere/index.db'), join(d, '.atlas/index.db'));
    expectFresh(join(d, '.atlas/index.db'));

    const r = tmp();
    leftoverWal(join(r, 'index.db'));
    const cwd = process.cwd();
    process.chdir(r);
    try {
      expectFresh('index.db');
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('SG90 held: racing creators beside a stale WAL lose no write', () => {
  it('writers and readers opening the same fresh index at once: every writer’s row is kept', async () => {
    const dir = tmp();
    const ROUNDS = 20;
    for (let k = 0; k < ROUNDS; k++) leftoverWal(join(dir, `${k}.db`));
    const child = (role: 'w' | 'r', id: number): string => `
      const { existsSync } = await import('node:fs');
      const { openDatabase, upsertFile } = await import(${DB_MODULE});
      process.stdout.write('ready\\n');
      process.stdin.once('data', (d) => {
        const t0 = Number(String(d));
        for (let k = 0; k < ${ROUNDS}; k++) {
          while (Date.now() < t0 + k * 40);
          const p = ${JSON.stringify(dir)} + '/' + k + '.db';
          try {
            if (${JSON.stringify(role)} === 'w') {
              const db = openDatabase(p);
              upsertFile(db, { path: 'w${id}.ts', language: 'typescript', content_hash: 'h', loc: 1 });
              db.close();
              process.stdout.write('OK ' + k + '\\n');
            } else if (existsSync(p)) {
              openDatabase(p, { readonly: true, fileMustExist: true }).close();
            }
          } catch (err) {
            if (${JSON.stringify(role)} === 'w') process.stdout.write('ERR ' + k + ' ' + err.message + '\\n');
          }
        }
        process.exit(0);
      });`;
    const roles: ('w' | 'r')[] = ['w', 'w', 'w', 'w', 'r', 'r'];
    const procs = roles.map((role, id) => {
      const p = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', child(role, id)],
        {
          cwd: ROOT,
          stdio: ['pipe', 'pipe', 'inherit'],
        },
      );
      cleanup.push(() => void p.kill());
      let out = '';
      const ready = new Promise<void>((ok) =>
        p.stdout.on('data', (d: Buffer) => ((out += d.toString()), out.includes('ready') && ok())),
      );
      const code = new Promise<number | null>((ok) => p.on('close', ok));
      return { p, ready, code, out: () => out };
    });
    await Promise.all(procs.map((c) => c.ready));
    const t0 = String(Date.now() + 200);
    for (const c of procs) c.p.stdin.write(t0);
    expect(await Promise.all(procs.map((c) => c.code))).toEqual(roles.map(() => 0));
    const lines = procs.flatMap((c) => c.out().split('\n'));
    expect(lines.filter((l) => l.startsWith('ERR'))).toEqual([]);
    for (let k = 0; k < ROUNDS; k++) {
      const db = open(join(dir, `${k}.db`));
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(counts(db).files).toBe(4);
    }
  }, 60_000);
});
