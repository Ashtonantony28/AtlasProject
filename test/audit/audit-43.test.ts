// AUDIT-43: performance under load (round 11). Each `it.fails` asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-43.md (IDs A43-xx) and currently fails; a fix flips it to
// `it`. Plain `it` blocks pin what held after SG190. Like AUDIT-35/40, these tests count work
// (`/proc/locks` reads, probes, open-lock takes, integrity checks) rather than time it; the timings
// live in AUDIT-43.md.
//
// A "set-aside" image is a clean index beside `<db>-wal.foreign-<ms>-<size>-<mtimeNs>` naming the
// index's current size and mtime: what `setAside` leaves until the index is written again. While it
// matches, `reportAside` offers the move-back, and since SG190 asks `inUse` first.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs, { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';

let dir: string;
let seq = 0;
const fresh = (): string => join(dir, `i${seq++}.db`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit43-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Meter {
  procReads: () => number;
  probes: () => number;
  openLocks: () => number;
  checks: () => number;
  stop: () => void;
}

/**
 * Counts what `openDatabase` does: reads of `/proc/locks` (`holders`), probes (hard links named
 * `*.probe`), takes of `<db>.open.lock` (`BEGIN EXCLUSIVE`) and integrity checks. With `noProc`,
 * `/proc/locks` cannot be read, as on macOS, the BSDs or another pid namespace.
 */
function meter(noProc = false): Meter {
  const proto = Database.prototype as unknown as {
    pragma: (...a: unknown[]) => unknown;
    exec: (...a: unknown[]) => unknown;
  };
  const pragma = vi.spyOn(proto, 'pragma');
  const exec = vi.spyOn(proto, 'exec');
  const read = fs.readFileSync;
  const link = fs.linkSync;
  let procReads = 0;
  let probes = 0;
  fs.readFileSync = ((...a: Parameters<typeof fs.readFileSync>) => {
    if (a[0] === '/proc/locks') {
      procReads++;
      if (noProc) throw Object.assign(new Error('ENOENT: /proc/locks'), { code: 'ENOENT' });
    }
    return read(...a);
  }) as typeof fs.readFileSync;
  fs.linkSync = ((...a: Parameters<typeof fs.linkSync>) => {
    if (String(a[1]).endsWith('.probe')) probes++;
    return link(...a);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  return {
    procReads: () => procReads,
    probes: () => probes,
    openLocks: () => exec.mock.calls.filter((c) => c[0] === 'BEGIN EXCLUSIVE').length,
    checks: () => pragma.mock.calls.filter((c) => /integrity_check/.test(String(c[0]))).length,
    stop: () => {
      pragma.mockRestore();
      exec.mockRestore();
      fs.readFileSync = read;
      fs.linkSync = link;
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

/** A clean index beside a set-aside WAL that still matches it (the move-back is offered). */
function setAsideImage(): string {
  const path = populated();
  const st = statSync(path, { bigint: true });
  writeFileSync(`${path}-wal.foreign-${Date.now()}-${st.size}-${st.mtimeNs}`, Buffer.alloc(4096));
  return path;
}

/** `n` read-only opens of `path`, as `atlas serve` opens it; returns the stderr text. */
function readOnlyOpens(path: string, n: number): string {
  const write = process.stderr.write;
  let text = '';
  process.stderr.write = ((s: string) => {
    text += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    for (let i = 0; i < n; i++) closeDatabase(openDatabase(path, { readonly: true, fileMustExist: true }));
  } finally {
    process.stderr.write = write;
  }
  return text;
}

describe('A43-01 (low) every open beside a set-aside WAL that still matches the index reads /proc/locks, or probes under the open lock (SG190)', () => {
  // Measured (AUDIT-43.md): realistic 10k, one read-only open 5.7 → 22.2 ms p50 (the read waits in
  // the kernel, not on the CPU); 30,000 host locks 5.4 → 211 ms; 32 concurrent openers p50
  // 18.6–24.6 → 62–74 ms. Without /proc/locks every opener takes `.open.lock` and probes: 32
  // concurrent max 0.04–0.06 → 0.18–2.0 s, 64 concurrent 0.24–0.31 → 0.40–1.47 s.
  it.fails('three opens beside a matching set-aside WAL read /proc/locks no more than three plain opens (0)', () => {
    const path = setAsideImage();
    const m = meter();
    try {
      expect(readOnlyOpens(path, 3)).toMatch(/move it back/);
      expect(m.procReads()).toBe(0);
    } finally {
      m.stop();
    }
  });

  it.fails('without /proc/locks, three such opens take no open lock and run no probe', () => {
    const path = setAsideImage();
    const m = meter(true);
    try {
      expect(readOnlyOpens(path, 3)).toMatch(/move it back/);
      expect(m.openLocks() + m.probes()).toBe(0);
    } finally {
      m.stop();
    }
  });

  it('precondition: each open reads /proc/locks once today; without it, each takes the open lock and probes', () => {
    const path = setAsideImage();
    let m = meter();
    try {
      expect(readOnlyOpens(path, 3)).toMatch(/move it back/);
      expect(m.procReads()).toBe(3);
      expect(m.probes()).toBe(0);
      expect(m.checks()).toBe(0);
    } finally {
      m.stop();
    }
    m = meter(true);
    try {
      readOnlyOpens(path, 3);
      expect(m.openLocks()).toBe(3);
      expect(m.probes()).toBe(3);
    } finally {
      m.stop();
    }
  });

  it('held: a plain open, and an open beside a set-aside WAL the index has outgrown, read nothing', () => {
    const plain = populated();
    const stale = populated();
    const st = statSync(stale);
    writeFileSync(`${stale}-wal.foreign-${Date.now()}-${st.size + 1}-1`, Buffer.alloc(4096));
    const m = meter();
    try {
      readOnlyOpens(plain, 3);
      expect(readOnlyOpens(stale, 3)).toMatch(/delete it/);
      expect(m.procReads() + m.probes() + m.openLocks()).toBe(0);
    } finally {
      m.stop();
    }
  });
});

describe('A43-02 (low) an idle `atlas serve` now keeps a writer from clearing its WAL, so every later serve start runs the full check (SG190, A35-01 widened)', () => {
  // Measured (AUDIT-43.md): `atlas serve` started and never queried, one file edited and `atlas
  // index` run, serve stopped: the 27.9 MB WAL stays (before SG190 it was removed), and every later
  // `atlas serve` start at realistic 10k takes 1.28–1.45 s instead of 0.34–0.42 s; CLI opens while
  // the idle dashboard runs read /proc/locks (8–10 → 23–26 ms at 10k symbols).
  /** Writer commits and closes beside an idle read-only connection (opened, never queried). */
  function writerBesideIdleDashboard(): string {
    const path = populated();
    const idle = openDatabase(path, { readonly: true, fileMustExist: true });
    const writer = openDatabase(path);
    writer.prepare("UPDATE files SET content_hash = 'h3' WHERE id < 50").run();
    closeDatabase(writer);
    closeDatabase(idle);
    return path;
  }

  it.fails('after a writer closes beside an idle dashboard, three read-only opens run at most one check', () => {
    const path = writerBesideIdleDashboard();
    const m = meter();
    try {
      readOnlyOpens(path, 3);
      expect(m.checks()).toBeLessThanOrEqual(1);
    } finally {
      m.stop();
    }
  });

  it('precondition: the idle connection keeps the WAL, and each read-only open checks it again today', () => {
    const path = writerBesideIdleDashboard();
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
    const m = meter();
    try {
      readOnlyOpens(path, 3);
      expect(m.checks()).toBe(3);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
    } finally {
      m.stop();
    }
  });

  it('held: with no other connection, the writer clears its WAL and the next opens check nothing', () => {
    const path = populated();
    const writer = openDatabase(path);
    writer.prepare("UPDATE files SET content_hash = 'h3' WHERE id < 50").run();
    closeDatabase(writer);
    expect(existsSync(`${path}-wal`)).toBe(false);
    const m = meter();
    try {
      readOnlyOpens(path, 3);
      expect(m.checks()).toBe(0);
    } finally {
      m.stop();
    }
  });
});
