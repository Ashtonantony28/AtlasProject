import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { detectDrift, formatDriftReport } from '../../src/core/drift/index.js';
import { insertMockDocs } from '../helpers/mockDocs.js';

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

  it('reports no stale docs immediately after docs are inserted (all symbols mentioned)', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    insertMockDocs(db);
    const report = detectDrift(db);
    expect(report.stale.length).toBe(0);
    closeDatabase(db);
  });

  it('reports a doc as stale after the file it covers is mutated and re-indexed', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    insertMockDocs(db);
    expect(detectDrift(db).stale.length).toBe(0);

    const shapes = join(workRoot, 'src/shapes.ts');
    const original = readFileSync(shapes, 'utf8');
    writeFileSync(shapes, original + '\n// mutation marker\n');
    await indexRepo(db, workRoot, { force: true });

    const report = detectDrift(db);
    expect(report.hasDrift).toBe(true);
    const fileStale = report.stale.filter((s) => s.kind === 'file');
    expect(fileStale).toHaveLength(1);
    expect(fileStale[0]?.targetPath).toBe('src/shapes.ts');

    closeDatabase(db);
  });

  it('reports undocumented public symbols when no docs exist', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    const report = detectDrift(db);
    expect(report.undocumented.length).toBeGreaterThan(0);
    const names = report.undocumented.map((u) => u.symbol);
    expect(names).toContain('add');
    expect(names).toContain('Circle');
    expect(report.hasDrift).toBe(true);
    closeDatabase(db);
  });

  it('formatDriftReport renders both sections', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    const report = detectDrift(db);
    const text = formatDriftReport(report);
    expect(text).toMatch(/Undocumented/);
    closeDatabase(db);
  });
});
