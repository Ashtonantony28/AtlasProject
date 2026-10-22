// AUDIT-18: performance under load (round 5). Each test asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-18.md (IDs A18-xx). `it.fails` marks a defect that is
// still present; a fix flips it to `it`. Like AUDIT-14, these tests count work or order
// events, not time; the timings live in AUDIT-18.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { createMcpContext, handleAskTool, handleIndexTool } from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

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

/** Counts rows inserted into `edges` on this connection (a TEMP trigger sees every insert). */
function countEdgeInserts(db: DB): () => number {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS audit18_edge_inserts (n INTEGER NOT NULL);
    DELETE FROM audit18_edge_inserts; INSERT INTO audit18_edge_inserts VALUES (0);
    CREATE TEMP TRIGGER IF NOT EXISTS audit18_edge_ins AFTER INSERT ON main.edges
      BEGIN UPDATE audit18_edge_inserts SET n = n + 1; END;`);
  return () =>
    (db.prepare('SELECT n FROM audit18_edge_inserts').get() as { n: number }).n;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit18-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AUDIT-18 performance under load', () => {
  // A18-03: SG50's carryEdges re-inserts every edge touching a re-parsed file, at both of its
  // ends, inside each per-file transaction. On `--force` (and an EXTRACTOR_VERSION upgrade)
  // every file is re-parsed and the resolve transaction then deletes all edges and rebuilds
  // them, so ~1.75 inserts per edge (plus their cascade deletes) are thrown away: dense 3k
  // files +33% wall on `--force`, +37% on an upgrade. Bounded: each final edge is inserted
  // about once by the run (the resolver's own insert), as before SG50.
  it.fails('A18-03: a forced re-index inserts each edge about once', async () => {
    const root = join(dir, 'force');
    writeDenseRepo(root, 20, 20);
    const db: DB = openDatabase(join(dir, 'force.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const edges = counts(db).edges;
      expect(edges).toBeGreaterThan(1000);
      const inserted = countEdgeInserts(db);
      await indexRepo(db, root, { skipEmbeddings: true, force: true });
      expect(counts(db).edges).toBe(edges);
      expect(inserted()).toBeLessThanOrEqual(Math.ceil(edges * 1.1));
    } finally {
      closeDatabase(db);
    }
  });

  it.fails('A18-03: an EXTRACTOR_VERSION upgrade inserts each edge about once', async () => {
    const root = join(dir, 'upgrade');
    writeDenseRepo(root, 20, 20);
    const db: DB = openDatabase(join(dir, 'upgrade.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const edges = counts(db).edges;
      db.prepare(
        "UPDATE runs SET stats_json = json_set(stats_json, '$.state.extractorVersion', 1) WHERE id = (SELECT MAX(id) FROM runs WHERE finished_at IS NOT NULL)",
      ).run();
      const inserted = countEdgeInserts(db);
      const stats = await indexRepo(db, root, { skipEmbeddings: true });
      expect(stats.filesIndexed).toBe(20);
      expect(counts(db).edges).toBe(edges);
      expect(inserted()).toBeLessThanOrEqual(Math.ceil(edges * 1.1));
    } finally {
      closeDatabase(db);
    }
  });

  // Not a defect, pinned: an incremental edit carries only the edited file's edges (SG50 keeps
  // a reader's graph whole), so its extra work is bounded by that file's degree, not the repo.
  it('A18-03 (bound): editing one file carries only that file’s edges', async () => {
    const root = join(dir, 'edit');
    writeDenseRepo(root, 20, 20);
    const db: DB = openDatabase(join(dir, 'edit.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const edges = counts(db).edges;
      const fileEdges = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges e WHERE
               e.src_symbol IN (SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'src/m10.ts' AND s.kind != 'module')
            OR e.dst_symbol IN (SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'src/m10.ts' AND s.kind != 'module')`,
          )
          .get() as { c: number }
      ).c;
      const inserted = countEdgeInserts(db);
      const path = join(root, 'src/m10.ts');
      write(path, `// edited\n${readFileSync(path, 'utf8')}`);
      const stats = await indexRepo(db, root, { skipEmbeddings: true });
      expect(stats.filesIndexed).toBe(1);
      // The carry (fileEdges) plus the resolver's rebuild (edges).
      expect(inserted()).toBeLessThanOrEqual(fileEdges + edges);
    } finally {
      closeDatabase(db);
    }
  });

  // A18-01 (embedding text): `buildSymbolText` → `sliceLines` splits the whole file source once
  // per symbol, so embedding a file costs O(symbols × lines). One 836 KB generated TS file of
  // 8,000 functions takes 11 s in the embed phase (2,000: 0.6 s; 4,000: 2.0 s), one 30,000-line
  // Python file of assignments 47 s, all of it one block of the event loop. Bounded: a file's
  // source is split a constant number of times, not once per symbol.
  it.fails('A18-01: embedding a file splits its source a bounded number of times', async () => {
    const root = join(dir, 'generated');
    const N = 400;
    const src = Array.from(
      { length: N },
      (_, i) => `/** Op ${i}. */\nexport function op${i}(x: number): number {\n  return x + ${i};\n}\n`,
    ).join('');
    write(join(root, 'src/api.generated.ts'), src);
    const db: DB = openDatabase(join(dir, 'generated.db'));
    const proto = String.prototype as { split: (...a: unknown[]) => string[] };
    const original = proto.split;
    let splits = 0;
    proto.split = function (this: string, ...args: unknown[]) {
      if (this.length === src.length) splits++;
      return original.apply(this, args);
    };
    try {
      await indexRepo(db, root);
      expect(counts(db).symbols).toBeGreaterThanOrEqual(N);
      // Today: one split per symbol (≈ N).
      expect(splits).toBeLessThanOrEqual(10);
    } finally {
      proto.split = original;
      closeDatabase(db);
    }
  });

  // A18-02: SG34 yields between files and before the resolve and embed phases, but each phase
  // is one synchronous block. At 10k realistic files the embed phase of a forced run blocks the
  // event loop (and so an MCP server's stdin) for seconds. Bounded: the embed loop yields
  // between batches, so a self-rescheduling setImmediate ticks while embeddings are written.
  it.fails('A18-02: the embed phase yields while it writes embeddings', async () => {
    const root = join(dir, 'embed');
    writeDenseRepo(root, 40, 100);
    const db: DB = openDatabase(join(dir, 'embed.db'));
    const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Database.Statement;
    const ticksAt: number[] = [];
    let ticks = 0;
    let ticking = true;
    const tick = (): void => {
      ticks++;
      if (ticking) setImmediate(tick);
    };
    const original = proto.run;
    const spy = vi.spyOn(proto, 'run').mockImplementation(function (
      this: Database.Statement,
      ...args: unknown[]
    ) {
      if (this.source.startsWith('INSERT INTO embeddings_vec')) ticksAt.push(ticks);
      return original.apply(this, args as never);
    });
    try {
      setImmediate(tick);
      await indexRepo(db, root);
      expect(ticksAt.length).toBeGreaterThan(3000);
      // Every embedding of the run is written within one turn of the event loop today.
      expect(ticksAt.at(-1)!).toBeGreaterThan(ticksAt[0]!);
    } finally {
      ticking = false;
      spy.mockRestore();
      closeDatabase(db);
    }
  });

  // A18-04: SG50 reserves prompt + max_tokens (16,000 for ask) per in-flight MCP call, so the
  // default 200k budget admits ~11 concurrent `atlas_ask` calls whatever they really spend
  // (12 parallel asks at 10k files: 11 ran, using 13.7k tokens in all; the 12th was refused).
  // The refusal reads "1688 of 200000 left; raise tokenBudget" while 186k are unspent: the
  // reserved tokens are reported as spent. Bounded: a refusal caused by in-flight reservations
  // says so (or the call waits for them), instead of reporting the budget as used up.
  it.fails('A18-04: a refusal caused by in-flight reservations says so', async () => {
    const root = join(dir, 'ask');
    cpSync(SAMPLE, root, { recursive: true });
    mkdirSync(join(root, '.atlas'), { recursive: true });
    writeFileSync(
      join(root, '.atlas', 'config.json'),
      JSON.stringify({ version: 1, tokenBudget: 33_000 }),
    );
    const gates: (() => void)[] = [];
    let held = 0;
    const ctx = createMcpContext({
      root,
      llm: {
        model: 'gated',
        complete: async () => {
          if (held++ < 2) await new Promise<void>((r) => gates.push(r));
          return { content: 'Circle.area [1]', inputTokens: 300, outputTokens: 100, stopReason: 'end_turn' };
        },
      },
    });
    try {
      await handleIndexTool(ctx, {});
      const running = [0, 1].map(() => handleAskTool(ctx, { question: 'circle area' }));
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      const third = handleAskTool(ctx, { question: 'circle area' }).then(
        () => 'ran',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 20));
      gates.forEach((g) => g());
      await Promise.all(running);
      const outcome = await third;
      expect(String(outcome)).toMatch(/^ran$|token budget exhausted/);
      // Nothing has been spent when the third call is refused.
      expect(outcome === 'ran' || /in[- ]flight|reserved/i.test(String(outcome))).toBe(true);
    } finally {
      closeDatabase(ctx.db);
    }
  });
});
