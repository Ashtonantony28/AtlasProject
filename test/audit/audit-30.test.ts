// AUDIT-30: performance under load (round 8). Each test asserts the CORRECT (bounded) behaviour
// for one finding in AUDIT-30.md (IDs A30-xx), or pins what held after SG90 and under SG80 load.
// `it.fails` marks a defect that is still present; a fix flips it to `it`. Like AUDIT-22 and
// AUDIT-26, these tests count work or order events; the wall-clock bounds are generous, and the
// timings live in AUDIT-30.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { immediate } from '../../src/core/db/database.js';
import { lockHolder } from '../helpers/lockHolder.js';

let dir: string;
let seq = 0;
const fresh = (): string => join(dir, `i${seq++}.db`);

/** Counts `db.pragma` calls whose text matches `re` (journal-mode switch attempts, lock polls). */
function pragmaCounter(re: RegExp): { count: () => number; stop: () => void } {
  const proto = Database.prototype as unknown as { pragma: (...a: unknown[]) => unknown };
  const spy = vi.spyOn(proto, 'pragma');
  return {
    count: () => spy.mock.calls.filter((c) => re.test(String(c[0]))).length,
    stop: () => spy.mockRestore(),
  };
}

/**
 * Leaves at `path` what a killed run leaves after the user deletes `index.db`: a `-wal` of about
 * `mb` MB (never checkpointed) and its `-shm`.
 */
function leftoverWal(path: string, mb: number): number {
  const db = openDatabase(path);
  db.pragma('wal_autocheckpoint = 0');
  const ins = db.prepare(
    "INSERT INTO files (path, language, content_hash, loc, indexed_at) VALUES (?, 'typescript', 'h', 1, 'x')",
  );
  const pad = 'x'.repeat(900);
  let i = 0;
  while ((statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0) < mb * 2 ** 20) {
    db.transaction(() => {
      for (let k = 0; k < 500; k++) ins.run(`${pad}${i++}`);
    })();
  }
  for (const f of ['-wal', '-shm']) copyFileSync(path + f, `${path}${f}.saved`);
  closeDatabase(db);
  rmSync(path);
  for (const f of ['-wal', '-shm']) {
    copyFileSync(`${path}${f}.saved`, path + f);
    rmSync(`${path}${f}.saved`);
  }
  return statSync(`${path}-wal`).size;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit30-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AUDIT-30 performance under load', () => {
  // Held (SG90): a first open beside a stale WAL switches the empty file to WAL once and SQLite
  // deletes the stale WAL without reading it, so the cost does not grow with the WAL's size
  // (measured: 4.3 MB and 67 MB stale WALs open in the same time as no WAL, AUDIT-30.md).
  it('SG90: a first open beside a stale WAL switches once and comes up fresh', () => {
    const path = fresh();
    const walBytes = leftoverWal(path, 8);
    expect(walBytes).toBeGreaterThan(8 * 2 ** 20);
    const switches = pragmaCounter(/^journal_mode\s*=/);
    let db: DB;
    let tries: number;
    const t0 = performance.now();
    try {
      db = openDatabase(path);
      tries = switches.count();
    } finally {
      switches.stop();
    }
    const ms = performance.now() - t0;
    try {
      // One switch attempt, no retry, when nobody races the open.
      expect(tries).toBe(1);
      expect(counts(db).files).toBe(0);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      // The stale WAL was dropped, not replayed or kept.
      expect(statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBeLessThan(walBytes);
      expect(ms).toBeLessThan(2000);
    } finally {
      closeDatabase(db);
    }
  });

  // Held (SG90): `switchToWal` waits for a racing opener by sleeping 10 ms per try
  // (`Atomics.wait`), not by spinning: a 1 s wait makes about 1 s / 10 ms tries and uses little
  // CPU (measured 6-30 ms of CPU per second waited, AUDIT-30.md).
  it('SG90: waiting to switch an empty file to WAL polls every ~10 ms and sleeps', async () => {
    const path = fresh();
    const holder = await lockHolder(path); // creates the 0-byte file, rollback mode
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
    const switches = pragmaCounter(/^journal_mode\s*=/);
    try {
      holder.hold(1000);
      const t0 = Date.now();
      const cpu0 = process.cpuUsage();
      const db = openDatabase(path);
      const cpu = process.cpuUsage(cpu0);
      const waited = Date.now() - t0;
      closeDatabase(db);
      expect(waited).toBeGreaterThan(800);
      // About waited / 10 ms tries plus the first; far fewer than a busy loop would make.
      expect(switches.count()).toBeGreaterThan(5);
      expect(switches.count()).toBeLessThanOrEqual(Math.ceil(waited / 10) + 2);
      // The opening (CPU includes the opening's own sqlite-vec load and migrations).
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(400);
    } finally {
      switches.stop();
      await holder.close();
    }
  });

  // Held (SG80): an `immediate` wait sleeps too; re-measured under load (AUDIT-26 pinned it).
  it('SG80: a 1 s wait for the write lock uses little CPU', async () => {
    const path = fresh();
    const db = openDatabase(path);
    const holder = await lockHolder(path);
    try {
      holder.hold(1000);
      const t0 = Date.now();
      const cpu0 = process.cpuUsage();
      immediate(db, () => db.prepare('CREATE TABLE IF NOT EXISTS t (x)').run());
      const cpu = process.cpuUsage(cpu0);
      expect(Date.now() - t0).toBeGreaterThan(800);
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(300);
    } finally {
      await holder.close();
      closeDatabase(db);
    }
  });

  // A30-01: `switchToWal` retries SQLITE_BUSY only while the file is still empty, and it checks
  // the size AFTER the failed try. When two processes switch the same 0-byte file (the SG90 path
  // beside a stale WAL), the loser's try fails at once (lock upgrade refused), and by the time it
  // stats the file the winner has written page 1 (4,096 bytes), so the loser throws `journal mode:
  // database is locked` instead of retrying. Measured: 2 of 320 opens failed in a 16-process
  // lockstep race (waitload.mjs switch 500 16), size 4096 at the failure. The racer is simulated
  // here: on our first try, another connection switches the file and our try reports SQLITE_BUSY.
  it.fails('A30-01: an opener that loses the race to switch an empty file to WAL retries', () => {
    const path = fresh();
    writeFileSync(path, ''); // what SQLite leaves when it discards a stale WAL beside a deleted index
    const racer = new Database(path);
    const proto = Database.prototype as unknown as {
      pragma: (this: unknown, src: string, opts?: unknown) => unknown;
    };
    const orig = proto.pragma;
    let raced = false;
    const spy = vi.spyOn(proto, 'pragma').mockImplementation(function (
      this: unknown,
      src: string,
      opts?: unknown,
    ) {
      if (!raced && this !== racer && /^journal_mode\s*=/.test(src)) {
        raced = true;
        orig.call(racer, 'journal_mode = WAL'); // the winner switches (and writes page 1) first
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return orig.call(this, src, opts);
    });
    let db: DB | undefined;
    try {
      db = openDatabase(path);
      expect(raced).toBe(true);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      spy.mockRestore();
      db?.close();
      racer.close();
    }
  });

  // Held (precondition of A30-01): the winner's switch of an empty file writes page 1 at once, so
  // the loser's post-failure size check sees a non-empty file.
  it('switching an empty file to WAL makes it non-empty at once', () => {
    const path = fresh();
    writeFileSync(path, '');
    const db = new Database(path);
    try {
      expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
      expect(statSync(path).size).toBe(4096);
    } finally {
      db.close();
    }
  });
});
