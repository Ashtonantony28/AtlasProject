import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getAllEdges, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'sample');
const GRAPH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'graph');

describe('migration v4 (refs)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-v4-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-parses files indexed before v4 so their call edges come back', async () => {
    const path = join(dir, 'a.db');
    let db = openDatabase(path);
    await indexRepo(db, FIXTURE, { skipEmbeddings: true });
    const calls = getAllEdges(db).filter((e) => e.kind === 'calls').length;
    expect(calls).toBeGreaterThan(0);
    // Roll back to a v3 schema (later migrations included).
    db.exec(
      'DROP TABLE refs; ALTER TABLE imports DROP COLUMN reexport; DELETE FROM _migrations WHERE version >= 4',
    );
    closeDatabase(db);

    db = openDatabase(path);
    const stats = await indexRepo(db, FIXTURE, { skipEmbeddings: true });
    expect(stats.filesSkipped).toBe(0);
    expect(getAllEdges(db).filter((e) => e.kind === 'calls')).toHaveLength(calls);
    closeDatabase(db);
  });

  it('v5 re-parses files indexed before it so re-export edges appear', async () => {
    const path = join(dir, 'b.db');
    let db = openDatabase(path);
    await indexRepo(db, GRAPH, { skipEmbeddings: true });
    const edges = getAllEdges(db).length;
    db.exec(
      'DELETE FROM imports WHERE reexport = 1; ALTER TABLE imports DROP COLUMN reexport; DELETE FROM _migrations WHERE version = 5',
    );
    closeDatabase(db);

    db = openDatabase(path);
    const stats = await indexRepo(db, GRAPH, { skipEmbeddings: true });
    expect(stats.filesSkipped).toBe(0);
    expect(getAllEdges(db)).toHaveLength(edges);
    closeDatabase(db);
  });
});
