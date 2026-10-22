// SG45 (migrations under one `BEGIN IMMEDIATE` with a busy wait; no lock on a migrated index) and
// SG65 (a fresh index is created in WAL mode; `SQLITE_BUSY` names the operation that hit it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  closeDatabase,
  MIGRATIONS,
  openDatabase,
  runMigrations,
  type DB,
} from '../../src/core/db/index.js';

// Records, for each connection opened, the file's journal version byte (2 = WAL) at that moment.
const opened = vi.hoisted(() => [] as { path: string; version: number | null }[]);
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default;
  class Recording extends Real {
    constructor(path: string, opts?: Database.Options) {
      opened.push({ path, version: existsSync(path) ? (readFileSync(path)[18] ?? null) : null });
      super(path, opts);
    }
  }
  return { default: Recording };
});

const ROOT = resolve(__dirname, '../..');
const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  opened.length = 0;
  for (const f of cleanup.splice(0)) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-lock-'));
  dirs.push(d);
  return d;
}

function open(path: string): DB {
  const db = openDatabase(path);
  cleanup.push(() => closeDatabase(db));
  return db;
}

const version = (db: DB): number =>
  (db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number }).v;

/** Another process holding the write lock (`BEGIN IMMEDIATE`) of `path` for `ms`. */
async function holdWriteLock(path: string, ms: number, wal = true): Promise<() => Promise<void>> {
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
       const db = new D(${JSON.stringify(path)});
       ${wal ? "db.pragma('journal_mode = WAL');" : ''}
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${ms});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise<void>((ok) => holder.once('exit', () => ok()));
  cleanup.push(() => holder.kill());
  await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
  return () => exited;
}

describe('SG45 migrations across connections', () => {
  it('take the write lock before re-reading the version (`BEGIN IMMEDIATE`)', () => {
    const path = join(tmp(), 'index.db');
    const a = new Database(path);
    cleanup.push(() => a.close());
    sqliteVec.load(a);
    a.pragma('journal_mode = WAL');
    // When A re-reads the version inside its transaction, B (another connection, no wait) tries to
    // migrate the same file. A must already hold the write lock, so B is refused, not A.
    const prepare = a.prepare.bind(a);
    let other: unknown = 'not tried';
    a.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes('MAX(version)')) return stmt;
      return {
        get: (...args: unknown[]) => {
          const v: unknown = stmt.get(...args);
          if (a.inTransaction && other === 'not tried') {
            const b = new Database(path, { timeout: 0 });
            sqliteVec.load(b);
            try {
              runMigrations(b);
              other = 'migrated';
            } catch (err) {
              other = (err as { code?: string }).code;
            } finally {
              b.close();
            }
          }
          return v;
        },
      };
    }) as typeof a.prepare;
    expect(() => runMigrations(a)).not.toThrow();
    expect(other).toBe('SQLITE_BUSY');
    expect(version(a)).toBe(LATEST);
  });

  it('wait on the busy timeout while another process holds the write lock', async () => {
    const path = join(tmp(), 'index.db');
    const done = await holdWriteLock(path, 400);
    const t0 = Date.now();
    const db = open(path); // blocks this thread until the holder commits
    expect(Date.now() - t0).toBeGreaterThan(200);
    expect(version(db)).toBe(LATEST);
    await done();
  });

  it('fail naming `migrations` once the busy timeout (5 s) runs out', () => {
    const path = join(tmp(), 'index.db');
    const holder = new Database(path);
    cleanup.push(() => holder.close());
    holder.pragma('journal_mode = WAL');
    holder.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    expect(() => openDatabase(path)).toThrow(/^migrations: database is locked$/);
    expect(Date.now() - t0).toBeGreaterThan(4500);
  });

  it('are skipped on a migrated index, so opening it takes no write lock and never waits', async () => {
    const path = join(tmp(), 'index.db');
    closeDatabase(openDatabase(path));
    const done = await holdWriteLock(path, 1500);
    const t0 = Date.now();
    open(path);
    expect(Date.now() - t0).toBeLessThan(750);
    await done();
  });
});

describe('SG65 opening a fresh index', () => {
  it('creates it in WAL mode before any connection opens it, and leaves no temporary file', () => {
    const dir = tmp();
    const path = join(dir, 'index.db');
    open(path);
    expect(opened.filter((o) => o.path === path)).toEqual([{ path, version: 2 }]);
    expect(readdirSync(dir).filter((f) => !/^index\.db(-wal|-shm)?$/.test(f))).toEqual([]);
  });

  it('a file another program created in rollback mode fails at once, naming `journal mode`', async () => {
    // Switching to WAL upgrades a read lock to a write lock, which SQLite refuses without waiting.
    const path = join(tmp(), 'index.db');
    await holdWriteLock(path, 10_000, false);
    const t0 = Date.now();
    expect(() => openDatabase(path)).toThrow(/^journal mode: database is locked$/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('processes opening the same fresh index at the same instant all succeed', async () => {
    // Each child opens ROUNDS fresh indexes, one per tick, at the same instants as the others.
    const PROCS = 6;
    const ROUNDS = 60;
    const dir = tmp();
    const child = `
      const { openDatabase } = await import(${JSON.stringify(join(ROOT, 'src/core/db/database.ts'))});
      process.stdout.write('ready\\n');
      process.stdin.once('data', (d) => {
        const t0 = Number(String(d));
        for (let k = 0; k < ${ROUNDS}; k++) {
          while (Date.now() < t0 + k * 40);
          try {
            openDatabase(${JSON.stringify(dir)} + '/' + k + '.db').close();
          } catch (err) {
            process.stdout.write('ERR ' + k + ' ' + err.message + '\\n');
          }
        }
        process.exit(0);
      });`;
    const procs = Array.from({ length: PROCS }, () => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      cleanup.push(() => p.kill());
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
    expect(await Promise.all(procs.map((c) => c.code))).toEqual(Array(PROCS).fill(0));
    expect(
      procs.flatMap((c) =>
        c
          .out()
          .split('\n')
          .filter((l) => l.startsWith('ERR')),
      ),
    ).toEqual([]);
  });
});
