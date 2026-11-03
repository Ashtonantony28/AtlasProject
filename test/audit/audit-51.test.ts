// AUDIT-51: performance under load (round 15). Each `it.fails` asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-51.md (IDs A51-xx) and currently fails; a fix flips it to
// `it`. Plain `it` blocks pin what held after SG240 (`readIndexedSource` hashes each file it reads
// for an excerpt). Like AUDIT-35/40/43/47, these tests count work (file reads, SHA-256 passes over
// a file's source, full splits of a file's source) rather than time it; the timings live in
// AUDIT-51.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getAllFiles, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { createOfflineClient, synthesizeDocs } from '../../src/core/synth/index.js';
import { ask, retrieveForQuery } from '../../src/core/qa/index.js';
import { createMcpContext, handleSymbolTool } from '../../src/mcp/server.js';

let dir: string;
let root: string;
const GEN = 'src/gen.ts';
const GEN_FNS = 60;
const LIBS = 6;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-audit51-'));
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  // One "generated" module whose functions all answer the same question, so every seed of an
  // `ask` lands in it, plus a few small modules that call into it (graph expansion).
  const gen = Array.from(
    { length: GEN_FNS },
    (_, k) =>
      `/** Compute the ledger account total for batch ${k}. */\nexport function ledgerTotal${k}(x: number): number {\n  const a = x * ${k + 1};\n  return a + ${k};\n}\n`,
  );
  writeFileSync(join(root, GEN), gen.join('\n'));
  for (let i = 0; i < LIBS; i++) {
    writeFileSync(
      join(root, 'src', 'lib', `m${i}.ts`),
      `import { ledgerTotal${i} } from '../gen';\n\n/** Report step ${i}. */\nexport function report${i}(x: number): number {\n  return ledgerTotal${i}(x) + 1;\n}\n`,
    );
  }
  const db = openDatabase(join(root, '.atlas', 'index.db'));
  try {
    await indexRepo(db, root);
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 100_000_000 });
  } finally {
    closeDatabase(db);
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sourceFiles = (): string[] => [
  GEN,
  ...readdirSync(join(root, 'src', 'lib')).map((f) => `src/lib/${f}`),
];

interface Work {
  /** `readFileSync` calls per repo-relative path. */
  reads: Map<string, number>;
  /** SHA-256 passes over a file's exact source, per path. */
  hashes: Map<string, number>;
  /** `String.prototype.split` calls on a file's exact source, per path. */
  splits: Map<string, number>;
}

/** Runs `fn` while counting reads, source hashes and source splits of the repo's files. */
async function metered<T>(fn: () => T | Promise<T>): Promise<{ work: Work; result: T }> {
  const byContent = new Map<string, string>();
  for (const p of sourceFiles()) byContent.set(fs.readFileSync(join(root, p), 'utf8'), p);
  const work: Work = { reads: new Map(), hashes: new Map(), splits: new Map() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const read = fs.readFileSync;
  const createHash = crypto.createHash;
  const split = String.prototype.split;
  const prefix = `${root}/`;
  fs.readFileSync = ((...a: Parameters<typeof fs.readFileSync>) => {
    if (typeof a[0] === 'string' && a[0].startsWith(prefix) && !a[0].includes('/.atlas/'))
      bump(work.reads, a[0].slice(prefix.length));
    return read(...a);
  }) as typeof fs.readFileSync;
  crypto.createHash = ((...a: Parameters<typeof crypto.createHash>) => {
    const h = createHash(...a);
    const update = h.update.bind(h);
    h.update = ((data: unknown, ...rest: unknown[]) => {
      const p = typeof data === 'string' ? byContent.get(data) : undefined;
      if (p) bump(work.hashes, p);
      return (update as (...x: unknown[]) => unknown)(data, ...rest);
    }) as typeof h.update;
    return h;
  }) as typeof crypto.createHash;
  String.prototype.split = function (this: string, ...a: unknown[]) {
    const s = String(this);
    const p = s.length > 500 ? byContent.get(s) : undefined;
    if (p) bump(work.splits, p);
    return (split as (...x: unknown[]) => string[]).apply(s, a);
  } as typeof String.prototype.split;
  syncBuiltinESMExports();
  try {
    const result = await fn();
    return { work, result };
  } finally {
    fs.readFileSync = read;
    crypto.createHash = createHash;
    String.prototype.split = split;
    syncBuiltinESMExports();
  }
}

const max = (m: Map<string, number>): number => Math.max(0, ...m.values());
const open = (): DB =>
  openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });

describe('A51-01 (low) drift reads and hashes every documented file twice', () => {
  // Measured (AUDIT-51.md): realistic 10k (11,026 files, all documented) `detectDrift` reads
  // 22,052 files (67.7 MB) and hashes 33.8 MB of source more than before SG240 (+41 ms of SHA-256
  // in a 5.2-6.7 s run, within noise); 61 files with a 7.2 MB module: 2 x 50.8 MB.
  it.fails('detectDrift reads and hashes each unchanged, documented file once', async () => {
    const db = open();
    try {
      const { work, result } = await metered(() => detectDrift(db, { root }));
      expect(result.stale).toEqual([]);
      expect(work.reads.size).toBe(sourceFiles().length);
      expect(max(work.reads)).toBe(1);
      expect(max(work.hashes)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('precondition: today each documented file is read twice and its source hashed twice (once before SG240)', async () => {
    const db = open();
    try {
      const { work } = await metered(() => detectDrift(db, { root }));
      for (const p of sourceFiles()) {
        expect(work.reads.get(p)).toBe(2);
        expect(work.hashes.get(p)).toBe(2);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

describe('A51-02 (low) retrieval splits the whole file once per snippet', () => {
  // Measured (AUDIT-51.md): `k: 20, expand: 20` on a 7.2 MB module splits it 20 times (73 MB,
  // 138-157 ms of a 1.9 s ask, both builds). A18-01's shape, fixed for embedding by SG55.
  it.fails('retrieveForQuery splits each file it excerpts at most once per run', async () => {
    const db = open();
    try {
      const { work, result } = await metered(() =>
        retrieveForQuery(db, root, 'ledger account total', { seedLimit: 20, expansionLimit: 20 }),
      );
      expect(result.filter((s) => s.file.path === GEN).length).toBeGreaterThanOrEqual(20);
      expect(work.splits.get(GEN)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('precondition: today the module is split once for each of its snippets', async () => {
    const db = open();
    try {
      const { work, result } = await metered(() =>
        retrieveForQuery(db, root, 'ledger account total', { seedLimit: 20, expansionLimit: 20 }),
      );
      const fromGen = result.filter((s) => s.file.path === GEN).length;
      expect(fromGen).toBeGreaterThanOrEqual(20);
      expect(work.splits.get(GEN)).toBe(fromGen);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('held: SG240 hashes each file once per run on the excerpt paths', () => {
  it('ask (k 20, expand 20) reads and hashes the module once, however many snippets it gives', async () => {
    const db = open();
    try {
      const { work, result } = await metered(() =>
        ask(db, createOfflineClient(), root, 'ledger account total', {
          seedLimit: 20,
          expansionLimit: 20,
        }),
      );
      expect(result.snippets.filter((s) => s.file.path === GEN).length).toBeGreaterThanOrEqual(20);
      expect(work.reads.get(GEN)).toBe(1);
      expect(work.hashes.get(GEN)).toBe(1);
      expect(max(work.reads)).toBe(1);
      expect(max(work.hashes)).toBe(1);
      expect(result.answer).not.toMatch(/changed since indexing/);
    } finally {
      closeDatabase(db);
    }
  });

  it('atlas_symbol reads, hashes and splits each matched file once per call (50 matches in one file)', async () => {
    const ctx = createMcpContext({ root, offline: true });
    try {
      const { work, result } = await metered(() =>
        handleSymbolTool(ctx, { name: 'ledgerTotal', limit: 50 }),
      );
      expect(result).toHaveLength(50);
      expect(result.every((r) => r.file === GEN && r.excerpt !== null)).toBe(true);
      expect(work.reads.get(GEN)).toBe(1);
      expect(work.hashes.get(GEN)).toBe(1);
      expect(work.splits.get(GEN)).toBe(1);
    } finally {
      closeDatabase(ctx.db);
    }
  });

  it('8 concurrent atlas_symbol calls cost 8 x one call: one read and one hash per call', async () => {
    const ctx = createMcpContext({ root, offline: true });
    try {
      const { work } = await metered(() =>
        Promise.all(
          Array.from({ length: 8 }, () =>
            Promise.resolve().then(() => handleSymbolTool(ctx, { name: 'ledgerTotal', limit: 50 })),
          ),
        ),
      );
      expect(work.reads.get(GEN)).toBe(8);
      expect(work.hashes.get(GEN)).toBe(8);
    } finally {
      closeDatabase(ctx.db);
    }
  });

  it('a cached docs run reads and hashes each file once (one source hash added by SG240)', async () => {
    const db = openDatabase(join(root, '.atlas', 'index.db'));
    try {
      const { work, result } = await metered(() =>
        synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 100_000_000 }),
      );
      expect(result.modulesGenerated).toBe(0);
      expect(result.modulesCached).toBe(getAllFiles(db).length);
      for (const p of sourceFiles()) {
        expect(work.reads.get(p)).toBe(1);
        expect(work.hashes.get(p)).toBe(1);
      }
    } finally {
      closeDatabase(db);
    }
  });
});
