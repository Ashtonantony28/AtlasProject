// AUDIT-47: performance under load (round 12). Each `it.fails` asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-47.md (IDs A47-xx) and currently fails; a fix flips it to
// `it`. Plain `it` blocks pin what held. Like AUDIT-35/40/43, these tests count work (bytes per
// write, neighbours asked of vec0, statement executions and rows read) rather than time it; the
// timings live in AUDIT-47.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { buildGraphJson } from '../../src/core/graph/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { createOfflineClient, synthesizeDocs } from '../../src/core/synth/index.js';
import { LocalHashEmbedder, search } from '../../src/core/vector/index.js';
import { runCli } from '../cli/helpers.js';

let dir: string;
let seq = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit47-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A repo of `files` modules with `fns` exported functions each. Every function calls the one
 * before it and `hub.log`, and every module imports the previous module, so each file has
 * cross-file edges in both directions and the hub has an edge from every function.
 */
function writeRepo(root: string, files: number, fns: number): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'hub.ts'), 'export function log(m: string): void {\n  void m;\n}\n');
  for (let i = 0; i < files; i++) {
    const head = [`import { log } from './hub';`];
    if (i > 0) head.push(`import { f${i - 1}_${fns - 1} } from './m${i - 1}';`);
    const body = Array.from({ length: fns }, (_, k) => {
      const prev = k > 0 ? `f${i}_${k - 1}(x)` : i > 0 ? `f${i - 1}_${fns - 1}(x)` : 'x';
      return `/** Step ${k} of module ${i}. */\nexport function f${i}_${k}(x: number): number {\n  log('f${i}_${k}');\n  return ${prev} + 1;\n}\n`;
    });
    writeFileSync(join(root, 'src', `m${i}.ts`), [...head, '', ...body].join('\n'));
  }
}

async function indexedRepo(files: number, fns: number, docs = false): Promise<string> {
  const root = join(dir, `r${seq++}`);
  writeRepo(root, files, fns);
  const db = openDatabase(join(root, '.atlas', 'index.db'));
  try {
    await indexRepo(db, root);
    if (docs) await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 100_000_000 });
  } finally {
    closeDatabase(db);
  }
  return root;
}

interface Work {
  /** Statement executions (`all`/`get`/`iterate`) per SQL text. */
  runs: Map<string, number>;
  /** Rows returned by `all` per SQL text. */
  rows: Map<string, number>;
  /** The arguments of every `all` call per SQL text. */
  args: Map<string, unknown[][]>;
}

/** Counts every statement this connection prepares from now on (including `prepareCached`). */
function meter(db: DB): Work {
  const work: Work = { runs: new Map(), rows: new Map(), args: new Map() };
  const prepare = db.prepare.bind(db);
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const key = sql.replace(/\s+/g, ' ').trim();
    for (const m of ['all', 'get', 'iterate'] as const) {
      const f = stmt[m]!.bind(stmt);
      stmt[m] = (...a: unknown[]) => {
        bump(work.runs, key, 1);
        const out = f(...a);
        if (m === 'all') {
          bump(work.rows, key, (out as unknown[]).length);
          (work.args.get(key) ?? work.args.set(key, []).get(key)!).push(a);
        }
        return out;
      };
    }
    return stmt;
  };
  return work;
}

const total = (m: Map<string, number>, match: (sql: string) => boolean = () => true): number =>
  [...m].filter(([k]) => match(k)).reduce((s, [, v]) => s + v, 0);

/** Runs `atlas graph` (JSON to stdout) in-process; returns every chunk written to stdout. */
async function graphExport(root: string, ...extra: string[]): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => {
    chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  try {
    await runCli(['graph', '--cwd', root, ...extra]);
  } finally {
    spy.mockRestore();
  }
  return chunks;
}

describe('A47-01 (medium) `atlas graph` builds the whole export as one string, so a large graph fails with "Invalid string length"', () => {
  // Measured (AUDIT-47.md): dense 10k (879,419 edges) JSON 169 MB, 6.7 s, 1.0 GB RSS; with the
  // edges copied to 3,517,676 the JSON export exits 1 with `atlas: Invalid string length` after
  // 38 s at 2.2 GB RSS (V8 caps one string at 2^29 - 24 characters, about 2.8M edges of this
  // shape). DOT still works there (133 MB) at 2.5 GB RSS.
  let root: string;
  beforeAll(async () => {
    root = await indexedRepo(60, 10);
  });

  it.fails('the JSON export is written in bounded pieces: no single write holds more than 64 KiB', async () => {
    const chunks = await graphExport(root);
    const body = chunks.join('');
    expect(body.length).toBeGreaterThan(256 * 1024);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(64 * 1024);
  });

  it('precondition: today the whole JSON export is one string written at once, and it is complete', async () => {
    const chunks = await graphExport(root);
    expect(chunks).toHaveLength(1);
    const graph = JSON.parse(chunks[0]!) as { nodes: unknown[]; edges: unknown[]; totals: { nodes: number; edges: number } };
    expect(graph.nodes).toHaveLength(graph.totals.nodes);
    expect(graph.edges).toHaveLength(graph.totals.edges);
    expect(graph.totals.edges).toBeGreaterThan(1000);
    expect(chunks[0]!.length).toBeGreaterThan(256 * 1024);
  });

  it('held: unscoped paging reads each edge once, so paging the whole graph is linear (5.0 s at dense 10k)', () => {
    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    try {
      const work = meter(db);
      let offset = 0;
      let edges = 0;
      let totalEdges = 0;
      for (;;) {
        const g = buildGraphJson(db, { limit: 100, edgeLimit: 1_000_000, offset });
        edges += g.edges.length;
        totalEdges = g.totals.edges;
        offset += g.nodes.length;
        if (offset >= g.totals.nodes) break;
      }
      expect(edges).toBe(totalEdges);
      const edgeRows = total(work.rows, (s) => /FROM edges/.test(s) && !/COUNT/.test(s));
      expect(edgeRows).toBe(totalEdges);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('A47-02 (low) the search candidate pool grows with `limit` (8 × limit), and vec0 KNN cost grows with k', () => {
  // Measured (AUDIT-47.md): realistic 10k (152,873 symbols) `limit 100` p50 401–471 ms against
  // 139–145 ms at limit 10, through `atlas serve` 411 against 169 ms; vec0 KNN alone k=50 127 ms,
  // k=800 357 ms. At the 10k-symbol budget scale, limit 100 p95 48.8–54.3 ms against 15–19 ms at
  // limit 10 (budget 50 ms, measured at limit 10). Both builds alike: search is unchanged since SG14.
  let root: string;
  beforeAll(async () => {
    root = await indexedRepo(30, 10);
  });

  /** The k each vec0 KNN query of one search asked for. */
  async function knnK(limit: number): Promise<number[]> {
    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    try {
      const work = meter(db);
      const hits = await search(db, new LocalHashEmbedder(), 'step module', { limit });
      expect(hits.length).toBeLessThanOrEqual(limit);
      return [...work.args].filter(([sql]) => /embedding MATCH/.test(sql)).flatMap(([, a]) => a.map((x) => Number(x[1])));
    } finally {
      closeDatabase(db);
    }
  }

  it.fails('a search at limit 100 asks vec0 for at most 2 × limit (200) neighbours', async () => {
    const ks = await knnK(100);
    expect(ks).toHaveLength(1);
    expect(ks[0]).toBeLessThanOrEqual(200);
  });

  it('precondition: today limit 100 asks for k = 800, and limit 10 for k = 80 (one KNN query each)', async () => {
    expect(await knnK(100)).toEqual([800]);
    expect(await knnK(10)).toEqual([80]);
  });
});

describe('held: drift and cached synthesis do work linear in the files and edges they cover', () => {
  // Measured (AUDIT-47.md): drift 1.08–1.10 ms per file at 736 and at 10,501 realistic files
  // (0.86–1.1 ms in-process); cached synthesis 0.56–0.68 ms per file at both sizes; the per-file
  // neighbour query returns 1,758,838 rows (2 × edges) in 6.8 s over dense 10k.
  let small: string;
  let large: string;
  beforeAll(async () => {
    small = await indexedRepo(20, 6, true);
    large = await indexedRepo(40, 6, true);
  }, 60_000);

  function driftWork(root: string): { runs: number; rows: number; stale: number } {
    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    try {
      const work = meter(db);
      const report = detectDrift(db, { root });
      return { runs: total(work.runs), rows: total(work.rows), stale: report.totals.stale };
    } finally {
      closeDatabase(db);
    }
  }

  it('doubling the files at most doubles (×2.2) drift statement executions and rows read', () => {
    const a = driftWork(small);
    const b = driftWork(large);
    expect(a.stale).toBe(0);
    expect(b.stale).toBe(0);
    expect(b.runs / a.runs).toBeLessThanOrEqual(2.2);
    expect(b.rows / a.rows).toBeLessThanOrEqual(2.2);
  });

  it('a cached synthesis run generates nothing and its statement executions at most double with the files', async () => {
    const work = async (root: string) => {
      const db = openDatabase(join(root, '.atlas', 'index.db'));
      try {
        const w = meter(db);
        const st = await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 100_000_000 });
        expect(st.modulesGenerated).toBe(0);
        expect(st.architectureGenerated).toBe(false);
        return total(w.runs);
      } finally {
        closeDatabase(db);
      }
    };
    const a = await work(small);
    const b = await work(large);
    expect(b / a).toBeLessThanOrEqual(2.2);
  });
});
