// AUDIT-22: performance under load (round 6). Each test asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-22.md (IDs A22-xx, plus re-checked A18-xx). `it.fails`
// marks a defect that is still present; a fix flips it to `it`. Like AUDIT-14 and AUDIT-18,
// these tests count work or order events, not time; the timings live in AUDIT-22.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

let dir: string;
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** `files` TS modules of `fns` functions; each calls two siblings and a function of the previous module. */
function writeDenseRepo(root: string, files: number, fns: number): void {
  for (let f = 0; f < files; f++) {
    const L: string[] = [];
    if (f > 0) L.push(`import { f${f - 1}_0, f${f - 1}_1 } from './m${f - 1}.js';`);
    for (let i = 0; i < fns; i++) {
      const a = `f${f}_${(i + 1) % fns}`;
      const b = `f${f}_${(i + 2) % fns}`;
      L.push(`/** Doc ${i}. */`);
      L.push(`export function f${f}_${i}(x: number): number {`);
      L.push(`  return ${a}(x) + ${b}(x)${f > 0 ? ` + f${f - 1}_${i % 2}(x)` : ''};`);
      L.push('}');
    }
    write(join(root, `src/m${f}.ts`), L.join('\n') + '\n');
  }
}

/** A generated TS file of `n` 4-line exported functions. */
const generated = (n: number, tag: string): string =>
  Array.from(
    { length: n },
    (_, i) => `/** ${tag} ${i}. */\nexport function ${tag}${i}(x: number): number {\n  return x + ${i};\n}\n`,
  ).join('');

/** Records the setImmediate tick count at each statement execution whose SQL matches. */
function tickProbe(db: DB) {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Database.Statement;
  const seen: { sql: string; tick: number }[] = [];
  let ticks = 0;
  let ticking = true;
  const tick = (): void => {
    ticks++;
    if (ticking) setImmediate(tick);
  };
  const spies = (['run', 'all', 'get', 'iterate'] as const).map((m) => {
    const original = proto[m] as (...a: unknown[]) => unknown;
    return vi.spyOn(proto, m).mockImplementation(function (
      this: Database.Statement,
      ...args: unknown[]
    ) {
      seen.push({ sql: this.source, tick: ticks });
      return original.apply(this, args) as never;
    });
  });
  setImmediate(tick);
  return {
    seen,
    stop: () => {
      ticking = false;
      spies.forEach((s) => s.mockRestore());
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit22-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AUDIT-22 performance under load', () => {
  // A22-01 (A18-02, resolve half): SG55 made the embed phase yield, so the resolve transaction is
  // now the longest event-loop block of every run that re-resolves: 4.2–4.7 s at 10k realistic
  // files, 2.5 s at 3k dense, 11.1–11.3 s at 10k dense; an MCP search during a forced 10k run waited 4.6 s.
  // Bounded: the event loop turns between the resolver reading its inputs (refs) and the last
  // edge it writes, i.e. the resolver yields while it computes.
  it.fails('A22-01: the resolve phase yields between reading refs and writing edges', async () => {
    const root = join(dir, 'resolve');
    writeDenseRepo(root, 40, 50);
    const db: DB = openDatabase(join(dir, 'resolve.db'));
    const probe = tickProbe(db);
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const readRefs = probe.seen.findIndex((s) => /^\s*SELECT[\s\S]*\bFROM refs\b/i.test(s.sql));
      const lastEdge = probe.seen.map((s) => s.sql.startsWith('INSERT INTO edges')).lastIndexOf(true);
      expect(readRefs).toBeGreaterThanOrEqual(0);
      expect(lastEdge).toBeGreaterThan(readRefs);
      expect(counts(db).edges).toBeGreaterThan(5000);
      // Today the whole resolve (read, compute, clear, insert) runs inside one turn.
      expect(probe.seen[lastEdge]!.tick).toBeGreaterThan(probe.seen[readRefs]!.tick);
    } finally {
      probe.stop();
      closeDatabase(db);
    }
  });

  // A22-02 (A18-06, re-rated): carryEdges builds its same-name lists with
  // `[...(fresh.get(k) ?? []), id]`, so re-parsing a file with N symbols of one kind and name
  // copies N²/2 array slots inside the per-file transaction. With SG55's 47 s embed block gone,
  // this is now the longest block on such a file: a 60,000-line `x = i` Python file blocks 28.3 s
  // on `--force` or on any edit (4.7 s with a linear carry). Bounded: the slots copied into the
  // carry's lists are linear in the file's symbols.
  it.fails('A22-02: re-parsing a file of same-name symbols carries edges in linear work', async () => {
    const root = join(dir, 'dups');
    const N = 3000;
    write(join(root, 'pkg/__init__.py'), '');
    write(join(root, 'pkg/big.py'), Array.from({ length: N }, (_, i) => `x = ${i}`).join('\n') + '\n');
    write(join(root, 'pkg/user.py'), 'from pkg.big import x\n\ndef g():\n    return x\n');
    const db: DB = openDatabase(join(dir, 'dups.db'));
    const set = Map.prototype.set;
    let slots = 0;
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      expect(counts(db).edges).toBeGreaterThan(0);
      Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
        if (Array.isArray(v)) slots += v.length;
        return set.call(this, k, v);
      };
      await indexRepo(db, root, { skipEmbeddings: true, force: true });
      Map.prototype.set = set;
      // Today: about N²/2 (4.5M at N = 3000).
      expect(slots).toBeLessThanOrEqual(20 * N);
    } finally {
      Map.prototype.set = set;
      closeDatabase(db);
    }
  });

  // Held (SG55): two generated files embedded in one run split each source a bounded number of
  // times, also when one of them is edited and re-embedded alone.
  it('SG55: each file source is split a bounded number of times, also after an edit', async () => {
    const root = join(dir, 'gen2');
    const a = generated(300, 'op');
    const b = generated(300, 'call');
    write(join(root, 'src/a.generated.ts'), a);
    write(join(root, 'src/b.generated.ts'), b);
    const db: DB = openDatabase(join(dir, 'gen2.db'));
    const proto = String.prototype as { split: (...a: unknown[]) => string[] };
    const original = proto.split;
    const lengths = new Map<number, number>();
    proto.split = function (this: string, ...args: unknown[]) {
      if (args[0] === '\n') lengths.set(this.length, (lengths.get(this.length) ?? 0) + 1);
      return original.apply(this, args);
    };
    try {
      await indexRepo(db, root);
      expect(lengths.get(a.length) ?? 0).toBeLessThanOrEqual(10);
      expect(lengths.get(b.length) ?? 0).toBeLessThanOrEqual(10);
      const edited = `${b}export const tail = 1;\n`;
      write(join(root, 'src/b.generated.ts'), edited);
      lengths.clear();
      const stats = await indexRepo(db, root);
      expect(stats.embeddings).toBeGreaterThanOrEqual(300);
      expect(lengths.get(edited.length) ?? 0).toBeLessThanOrEqual(10);
    } finally {
      proto.split = original;
      closeDatabase(db);
    }
  });

  // Held: repeated forced runs and edits do not grow the vector store. Each forced run gives
  // every symbol a new id, but vec0 reuses its chunks (300 files: 5 chunks after 20 forced
  // runs and after 200 one-file edits; search p50 unchanged).
  it('repeated forced runs keep the vec0 chunk count and row counts stable', async () => {
    const root = join(dir, 'growth');
    writeDenseRepo(root, 10, 40);
    const db: DB = openDatabase(join(dir, 'growth.db'));
    const q = (sql: string): number => db.prepare(sql).pluck().get() as number;
    try {
      await indexRepo(db, root);
      const chunks = q('SELECT COUNT(*) FROM embeddings_vec_chunks');
      const rows = q('SELECT COUNT(*) FROM embeddings_vec_rowids');
      const before = counts(db);
      for (let i = 0; i < 4; i++) await indexRepo(db, root, { force: true });
      expect(q('SELECT COUNT(*) FROM embeddings_vec_chunks')).toBe(chunks);
      expect(q('SELECT COUNT(*) FROM embeddings_vec_rowids')).toBe(rows);
      expect(counts(db)).toEqual(before);
    } finally {
      closeDatabase(db);
    }
  });

  // Held (SG45): opening an up-to-date index takes no write lock, so a second connection opens
  // at once while another holds a write transaction (only pending migrations wait).
  it('SG45: opening an up-to-date index does not wait for a writer', () => {
    const path = join(dir, 'open.db');
    closeDatabase(openDatabase(path));
    const writer = new Database(path);
    writer.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      const db = openDatabase(path);
      closeDatabase(db);
      // A write lock would wait for better-sqlite3's 5 s busy timeout and then throw.
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  // Held (SG34): index calls of one kind made before the run starts share that run.
  it('SG34: four no-op calls made together share one run', async () => {
    const root = join(dir, 'queue');
    writeDenseRepo(root, 5, 5);
    const db: DB = openDatabase(join(dir, 'queue.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const runsBefore = db.prepare('SELECT COUNT(*) FROM runs').pluck().get() as number;
      const calls = [1, 2, 3, 4].map(() => indexRepo(db, root, { skipEmbeddings: true }));
      await Promise.all(calls);
      expect(new Set(calls).size).toBe(1);
      expect(db.prepare('SELECT COUNT(*) FROM runs').pluck().get()).toBe(runsBefore + 1);
    } finally {
      closeDatabase(db);
    }
  });
});
