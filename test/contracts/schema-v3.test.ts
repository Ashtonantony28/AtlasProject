import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  MIGRATIONS,
  insertSymbol,
  upsertFile,
  getAllSymbols,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

function ftsIds(db: DB, query: string): number[] {
  return (
    db
      .prepare('SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY rowid')
      .all(query) as {
      rowid: number;
    }[]
  ).map((r) => r.rowid);
}

function ftsIntegrity(db: DB): void {
  // rank=1 compares the index against the external content table; throws on drift.
  db.prepare("INSERT INTO symbols_fts (symbols_fts, rank) VALUES ('integrity-check', 1)").run();
}

describe('contract: migration v3', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-contract-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds symbols.exported and symbols_fts', () => {
    const db = openDatabase(join(dir, 'a.db'));
    const cols = db.prepare('PRAGMA table_info(symbols)').all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const exported = cols.find((c) => c.name === 'exported');
    expect(exported).toMatchObject({ notnull: 1, dflt_value: '0' });
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'symbols_fts'").get() as
      | { sql: string }
      | undefined;
    expect(fts?.sql).toMatch(/fts5/i);
    const maxVersion = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as {
      v: number;
    };
    expect(maxVersion.v).toBe(3);
    closeDatabase(db);
  });

  it('backfills symbols_fts for rows that existed before v3', () => {
    const path = join(dir, 'old.db');
    const raw = new Database(path);
    sqliteVec.load(raw);
    raw.exec(
      'CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const m of MIGRATIONS.filter((m) => m.version < 3)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO _migrations VALUES (?, ?, ?)').run(m.version, m.name, 'then');
    }
    raw.exec(`
      INSERT INTO files (path, language, content_hash, loc, indexed_at) VALUES ('a.ts', 'typescript', 'h', 1, 'then');
      INSERT INTO symbols (file_id, kind, name, start_line, end_line, qualified_name)
        VALUES (1, 'function', 'legacyThing', 1, 1, 'legacyThing');
    `);
    raw.close();

    const db = openDatabase(path);
    expect(ftsIds(db, 'legacyThing')).toEqual([1]);
    expect(getAllSymbols(db)[0]?.exported).toBe(0);
    ftsIntegrity(db);
    closeDatabase(db);
  });

  it('keeps symbols_fts in sync through insert, delete and forced re-index', async () => {
    const db = openDatabase(join(dir, 'idx.db'));
    await indexRepo(db, FIXTURE, { skipEmbeddings: true });
    ftsIntegrity(db);

    const multiply = getAllSymbols(db).filter((s) => s.name === 'multiply');
    expect(multiply.length).toBeGreaterThan(0);
    expect(ftsIds(db, 'multiply')).toEqual(multiply.map((s) => s.id));
    expect(ftsIds(db, 'docstring:Multiply')).toEqual(multiply.map((s) => s.id));

    const fid = upsertFile(db, {
      path: 'extra.ts',
      language: 'typescript',
      content_hash: 'x',
      loc: 1,
    });
    const sid = insertSymbol(db, {
      file_id: fid,
      kind: 'function',
      name: 'zebraCrossing',
      signature: null,
      start_line: 1,
      end_line: 1,
      docstring: 'stripes',
      qualified_name: 'zebraCrossing',
      exported: true,
    });
    expect(ftsIds(db, 'zebraCrossing')).toEqual([sid]);
    db.prepare("UPDATE symbols SET name = 'okapi', qualified_name = 'okapi' WHERE id = ?").run(sid);
    expect(ftsIds(db, 'zebraCrossing')).toEqual([]);
    expect(ftsIds(db, 'okapi')).toEqual([sid]);
    db.prepare('DELETE FROM files WHERE id = ?').run(fid); // cascades to symbols
    expect(ftsIds(db, 'okapi')).toEqual([]);
    ftsIntegrity(db);

    await indexRepo(db, FIXTURE, { force: true, skipEmbeddings: true });
    const after = getAllSymbols(db).filter((s) => s.name === 'multiply');
    expect(after.length).toBe(multiply.length);
    expect(ftsIds(db, 'multiply')).toEqual(after.map((s) => s.id));
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n: number };
    expect(ftsCount.n).toBe(getAllSymbols(db).length);
    ftsIntegrity(db);
    closeDatabase(db);
  });

  it('is idempotent across reopen', () => {
    const path = join(dir, 'a.db');
    closeDatabase(openDatabase(path));
    const db = openDatabase(path);
    expect(runMigrations(db)).toBe(0);
    const rows = db.prepare('SELECT version FROM _migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    closeDatabase(db);
  });
});

describe('contract: insertSymbol exported', () => {
  it('round-trips exported as 0/1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-contract-'));
    try {
      const db = openDatabase(join(dir, 'a.db'));
      const fid = upsertFile(db, {
        path: 'a.ts',
        language: 'typescript',
        content_hash: 'h',
        loc: 1,
      });
      const base = {
        file_id: fid,
        kind: 'function' as const,
        signature: null,
        start_line: 1,
        end_line: 1,
        docstring: null,
        qualified_name: null,
      };
      const yes = insertSymbol(db, { ...base, name: 'pub', exported: true });
      const no = insertSymbol(db, { ...base, name: 'priv', exported: false });
      const byId = new Map(getAllSymbols(db).map((s) => [s.id, s.exported]));
      expect(byId.get(yes)).toBe(1);
      expect(byId.get(no)).toBe(0);
      closeDatabase(db);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
