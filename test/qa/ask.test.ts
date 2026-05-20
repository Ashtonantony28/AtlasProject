import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { ask, retrieveForQuery } from '../../src/core/qa/index.js';
import { createOfflineClient } from '../../src/core/synth/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('retrieveForQuery', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-qa-r-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns seed snippets and graph-expanded neighbors', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);

    const snips = await retrieveForQuery(db, FIXTURE, 'how is the area of a circle computed?', {
      seedLimit: 3,
      expansionLimit: 5,
    });
    expect(snips.length).toBeGreaterThan(0);
    // Should include something from shapes.ts in the seeds.
    const fromShapes = snips.find((s) => s.file.path === 'src/shapes.ts');
    expect(fromShapes).toBeDefined();
    // Excerpts should be non-empty.
    for (const s of snips) {
      expect(s.excerpt.length).toBeGreaterThan(0);
      expect(s.startLine).toBeLessThanOrEqual(s.endLine);
    }
    closeDatabase(db);
  });
});

describe('ask end-to-end (offline)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-qa-a-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces an answer that cites the correct file and line', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    const res = await ask(db, llm, FIXTURE, 'How is the area of a circle computed?');

    // Answer must reference Circle.area at src/shapes.ts.
    expect(res.answer).toMatch(/src\/shapes\.ts:\d+/);

    // Citations must include at least one entry pointing at src/shapes.ts.
    const hasShapes = res.citations.some(
      (c) => c.file === 'src/shapes.ts' && c.symbol.includes('area'),
    );
    expect(hasShapes).toBe(true);

    // Token bookkeeping.
    expect(res.inputTokens).toBeGreaterThan(0);
    expect(res.outputTokens).toBeGreaterThan(0);
    closeDatabase(db);
  });

  it('answers a Python question with a python citation', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const llm = createOfflineClient();
    const res = await ask(db, llm, FIXTURE, 'How does the Counter increment?');
    expect(res.answer).toMatch(/util\.py:\d+/);
    const hasUtil = res.citations.some(
      (c) => c.file === 'src/util.py' && c.symbol.toLowerCase().includes('counter'),
    );
    expect(hasUtil).toBe(true);
    closeDatabase(db);
  });
});
