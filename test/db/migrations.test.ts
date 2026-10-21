import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, runMigrations, counts } from '../../src/core/db/index.js';

describe('migrations', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates all core tables on a fresh DB', () => {
    const db = openDatabase(join(dir, 'a.db'));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    for (const expected of [
      'files',
      'symbols',
      'edges',
      // sqlite-vec vec0 virtual table + meta side-car (migration v2)
      'embeddings_vec',
      'embeddings_meta',
      'docs',
      'runs',
      'imports',
      'symbols_fts', // migration v3
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    expect(counts(db)).toEqual({ files: 0, symbols: 0, edges: 0, docs: 0, imports: 0 });
    closeDatabase(db);
  });

  it('is idempotent when migrations are re-run', () => {
    const db = openDatabase(join(dir, 'a.db'));
    const applied = runMigrations(db);
    expect(applied).toBe(0); // already migrated by open
    closeDatabase(db);
  });

  it('persists schema across reopen', () => {
    const path = join(dir, 'a.db');
    let db = openDatabase(path);
    db.prepare(
      "INSERT INTO files (path, language, content_hash, loc, indexed_at) VALUES (?,?,?,?,?)",
    ).run('foo.ts', 'typescript', 'h', 10, new Date().toISOString());
    closeDatabase(db);

    db = openDatabase(path);
    expect(counts(db).files).toBe(1);
    closeDatabase(db);
  });
});
