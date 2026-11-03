import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  getAllDocs,
  getAllFiles,
  getDoc,
  getFileByPath,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  buildModuleContext,
  createOfflineClient,
  synthesizeDocs,
  TokenBudget,
  type LLMClient,
} from '../../src/core/synth/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('synthesizeDocs (offline)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-synth-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces one doc per file plus an architecture doc, grounded in real symbols', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    const stats = await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 200_000 });

    expect(stats.modulesGenerated).toBe(4);
    expect(stats.architectureGenerated).toBe(true);

    const allDocs = getAllDocs(db);
    expect(allDocs.length).toBe(5); // 4 files + architecture

    // Every module doc must be non-empty and reference its own file path.
    const fileDocs = allDocs.filter((d) => d.target_kind === 'file');
    expect(fileDocs).toHaveLength(4);
    for (const d of fileDocs) expect(d.content.length).toBeGreaterThan(0);

    // The shapes doc must reference REAL SYMBOLS from that file by name
    // (Circle / Shape / Drawable), not just the file path.
    const files = getAllFiles(db);
    const shapesFile = files.find((f) => f.path === 'src/shapes.ts')!;
    const shapesDoc = fileDocs.find((d) => d.target_id === shapesFile.id);
    expect(shapesDoc).toBeDefined();
    expect(shapesDoc!.content).toMatch(/\bCircle\b/);
    expect(shapesDoc!.content).toMatch(/\bShape\b/);
    expect(shapesDoc!.content).toMatch(/\bDrawable\b/);

    // The math doc references its real symbols.
    const mathFile = files.find((f) => f.path === 'src/math.ts')!;
    const mathDoc = fileDocs.find((d) => d.target_id === mathFile.id);
    expect(mathDoc!.content).toMatch(/\badd\b/);
    expect(mathDoc!.content).toMatch(/\bmultiply\b/);

    // The Python doc references its real symbols.
    const utilFile = files.find((f) => f.path === 'src/util.py')!;
    const utilDoc = fileDocs.find((d) => d.target_id === utilFile.id);
    expect(utilDoc!.content).toMatch(/\bCounter\b/);
    expect(utilDoc!.content).toMatch(/\bgreet\b/);

    // The architecture doc must list the actual modules + show real totals.
    const archDoc = allDocs.find((d) => d.target_kind === 'architecture');
    expect(archDoc).toBeDefined();
    expect(archDoc!.content).toMatch(/^#\s+Architecture/m);
    expect(archDoc!.content).toMatch(/src\/shapes\.ts/);
    expect(archDoc!.content).toMatch(/src\/math\.ts/);
    expect(archDoc!.content).toMatch(/src\/util\.py/);
    expect(archDoc!.content).toMatch(/Totals:\s*\*\*\s*4\s+files/);

    closeDatabase(db);
  });

  it('asserts structure when running with a low per-doc token cap', async () => {
    // Smoke test for the DoD: with a low per-doc cap (small max_tokens),
    // each generated doc must still be non-empty, have a markdown heading,
    // and reference at least one real symbol from its file.
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    const stats = await synthesizeDocs(db, llm, {
      root: FIXTURE,
      tokenBudget: 200_000,
      perDocMaxTokens: 120, // tight, but enough to render a few bullets
    });
    expect(stats.modulesGenerated + stats.modulesCached).toBe(4);

    const docs = getAllDocs(db).filter((d) => d.target_kind === 'file');
    expect(docs).toHaveLength(4);
    for (const d of docs) {
      expect(d.content.length).toBeGreaterThan(0);
      // Each module doc has a markdown heading.
      expect(d.content).toMatch(/^#\s+/m);
      // Each module doc cites a file:line.
      expect(d.content).toMatch(/[\w./-]+\.(?:ts|py):\d+/);
    }
    closeDatabase(db);
  });

  it('caches by source_hash on the second run', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 200_000 });
    const second = await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 200_000 });
    expect(second.modulesGenerated).toBe(0);
    expect(second.modulesCached).toBe(4);
    expect(second.architectureGenerated).toBe(false);
    closeDatabase(db);
  });

  it('refuses a budget too small for any doc, storing nothing', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    await expect(synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 50 })).rejects.toThrow(
      /token budget exhausted/,
    );
    expect(getAllDocs(db)).toHaveLength(0);
    closeDatabase(db);
  });

  it('writes a deterministic doc per file (offline mock)', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 200_000 });
    const file = getAllFiles(db).find((f) => f.path === 'src/shapes.ts')!;
    const d1 = getDoc(db, 'file', file.id);
    expect(d1?.content).toContain('shapes');

    // Force re-generation; deterministic mock should produce identical content.
    await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 200_000, force: true });
    const d2 = getDoc(db, 'file', file.id);
    expect(d2?.content).toBe(d1?.content);
    closeDatabase(db);
  });
});

describe('module context after an edit that was not re-indexed', () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-synth-edit-'));
    root = join(dir, 'repo');
    cpSync(FIXTURE, root, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const prepend = (rel: string) => {
    const p = join(root, rel);
    writeFileSync(p, '// header added after indexing\n'.repeat(12) + readFileSync(p, 'utf8'));
  };

  it('buildModuleContext has `add`’s source before the edit and no snippet after it', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
    const file = getFileByPath(db, 'src/math.ts')!;
    const before = buildModuleContext(db, root, file).sourceSnippets;
    expect(before.find((s) => s.symbol === 'add')?.code).toMatch(/return a \+ b/);
    prepend('src/math.ts');
    const after = buildModuleContext(db, root, file).sourceSnippets;
    expect(after.map((s) => s.code).join('\n')).not.toMatch(/header added after indexing/);
    expect(after).toEqual([]);
    closeDatabase(db);
  });

  it('synthesizeDocs sends no inserted line in the module prompt', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
    prepend('src/math.ts');
    const prompts: string[] = [];
    const capture: LLMClient = {
      model: 'capture',
      complete: async (params) => {
        prompts.push(params.messages.map((m) => m.content).join('\n'));
        return { content: '# doc\nadd multiply PI', inputTokens: 1, outputTokens: 1 };
      },
    };
    await synthesizeDocs(db, capture, { root, tokenBudget: 1_000_000 });
    const math = prompts.filter((p) => p.startsWith('Target: module src/math.ts'));
    expect(math.length).toBeGreaterThan(0);
    expect(math.join('\n')).not.toMatch(/header added after indexing/);
    closeDatabase(db);
  });
});

describe('TokenBudget', () => {
  it('blocks charges that would exceed the cap', () => {
    const b = new TokenBudget(100);
    expect(b.tryCharge(40, 40)).toBe(true);
    expect(b.tryCharge(10, 10)).toBe(true);
    expect(b.tryCharge(5, 5)).toBe(false);
    expect(b.remaining()).toBe(0);
  });
});
