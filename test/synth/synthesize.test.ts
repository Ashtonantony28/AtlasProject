import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, getAllDocs, getDoc, getAllFiles } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { createOfflineClient, synthesizeDocs, TokenBudget } from '../../src/core/synth/index.js';

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

  it('produces one doc per file plus an architecture doc, grounded in real files', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    const stats = await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 200_000 });

    expect(stats.modulesGenerated).toBe(4);
    expect(stats.architectureGenerated).toBe(true);

    // The stored docs reference at least one real file from the fixture.
    const allDocs = getAllDocs(db);
    expect(allDocs.length).toBe(5); // 4 files + architecture
    const shapesDoc = allDocs.find((d) => d.content.includes('src/shapes.ts'));
    expect(shapesDoc).toBeDefined();
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

  it('respects a tight token budget by skipping work, not crashing', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    const stats = await synthesizeDocs(db, llm, { root: FIXTURE, tokenBudget: 50 });
    expect(stats.modulesSkipped).toBeGreaterThan(0);
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

describe('TokenBudget', () => {
  it('blocks charges that would exceed the cap', () => {
    const b = new TokenBudget(100);
    expect(b.tryCharge(40, 40)).toBe(true);
    expect(b.tryCharge(10, 10)).toBe(true);
    expect(b.tryCharge(5, 5)).toBe(false);
    expect(b.remaining()).toBe(0);
  });
});
