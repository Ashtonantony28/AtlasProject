// AUDIT-40: performance under load (round 10). Each `it.fails` asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-40.md (IDs A40-xx) and currently fails; a fix flips it to
// `it`. Plain `it` blocks pin what held after SG150. Like AUDIT-35, these tests count work
// (integrity checks run, bytes read with plain reads) rather than time it; the timings live in
// AUDIT-40.md.
//
// A "restored backup" image is an index whose file was replaced by an older copy of itself while a
// killed writer's WAL (written on the newer file) stayed beside it: the WAL does not fit, and
// `PRAGMA integrity_check` reports it as a row ("row N missing from index …"), not as an I/O error.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs, { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';

let dir: string;
let seq = 0;
const fresh = (): string => join(dir, `i${seq++}.db`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit40-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Counts the integrity checks `openDatabase` runs and the bytes it reads with `readSync`. */
function meter(): { checks: () => number; bytes: () => number; stop: () => void } {
  const proto = Database.prototype as unknown as { pragma: (...a: unknown[]) => unknown };
  const spy = vi.spyOn(proto, 'pragma');
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = ((...a: Parameters<typeof fs.readSync>) => {
    const n = orig(...a);
    bytes += n;
    return n;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  return {
    checks: () => spy.mock.calls.filter((c) => /integrity_check/.test(String(c[0]))).length,
    bytes: () => bytes,
    stop: () => {
      spy.mockRestore();
      fs.readSync = orig;
      syncBuiltinESMExports();
    },
  };
}

/** An index with 2,000 `files` rows, closed cleanly (no `-wal`). */
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

/**
 * A restored backup beside a killed writer's WAL: the backup is taken, the live file is written and
 * checkpointed (the last rows change an indexed column), then a writer commits to every row without
 * a checkpoint and its WAL and `-shm` are copied beside the backup, as SIGKILL leaves them.
 */
function restoredBackup(withShm = true): string {
  const live = populated();
  const backup = fresh();
  copyFileSync(live, backup);
  const later = openDatabase(live);
  later.prepare("UPDATE files SET language = 'python' WHERE id > 1980").run();
  closeDatabase(later);
  const writer = openDatabase(live);
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare("UPDATE files SET content_hash = 'h2'").run();
  copyFileSync(`${live}-wal`, `${backup}-wal`);
  if (withShm) copyFileSync(`${live}-shm`, `${backup}-shm`);
  closeDatabase(writer);
  return backup;
}

/** A killed writer's own image: its WAL fits the file and passes the check. */
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

const indexAndWal = (path: string): number => statSync(path).size + statSync(`${path}-wal`).size;
const aside = (path: string): string[] =>
  readdirSync(dirname(path)).filter((f) => f.startsWith(`${basename(path)}-wal.foreign-`));

/** Opens `path` (writable unless `ro`); returns the error message, if the open was refused. */
function tryOpen(path: string, ro = false): string | undefined {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write; // set-aside notices
  try {
    closeDatabase(openDatabase(path, ro ? { readonly: true, fileMustExist: true } : {}));
    return undefined;
  } catch (err) {
    return (err as Error).message;
  } finally {
    process.stderr.write = write;
  }
}

describe('A40-01 (low) a WAL that fails the check is checked twice and the index and WAL are read in full (SG150)', () => {
  // Measured (AUDIT-40.md): realistic 10k beside a 27 MB restored-backup WAL 0.38 → 0.78 s per open;
  // dense 10k 0.60 → 1.27 s; a rebuilt index beside a 332 MB WAL 0.18 → 0.48 s (ro), 0.19 → 0.52 s
  // (rw); `atlas serve` start 0.51 → 0.77 s, `atlas mcp` 0.66 → 0.85 s. Once per foreign WAL (it is
  // set aside).
  it.fails(
    'a WAL whose check reports a corrupt row (no I/O error code) is decided with one check',
    () => {
      const path = restoredBackup();
      const m = meter();
      try {
        expect(tryOpen(path)).toBeUndefined();
        expect(m.checks()).toBeLessThanOrEqual(1);
      } finally {
        m.stop();
      }
    },
  );

  it('precondition: the image is foreign, set aside once, after two checks and a full read today', () => {
    const path = restoredBackup();
    const size = indexAndWal(path);
    const m = meter();
    try {
      expect(tryOpen(path)).toBeUndefined();
      expect(m.checks()).toBe(2);
      expect(m.bytes()).toBeGreaterThanOrEqual(size);
      expect(aside(path)).toHaveLength(1);
      expect(tryOpen(path, true)).toBeUndefined(); // the next open decides nothing
      expect(m.checks()).toBe(2);
    } finally {
      m.stop();
    }
  });

  it('held: a WAL that passes the check costs one check and no full read, as before SG150', () => {
    const path = killedWriterImage();
    const size = indexAndWal(path);
    const m = meter();
    try {
      expect(tryOpen(path, true)).toBeUndefined();
      expect(m.checks()).toBe(1);
      expect(m.bytes()).toBeLessThan(size / 10);
    } finally {
      m.stop();
    }
  });
});

describe('A40-02 (low) a refused open repeats the doubled check and the full read on every open', () => {
  // Measured (AUDIT-40.md): with no `-shm` the WAL cannot be set aside, so every open is refused
  // after the whole decision. 16 concurrent `atlas serve`-style opens: realistic 10k max 6.7 → 12.9 s,
  // dense 10k 10.6 → 20.7 s, 4.9–10 GB read in all; each sequential refusal 0.42 → 0.80 s (realistic).
  it.fails('three refused opens of the same image run at most two integrity checks', () => {
    const path = restoredBackup(false);
    const m = meter();
    try {
      for (let i = 0; i < 3; i++) expect(tryOpen(path, true)).toMatch(/malformed/);
      expect(m.checks()).toBeLessThanOrEqual(2);
    } finally {
      m.stop();
    }
  });

  it('precondition: each refusal runs two checks and reads the index and WAL in full today', () => {
    const path = restoredBackup(false);
    const size = indexAndWal(path);
    const m = meter();
    try {
      for (let i = 0; i < 3; i++) expect(tryOpen(path, true)).toMatch(/malformed/);
      expect(m.checks()).toBe(6);
      expect(m.bytes()).toBeGreaterThanOrEqual(3 * size);
      expect(aside(path)).toEqual([]);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(32); // kept
    } finally {
      m.stop();
    }
  });
});
