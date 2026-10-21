import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { synthesizeDocs, createOfflineClient } from '../../src/core/synth/index.js';
import { detectDrift, formatDriftReport } from '../../src/core/drift/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

/** Recursive copy of a directory (small fixture, fine for tests). */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const sp = join(src, entry);
    const dp = join(dst, entry);
    const st = statSync(sp);
    if (st.isDirectory()) copyDir(sp, dp);
    else copyFileSync(sp, dp);
  }
}

describe('detectDrift', () => {
  let dir: string;
  let workRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-drift-'));
    workRoot = join(dir, 'sample');
    copyDir(FIXTURE, workRoot);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports no stale docs immediately after synthesis (when all symbols are mentioned)', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    await synthesizeDocs(db, createOfflineClient(), { root: workRoot, tokenBudget: 200_000 });
    const report = detectDrift(db, { root: workRoot });
    expect(report.stale.length).toBe(0);
    closeDatabase(db);
  });

  it('reports a doc as stale after the file it covers is mutated and re-indexed', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    await synthesizeDocs(db, createOfflineClient(), { root: workRoot, tokenBudget: 200_000 });
    expect(detectDrift(db, { root: workRoot }).stale.length).toBe(0);

    // Mutate src/shapes.ts and re-index without re-synthesizing.
    const shapes = join(workRoot, 'src/shapes.ts');
    const original = readFileSync(shapes, 'utf8');
    writeFileSync(shapes, original + '\n// mutation marker\n');
    await indexRepo(db, workRoot, { force: true });

    const report = detectDrift(db, { root: workRoot });
    expect(report.hasDrift).toBe(true);
    // Exactly src/shapes.ts is stale (architecture may also drift if the digest changed,
    // but only the file doc must be in the list).
    const fileStale = report.stale.filter((s) => s.kind === 'file');
    expect(fileStale).toHaveLength(1);
    expect(fileStale[0]?.targetPath).toBe('src/shapes.ts');

    closeDatabase(db);
  });

  it('reports undocumented public symbols when no docs exist', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    // No synth call.
    const report = detectDrift(db, { root: workRoot });
    expect(report.undocumented.length).toBeGreaterThan(0);
    // Names should be present.
    const names = report.undocumented.map((u) => u.symbol);
    expect(names).toContain('add');
    expect(names).toContain('Circle');
    expect(report.hasDrift).toBe(true);
    closeDatabase(db);
  });

  it('formatDriftReport renders both sections', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    const report = detectDrift(db, { root: workRoot });
    const text = formatDriftReport(report);
    expect(text).toMatch(/Undocumented/);
    closeDatabase(db);
  });
});
