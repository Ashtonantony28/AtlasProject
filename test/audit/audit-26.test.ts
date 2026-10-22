// AUDIT-26: performance under load (round 7). Each test asserts the CORRECT (bounded) behaviour
// for one finding in AUDIT-26.md (IDs A26-xx), or pins what held after SG65 and SG80. `it.fails`
// marks a defect that is still present; a fix flips it to `it`. Like AUDIT-18 and AUDIT-22, these
// tests count work or order events; the two wall-clock bounds are generous, and the timings live
// in AUDIT-26.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { immediate } from '../../src/core/db/database.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { lockHolder } from '../helpers/lockHolder.js';

let dir: string;
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** `files` TS modules; each calls a function of the previous one. */
function writeRepo(root: string, files: number): void {
  for (let f = 0; f < files; f++) {
    const L: string[] = [];
    if (f > 0) L.push(`import { f${f - 1} } from './m${f - 1}.js';`);
    L.push(`/** Doc ${f}. */`);
    L.push(`export function f${f}(x: number): number {`);
    L.push(`  return x + ${f > 0 ? `f${f - 1}(x)` : '1'};`);
    L.push('}');
    write(join(root, `src/m${f}.ts`), L.join('\n') + '\n');
  }
}

/** Counts `db.pragma` calls: `immediate` sets and restores `busy_timeout` once per transaction. */
function pragmaCounter(): { count: () => number; stop: () => void } {
  const proto = Database.prototype as unknown as { pragma: (...a: unknown[]) => unknown };
  const spy = vi.spyOn(proto, 'pragma');
  return {
    count: () => spy.mock.calls.filter((c) => /^busy_timeout\s*=/.test(String(c[0]))).length,
    stop: () => spy.mockRestore(),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit26-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AUDIT-26 performance under load', () => {
  // A26-01: SG80's `immediate` waits for another connection's write lock by retrying BEGIN
  // IMMEDIATE synchronously (10 ms busy handler, up to 5 s), so an index run in the MCP server
  // freezes the whole process for as long as each write transaction waits: an atlas_search waited
  // 4,970 ms behind one 5 s hold, and the server answered nothing for 95% of a run against a
  // writer holding 4 s of every 4.2 s. Bounded: while an index run waits ~300 ms for the lock, the
  // event loop still turns (no gap of 100 ms or more).
  it.fails('A26-01: an index run waiting for another writer keeps the event loop turning', async () => {
    const root = join(dir, 'wait');
    writeRepo(root, 6);
    const path = join(dir, 'wait.db');
    const db: DB = openDatabase(path);
    const holder = await lockHolder(path);
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      let parsed = 0;
      let heldAt = 0;
      await indexRepo(db, root, {
        force: true,
        skipEmbeddings: true,
        onFile: () => {
          if (++parsed !== 1) return;
          holder.hold(300);
          heldAt = Date.now();
          last = performance.now();
          maxGap = 0;
        },
      });
      // The run did wait out the hold (SG80 holds) ...
      expect(Date.now() - heldAt).toBeGreaterThan(250);
      expect(counts(db).edges).toBeGreaterThan(0);
      // ... but today the next file's `immediate` holds the event loop for the whole wait (~300 ms).
      expect(maxGap).toBeLessThan(100);
    } finally {
      clearInterval(timer);
      await holder.close();
      closeDatabase(db);
    }
  });

  // Held (SG80): uncontended, `immediate` costs one BEGIN IMMEDIATE and one busy_timeout set and
  // restore per write transaction, with no retry: an index run's lock work is linear in its files
  // (+17–26 µs per transaction measured, under 0.3 s of a 66 s 10k run).
  it('SG80: an uncontended index run takes the write lock once per file, with no retries', async () => {
    const root = join(dir, 'linear');
    const files = 40;
    writeRepo(root, files);
    const db: DB = openDatabase(join(dir, 'linear.db'));
    const pragmas = pragmaCounter();
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      // 2 per transaction: run stamp, one per file, resolve, finish stamp.
      expect(pragmas.count()).toBe(2 * (files + 3));
    } finally {
      pragmas.stop();
      closeDatabase(db);
    }
  });

  // Held (SG80): prune's per-file `deleteFile` runs as savepoints inside prune's one transaction,
  // so removing N files takes the write lock once, not N times.
  it('SG80: pruning many files takes the write lock once', async () => {
    const root = join(dir, 'prune');
    const files = 60;
    writeRepo(root, files);
    const db: DB = openDatabase(join(dir, 'prune.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      for (let f = 10; f < files; f++) rmSync(join(root, `src/m${f}.ts`));
      const pragmas = pragmaCounter();
      try {
        const stats = await indexRepo(db, root, { skipEmbeddings: true });
        expect(stats.filesRemoved).toBe(files - 10);
        // run stamp, prune, resolve, finish stamp; the 50 nested deleteFile calls take no lock.
        expect(pragmas.count()).toBe(2 * 4);
      } finally {
        pragmas.stop();
      }
    } finally {
      closeDatabase(db);
    }
  });

  // Held (SG80): the busy wait sleeps in SQLite's busy handler; it does not spin. A 1 s wait used
  // 10–20 ms of CPU in the measurements (AUDIT-26.md), bounded here at 300 ms.
  it('SG80: waiting for the lock sleeps rather than spinning the CPU', async () => {
    const path = join(dir, 'cpu.db');
    const db: DB = openDatabase(path);
    const holder = await lockHolder(path);
    try {
      holder.hold(1000);
      const t0 = Date.now();
      const cpu0 = process.cpuUsage();
      immediate(db, () => db.prepare('CREATE TABLE IF NOT EXISTS t (x)').run());
      const cpu = process.cpuUsage(cpu0);
      expect(Date.now() - t0).toBeGreaterThan(800);
      // The holder is a worker thread of this process; it is idle while it holds the lock.
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(300);
    } finally {
      await holder.close();
      closeDatabase(db);
    }
  });

  // Held: a read-only connection (`atlas serve`, MCP reads) never waits on the write lock in WAL
  // mode, also while a writer holds it past the busy timeout.
  it('reads on a read-only connection do not wait while another connection holds the write lock', async () => {
    const root = join(dir, 'reads');
    writeRepo(root, 10);
    const path = join(dir, 'reads.db');
    const db: DB = openDatabase(path);
    await indexRepo(db, root, { skipEmbeddings: true });
    closeDatabase(db);
    const ro: DB = openDatabase(path, { readonly: true, fileMustExist: true });
    const holder = await lockHolder(path);
    try {
      holder.hold(600);
      const t0 = Date.now();
      expect(counts(ro).symbols).toBeGreaterThan(0);
      expect(ro.prepare('SELECT COUNT(*) FROM edges').pluck().get()).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      await holder.close();
      closeDatabase(ro);
    }
  });
});
