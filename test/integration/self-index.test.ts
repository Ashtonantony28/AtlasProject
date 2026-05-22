// "Project Done" §10 check: prove Atlas works on a real codebase, not just
// the curated fixture. We use Atlas's own `src/` tree — substantially larger
// and more varied than fixtures/sample, and conveniently checked in here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  getAllSymbols,
  getAllEdges,
  getAllFiles,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { LocalHashEmbedder, search } from '../../src/core/vector/index.js';
import { detectDrift } from '../../src/core/drift/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLAS_ROOT = resolve(__dirname, '..', '..');

describe('Atlas indexes its own source tree (real-codebase smoke)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-self-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks → parses → resolves → embeds without errors', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    const stats = await indexRepo(db, ATLAS_ROOT);

    // The Atlas tree is well into the dozens of files / hundreds of symbols.
    expect(stats.filesScanned).toBeGreaterThan(20);
    expect(stats.filesIndexed).toBeGreaterThan(20);
    expect(stats.filesFailed).toBe(0);

    const files = getAllFiles(db);
    const symbols = getAllSymbols(db);
    const edges = getAllEdges(db);
    expect(symbols.length).toBeGreaterThan(200);
    expect(edges.length).toBeGreaterThan(50);

    // Internal cross-file edges should exist (some imports resolve), not all weak.
    const nonWeak = edges.filter((e) => e.weak === 0);
    expect(nonWeak.length).toBeGreaterThan(20);

    // Sanity check: at least some known Atlas-internal symbols are present.
    const names = new Set(symbols.map((s) => s.qualified_name));
    expect(names.has('LocalHashEmbedder')).toBe(true);
    expect(names.has('synthesizeDocs')).toBe(true);
    expect(names.has('detectDrift')).toBe(true);

    // Detect drift wouldn't crash on a real repo; we don't expect docs here,
    // so it should report undocumented symbols and have hasDrift=true.
    const driftReport = detectDrift(db);
    expect(driftReport.undocumented.length).toBeGreaterThan(0);
    expect(driftReport.hasDrift).toBe(true);

    // Search returns the right concept when constrained to the relevant kind.
    const embedder = new LocalHashEmbedder();
    const classHits = await search(db, embedder, 'local hash embedder', {
      kind: 'class',
      limit: 5,
    });
    expect(classHits.length).toBeGreaterThan(0);
    const classNames = classHits.map((h) => h.symbol.qualified_name ?? h.symbol.name);
    expect(classNames).toContain('LocalHashEmbedder');

    // Unconstrained search also surfaces it within a reasonable window.
    const wideHits = await search(db, embedder, 'local hash embedder', { limit: 15 });
    const wideNames = wideHits.map((h) => h.symbol.qualified_name ?? h.symbol.name);
    expect(wideNames).toContain('LocalHashEmbedder');

    closeDatabase(db);

    // Second run is near-zero work (Phase 10 DoD also holds on a real repo).
    const db2 = openDatabase(join(dir, 'index.db'));
    const second = await indexRepo(db2, ATLAS_ROOT);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(files.length);
    expect(second.embeddings).toBe(0);
    closeDatabase(db2);
  }, 60_000);
});
