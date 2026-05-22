import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { retrieveForQuery } from '../../src/core/qa/index.js';

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
    const fromShapes = snips.find((s) => s.file.path === 'src/shapes.ts');
    expect(fromShapes).toBeDefined();
    for (const s of snips) {
      expect(s.excerpt.length).toBeGreaterThan(0);
      expect(s.startLine).toBeLessThanOrEqual(s.endLine);
    }
    closeDatabase(db);
  });

  it('returns python snippets for python-related queries', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);

    const snips = await retrieveForQuery(db, FIXTURE, 'How does the Counter increment?', {
      seedLimit: 3,
      expansionLimit: 5,
    });
    expect(snips.length).toBeGreaterThan(0);
    const fromUtil = snips.find((s) => s.file.path === 'src/util.py');
    expect(fromUtil).toBeDefined();
    closeDatabase(db);
  });
});
