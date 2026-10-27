// AUDIT-35: performance under load (round 9). Each `it.fails` asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-35.md (IDs A35-xx) and currently fails; a fix flips it to
// `it`. Plain `it` blocks pin what held after SG120/SG130/SG135. Like AUDIT-26/30, these tests count
// work (integrity checks run) or order events; the one wall-clock bound has a wide margin (1.5 s
// against a 3 s wait), and the timings live in AUDIT-35.md.
//
// A "killed writer" image is an index copied with its own WAL and `-shm` while the writer still had
// them open, before any checkpoint: what SIGKILL, an OOM kill or a crash leaves. Its WAL belongs to
// the file, so `checkLeftoverWal` keeps it after a full `PRAGMA integrity_check`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';

const ROOT = resolve(__dirname, '../..');
const DB_TS = JSON.stringify(join(ROOT, 'src/core/db/database.ts'));

let dir: string;
let seq = 0;
const fresh = (): string => join(dir, `i${seq++}.db`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit35-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Counts the full integrity checks `openDatabase` runs (`PRAGMA integrity_check(1)`). */
function integrityChecks(): { count: () => number; stop: () => void } {
  const proto = Database.prototype as unknown as { pragma: (...a: unknown[]) => unknown };
  const spy = vi.spyOn(proto, 'pragma');
  return {
    count: () => spy.mock.calls.filter((c) => /integrity_check/.test(String(c[0]))).length,
    stop: () => spy.mockRestore(),
  };
}

/** An index with 2,000 rows, closed cleanly (no `-wal`). */
function populated(): string {
  const path = fresh();
  const db = openDatabase(path);
  const ins = db.prepare(
    "INSERT INTO files (path, language, content_hash, loc, indexed_at) VALUES (?, 'typescript', 'h', 1, 'x')",
  );
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) ins.run(`src/f${i}.ts`);
  })();
  closeDatabase(db);
  expect(existsSync(`${path}-wal`)).toBe(false);
  return path;
}

/** A killed writer's image at a new path: `index.db` with its own uncheckpointed WAL and `-shm`. */
function killedWriterImage(): string {
  const src = populated();
  const db = openDatabase(src);
  db.pragma('wal_autocheckpoint = 0');
  db.prepare("UPDATE files SET content_hash = 'h2' WHERE id % 3 = 0").run();
  const dst = fresh();
  for (const f of ['', '-wal', '-shm']) copyFileSync(src + f, dst + f);
  closeDatabase(db);
  return dst;
}

/**
 * No crash: a writer commits and closes while a read-only connection (the dashboard) is open, so
 * the writer is not the last connection and leaves its WAL; then the reader closes, which cannot
 * checkpoint. Every process has exited cleanly, and a WAL is left.
 */
function writerBesideDashboard(): string {
  const path = populated();
  const reader = openDatabase(path, { readonly: true, fileMustExist: true });
  reader.prepare('SELECT count(*) FROM files').get();
  const writer = openDatabase(path);
  writer.prepare("UPDATE files SET content_hash = 'h3' WHERE id < 50").run();
  closeDatabase(writer);
  closeDatabase(reader);
  return path;
}

const walBytes = (path: string): number =>
  statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0;

/** Opens and closes `path` read-only (as `atlas serve` does) `n` times; returns the checks run. */
function readOnlyOpens(path: string, n: number): number {
  const checks = integrityChecks();
  try {
    for (let i = 0; i < n; i++) {
      const db = openDatabase(path, { readonly: true, fileMustExist: true });
      db.prepare('SELECT count(*) FROM files').get();
      closeDatabase(db);
    }
    return checks.count();
  } finally {
    checks.stop();
  }
}

describe('A35-01 (low) a WAL that passed the check is checked again by every read-only open', () => {
  // Measured (AUDIT-35.md): each check costs a full integrity scan, 0.10 s at 10k symbols, 0.34 s at
  // 46k, 1.1 s at 153k (realistic 10k) and 1.6 s on dense 10k; `atlas serve` restarts 0.27 s →
  // 0.58–0.64 s on realistic 3k every time; 8/16 concurrent read-only openers run 8/16 checks in turn.
  it.fails('after a crash, three read-only opens run the integrity check at most once', () => {
    const path = killedWriterImage();
    expect(readOnlyOpens(path, 3)).toBeLessThanOrEqual(1);
  });

  it.fails(
    'with no crash (an index written while the dashboard was open), three read-only opens run it at most once',
    () => {
      const path = writerBesideDashboard();
      expect(readOnlyOpens(path, 3)).toBeLessThanOrEqual(1);
    },
  );

  // Preconditions of the two `it.fails` above, and today's count (so they fail for the right reason).
  it('precondition: both images keep a WAL, pass the check, and are checked once per read-only open today', () => {
    const crashed = killedWriterImage();
    const served = writerBesideDashboard();
    for (const path of [crashed, served]) {
      expect(walBytes(path)).toBeGreaterThan(32);
      expect(readOnlyOpens(path, 3)).toBe(3);
      expect(walBytes(path)).toBeGreaterThan(32); // read-only opens never clear it
    }
  });

  it('held: a writable open checks once, and its close clears the WAL so the next open checks nothing', () => {
    const path = killedWriterImage();
    const checks = integrityChecks();
    try {
      const db = openDatabase(path, { fileMustExist: true });
      expect(checks.count()).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM files WHERE content_hash = 'h2'").get()).toEqual(
        {
          n: 666,
        },
      ); // the WAL's commits were kept
      closeDatabase(db);
      expect(existsSync(`${path}-wal`)).toBe(false);
      closeDatabase(openDatabase(path, { fileMustExist: true }));
      closeDatabase(openDatabase(path, { readonly: true, fileMustExist: true }));
      expect(checks.count()).toBe(1);
    } finally {
      checks.stop();
    }
  });

  it('held: an open beside a live writer (its WAL in use) runs no integrity check', () => {
    const path = populated();
    const live = openDatabase(path);
    try {
      live.prepare("UPDATE files SET content_hash = 'h4' WHERE id < 10").run();
      expect(walBytes(path)).toBeGreaterThan(32);
      const checks = integrityChecks();
      try {
        for (let i = 0; i < 3; i++) {
          closeDatabase(openDatabase(path, { fileMustExist: true }));
          closeDatabase(openDatabase(path, { readonly: true, fileMustExist: true }));
        }
        expect(checks.count()).toBe(0);
      } finally {
        checks.stop();
      }
    } finally {
      closeDatabase(live);
    }
  });
});

/**
 * A child (`node --import tsx`) that opens `path`, installs `closeOnSignal` as `atlas index`, `docs`
 * and `mcp` do, prints `ready`, then (with `wait`) waits in `immediate` for the write lock the
 * parent holds. Resolves with the ms from SIGTERM to exit and how it ended.
 */
async function stopChild(
  path: string,
  wait: boolean,
): Promise<{ ms: number; signal: string | null }> {
  const code = `const m = await import(${DB_TS});
const db = m.openDatabase(${JSON.stringify(path)});
m.closeOnSignal(db);
process.stdout.write('ready\\n');
${wait ? 'm.immediate(db, () => 1);' : ''}
setInterval(() => {}, 1e6);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const exited = new Promise<{ at: number; signal: string | null }>((ok) =>
      child.once('exit', (_c, signal) => ok({ at: performance.now(), signal })),
    );
    await new Promise<void>((ok) => child.stdout!.once('data', () => ok()));
    await new Promise((r) => setTimeout(r, 300));
    const t = performance.now();
    child.kill('SIGTERM');
    const { at, signal } = await exited;
    return { ms: at - t, signal };
  } finally {
    child.kill('SIGKILL');
  }
}

describe('A35-02 (medium) SIGINT/SIGTERM wait for the current synchronous block (SG120)', () => {
  // Measured (AUDIT-35.md): before SG120 the default action ended the process in 7–80 ms. Now the
  // handler runs only when the event loop is free: after a lock wait (up to the 5 s busy timeout) or
  // the resolve block (A22-01: SIGINT 0.3 s into a dense 10k resolve exits after 10.4 s, was 29 ms),
  // repeated Ctrl-C does not help, and close then checkpoints (0.4 s for a 4.9 MB WAL, 2.0 s for 257 MB).
  it.fails(
    'a process waiting for the write lock ends within 1.5 s of SIGTERM',
    async () => {
      const path = populated();
      const holder = new Database(path, { timeout: 0 });
      holder.exec('BEGIN IMMEDIATE');
      const release = setTimeout(() => holder.exec('COMMIT'), 3000);
      try {
        const { ms, signal } = await stopChild(path, true);
        expect(signal).toBe('SIGTERM');
        expect(ms).toBeLessThan(1500);
      } finally {
        clearTimeout(release);
        if (holder.inTransaction) holder.exec('COMMIT');
        holder.close();
      }
    },
    20_000,
  );

  it('held: an idle process ends by SIGTERM within 1.5 s and leaves no -wal', async () => {
    const path = populated();
    const { ms, signal } = await stopChild(path, false);
    expect(signal).toBe('SIGTERM');
    expect(ms).toBeLessThan(1500);
    expect(existsSync(`${path}-wal`)).toBe(false);
  }, 20_000);
});
