// AUDIT-14: performance under load (round 4). Each test asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-14.md (IDs A14-xx). `it.fails` marks a defect that is
// still present; a fix flips it to `it`. These tests count work or order events, not time;
// the timings live in AUDIT-14.md, scripts/audit4-*.mjs and test/perf.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

let dir: string;
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A TS repo of `files` modules, each with `fns` functions that call each other and import a neighbour. */
function writeDenseRepo(root: string, files: number, fns: number): void {
  for (let f = 0; f < files; f++) {
    const L: string[] = [];
    if (f > 0) L.push(`import { f${f - 1}_0 } from './m${f - 1}.js';`);
    for (let i = 0; i < fns; i++) {
      const a = `f${f}_${(i + 1) % fns}`;
      const b = `f${f}_${(i + 2) % fns}`;
      L.push(`/** Doc ${i}. */`);
      L.push(`export function f${f}_${i}(x: number): number {`);
      L.push(`  return ${a}(x) + ${b}(x)${f > 0 && i === 0 ? ` + f${f - 1}_0(x)` : ''};`);
      L.push('}');
    }
    write(join(root, `src/m${f}.ts`), L.join('\n') + '\n');
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit14-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AUDIT-14 performance under load', () => {
  // A12-04: the wall-clock parse+insert gate measures Atlas itself at ~2.8 ms/file against 5, so
  // reverting SG27's multi-row inserts (A10-02) does not move it past the budget. This counts
  // the INSERT statements stepped per inserted row instead: batched, 64 rows share one step.
  it('A14-05 (A12-04 gate): symbols, imports, refs and edges are inserted in multi-row statements', async () => {
    const root = join(dir, 'dense');
    writeDenseRepo(root, 10, 60);
    const db: DB = openDatabase(join(dir, 'dense.db'));
    const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Database.Statement;
    const spy = vi.spyOn(proto, 'run');
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const inserts = spy.mock.contexts.filter((s) =>
        /^INSERT INTO (symbols|imports|refs|edges) /.test((s as Database.Statement).source),
      ).length;
      const refs = (db.prepare('SELECT COUNT(*) AS c FROM refs').get() as { c: number }).c;
      const c = counts(db);
      const rows = c.symbols + c.imports + c.edges + refs;
      expect(rows).toBeGreaterThan(2000);
      // Row by row this is `rows` steps (≈ 2,500). Batched it is ≈ 4 per table per file
      // (64/16/4/1 chunks), ≈ 150 here. The bound leaves room for smaller batch sizes.
      expect(inserts).toBeLessThanOrEqual(rows / 8);
    } finally {
      spy.mockRestore();
      closeDatabase(db);
    }
  });

  // A14-01: an index run never yields to the event loop (parse, insert, resolve and embed are
  // synchronous behind microtask-only awaits), and SG29 chains queued runs with `.then`, so a
  // queue of N `atlas_index` calls blocks the MCP server's stdin for all N runs back to back:
  // a search, a ping or a cancellation sent meanwhile waits for the whole queue.
  it('A14-01: a timer set while three index runs are queued fires before the last run ends', async () => {
    const root = join(dir, 'queue');
    writeDenseRepo(root, 30, 5);
    const db: DB = openDatabase(join(dir, 'queue.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const order: string[] = [];
      const runs = [0, 1, 2].map((i) =>
        indexRepo(db, root, { skipEmbeddings: true, force: true }).then(() =>
          order.push(`run${i}`),
        ),
      );
      setTimeout(() => order.push('timer'), 0);
      await Promise.all(runs);
      await new Promise((r) => setTimeout(r, 5));
      expect(order.indexOf('timer')).toBeLessThan(order.indexOf('run2'));
    } finally {
      closeDatabase(db);
    }
  });
});
