import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getAllEdges, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'sample');

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
    db.exec('DROP TABLE refs; DELETE FROM _migrations WHERE version = 4');
    closeDatabase(db);

    db = openDatabase(path);
    const stats = await indexRepo(db, FIXTURE, { skipEmbeddings: true });
    expect(stats.filesSkipped).toBe(0);
    expect(getAllEdges(db).filter((e) => e.kind === 'calls')).toHaveLength(calls);
    closeDatabase(db);
  });
});
