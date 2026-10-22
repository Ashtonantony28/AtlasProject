// AUDIT-8: test coverage, round 2. Plain `it` tests pin behaviour that is correct today but that a
// surviving mutation showed no other test checks (the mutation is named in each test). Each
// `it.fails` asserts the correct behaviour and currently fails, reproducing one finding in
// AUDIT-8.md (IDs A8-xx); when it is fixed it turns red and should become a plain `it`. Each
// `it.todo` names a test that should exist.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getAllFiles,
  getFileByPath,
  getSymbolsForFile,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  LocalHashEmbedder,
  search,
  vectorKnn,
  vectorSimilarities,
} from '../../src/core/vector/index.js';
import { buildGraphJson } from '../../src/core/graph/index.js';
import {
  countDocs,
  createOfflineClient,
  exportDocs,
  listDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import type { DriftReport } from '../../src/core/drift/index.js';
import { createMcpContext, handleDriftTool } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

// Fault injection, off unless a test sets it: `readFileSync` of this absolute path fails.
const fault = vi.hoisted(() => ({ unreadableFile: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
    if (fault.unreadableFile !== null && String(path) === fault.unreadableFile) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), {
        code: 'EACCES',
      });
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  fault.unreadableFile = null;
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { root: string; db: DB } {
  const base = mkdtempSync(join(tmpdir(), 'atlas-audit8-'));
  dirs.push(base);
  const root = join(base, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const db = openDatabase(join(base, 'index.db'));
  dbs.push(db);
  return { root, db };
}

async function sampleIndex(): Promise<{ root: string; db: DB }> {
  const base = mkdtempSync(join(tmpdir(), 'atlas-audit8-'));
  dirs.push(base);
  const root = join(base, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  const db = openDatabase(join(base, 'index.db'));
  dbs.push(db);
  await indexRepo(db, root, { skipEmbeddings: true });
  return { root, db };
}

// Embeds `from` as if it were `to`, so the symbol named by the query is far from it in vector space.
class Remap extends LocalHashEmbedder {
  constructor(
    private readonly from: string,
    private readonly to: string,
  ) {
    super();
  }
  override async embed(inputs: string[]): Promise<Float32Array[]> {
    return super.embed(inputs.map((s) => (s === this.from ? this.to : s)));
  }
}

// 40 decoys whose short docstrings rank first in FTS for "frobnicate", and a `special/` file
// whose ten `widgetTotal*` functions fill a small KNN pool for "widget total". `zeta` mentions
// "frobnicate" once in a long docstring.
function searchRepo(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 4; i++) {
    files[`decoy/d${i}.ts`] = Array.from(
      { length: 10 },
      (_, j) =>
        `/** frobnicate */\nexport function decoy${i}x${j}(): number {\n  return ${j};\n}\n`,
    ).join('\n');
  }
  files['special/s.ts'] =
    Array.from(
      { length: 10 },
      (_, k) =>
        `/** Compute the widget total. */\nexport function widgetTotal${k}(count: number): number {\n  return count * ${k};\n}\n`,
    ).join('\n') +
    '\n/** Zeta handles parsing, routing, caching, logging and metrics, and has to frobnicate the cache total before shutdown completes. */\n' +
    'export function zeta(): void {}\n';
  return files;
}

describe('AUDIT-8 findings', () => {
  it('A8-01: a file whose read fails keeps its rows (kills M16b)', async () => {
    const { root, db } = repo({
      'a.ts': 'export function a(): number { return 1; }\n',
      'b.ts': 'export function b(): number { return 2; }\n',
    });
    await indexRepo(db, root, { skipEmbeddings: true });
    const before = getFileByPath(db, 'b.ts')!;
    writeFileSync(join(root, 'b.ts'), 'export function b2(): number { return 3; }\n');
    fault.unreadableFile = join(root, 'b.ts');
    const failed: string[] = [];
    const st = await indexRepo(db, root, {
      skipEmbeddings: true,
      onFile: (f) => f.status === 'failed' && failed.push(f.path),
    });
    expect(st).toMatchObject({ filesFailed: 1, filesRemoved: 0 });
    expect(failed).toEqual(['b.ts']);
    expect(getFileByPath(db, 'b.ts')?.content_hash).toBe(before.content_hash);
    expect(
      getSymbolsForFile(db, before.id)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['b', 'b.ts']);
    fault.unreadableFile = null;
    const retried = await indexRepo(db, root, { skipEmbeddings: true });
    expect(retried).toMatchObject({ filesFailed: 0, filesIndexed: 1 });
    expect(
      getSymbolsForFile(db, before.id)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['b.ts', 'b2']);
  });

  describe('search on a repo where FTS ranks decoys first', () => {
    it('A8-02: a selective filter still finds an FTS-only match ranked below the over-fetch (kills M03)', async () => {
      const { root, db } = repo(searchRepo());
      await indexRepo(db, root);
      const emb = new Remap('frobnicate', 'widget total');
      const opts = { file: 'special/', candidatePoolSize: 5, limit: 5 };
      // Preconditions: zeta is not in the filtered KNN pool and not an exact-name match.
      const [q] = await emb.embed(['frobnicate']);
      const zetaId = getSymbolsForFile(db, getFileByPath(db, 'special/s.ts')!.id).find(
        (s) => s.name === 'zeta',
      )!.id;
      const pool = vectorKnn(db, q!, 5, {
        sql: 'SELECT s.id FROM symbols s WHERE s.file_id IN (SELECT id FROM files WHERE instr(path, ?) > 0)',
        params: ['special/'],
      });
      expect(pool.map((r) => r.symbolId)).not.toContain(zetaId);

      const hits = await search(db, emb, 'frobnicate', opts);
      for (const h of hits) expect(h.filePath).toContain('special/');
      expect(hits.map((h) => h.symbol.name)).toContain('zeta');
    });

    it('A8-06: a lexical-only hit reports its real vector similarity, also at the cut (kills M01, M02)', async () => {
      const { root, db } = repo(searchRepo());
      await indexRepo(db, root);
      const emb = new Remap('zeta', 'widget total');
      const [q] = await emb.embed(['zeta']);
      const hits = await search(db, emb, 'zeta', { candidatePoolSize: 5, limit: 1 });
      expect(hits[0]?.symbol.name).toBe('zeta');
      const knn = vectorKnn(db, q!, 5).map((r) => r.symbolId);
      expect(knn).not.toContain(hits[0]!.symbol.id);
      const real = vectorSimilarities(db, q!, [hits[0]!.symbol.id]).get(hits[0]!.symbol.id)!;
      expect(real).toBeGreaterThan(0);
      expect(hits[0]!.semanticScore).toBeCloseTo(real, 6);
    });
  });

  describe('graph export on fixtures/sample', () => {
    it('A8-03: the whole-graph path reports edges cut by edgeLimit as truncated (kills M06)', async () => {
      const { db } = await sampleIndex();
      const all = buildGraphJson(db);
      expect(all.edges.length).toBeGreaterThan(1);
      // MCP/dashboard defaults on an index under 1000 symbols take the same path.
      for (const q of [{ edgeLimit: 1 }, { limit: 1000, edgeLimit: 1 }]) {
        const g = buildGraphJson(db, q);
        expect(g.nodes).toHaveLength(all.nodes.length);
        expect(g.edges).toHaveLength(1);
        expect(g.totals.edges).toBe(all.edges.length);
        expect(g.truncated).toBe(true);
      }
    });

    it('A8-09: scoped totals ignore paging, and `file` + `symbol` intersect (kills M07, M08)', async () => {
      const { db } = await sampleIndex();
      const scoped = buildGraphJson(db, { file: 'src/' });
      expect(scoped.edges.length).toBeGreaterThan(0);
      const page = buildGraphJson(db, { file: 'src/', limit: 2 });
      expect(page.totals).toEqual(scoped.totals);
      expect(page.truncated).toBe(true);

      const near = buildGraphJson(db, { symbol: 'multiply' });
      expect(new Set(near.nodes.map((n) => n.file)).size).toBeGreaterThan(1);
      const both = buildGraphJson(db, { symbol: 'multiply', file: 'math.ts' });
      expect(both.nodes.length).toBeGreaterThan(0);
      for (const n of both.nodes) expect(n.file).toBe('src/math.ts');
    });

    it(
      'A8-08: paging through the whole graph returns every edge counted in totals.edges',
      async () => {
        const { db } = await sampleIndex();
        const all = buildGraphJson(db);
        const seen = new Set<string>();
        for (let offset = 0; offset < all.totals.nodes; offset += 5) {
          const page = buildGraphJson(db, { offset, limit: 5 });
          for (const e of page.edges) seen.add(`${e.src}>${e.dst}:${e.kind}`);
        }
        expect(seen.size).toBe(new Set(all.edges.map((e) => `${e.src}>${e.dst}:${e.kind}`)).size);
      },
    );
  });

  describe('drift paging on a documented copy of fixtures/sample', () => {
    it('A8-04: a page past the end of the stale list still fails the gate (kills M09)', async () => {
      const base = mkdtempSync(join(tmpdir(), 'atlas-audit8-'));
      dirs.push(base);
      const root = join(base, 'repo');
      cpSync(SAMPLE, root, { recursive: true });
      const out: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await runCli(['index', root]);
      await runCli(['docs', '--offline', '--cwd', root]);
      appendFileSync(
        join(root, 'src', 'math.ts'),
        'export function added(): number { return 1; }\n',
      );
      await runCli(['index', root]);

      process.exitCode = undefined;
      out.length = 0;
      await runCli(['drift', '--json', '--limit', '1', '--offset', '50', '--cwd', root]);
      const report = JSON.parse(out.join('')) as DriftReport;
      expect(report.stale).toEqual([]);
      expect(report.totals.stale).toBeGreaterThan(0);
      expect(report.failing).toBe(true);
      expect(process.exitCode).toBe(2);

      const ctx = createMcpContext({ root, offline: true });
      try {
        expect(handleDriftTool(ctx, { offset: 50, limit: 1 }).failing).toBe(true);
      } finally {
        closeDatabase(ctx.db);
      }
    });
  });

  it(
    'A8-07: /api/stats `docs` (countDocs) equals the docs list when .atlas/docs holds a stray file',
    async () => {
      const { root, db } = repo({ 'a.ts': 'export function a(): number { return 1; }\n' });
      await indexRepo(db, root, { skipEmbeddings: true });
      await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
      const docsDir = join(root, '.atlas', 'docs');
      exportDocs(db, docsDir);
      // A hand-written note, or a doc whose front matter was mangled by a merge.
      mkdirSync(join(docsDir, 'files'), { recursive: true });
      writeFileSync(join(docsDir, 'files', 'NOTES.md'), '# notes, no front matter\n');
      expect(getAllFiles(db)).toHaveLength(1);
      expect(countDocs(db, docsDir)).toBe(listDocs(db, docsDir).length);
    },
  );

  // A8-10 M10 and M18 are killed by test/drift/paging.test.ts and test/ingest/unreadable.test.ts (SG24).
  it.todo(
    'A8-10 (M15): the cursor call walk keeps member-chain order: `a.b.c.d()` in a small function body gives refs.object `a.b.c` (M15 survives: drop `.reverse()` in dottedAt, parse/ts.ts); add the form to fixtures/parse so golden.json pins it',
  );
});
