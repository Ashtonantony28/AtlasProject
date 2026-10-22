import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

const statements = new WeakMap<DB, Map<string, Database.Statement>>();

/** `db.prepare(sql)`, memoised per connection for hot paths. */
export function prepareCached(db: DB, sql: string): Database.Statement {
  let byDb = statements.get(db);
  if (!byDb) statements.set(db, (byDb = new Map()));
  let stmt = byDb.get(sql);
  if (!stmt) byDb.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

export interface OpenDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

/** Load the sqlite-vec extension. Required before any vec0 virtual table is queried. */
function loadVecExtension(db: DB): void {
  sqliteVec.load(db);
}

/**
 * Open (or create) the Atlas SQLite index, applying any pending migrations.
 * Loads the sqlite-vec extension on every open (read-only or read-write) so
 * downstream code can query the embeddings_vec virtual table either way.
 */
export function openDatabase(dbPath: string, opts: OpenDbOptions = {}): DB {
  if (!opts.readonly && !opts.fileMustExist && !existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false,
  });

  // sqlite-vec is needed even in read-only mode because the embeddings_vec
  // virtual table created by migration v2 is queried on search.
  loadVecExtension(db);

  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    runMigrations(db);
  }

  return db;
}

function ensureMigrationsTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function appliedVersion(db: DB): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/**
 * Apply pending migrations. Another process may be migrating the same file, so the version is
 * re-read and the migrations applied under one `BEGIN IMMEDIATE` (waiting on the busy timeout).
 */
export function runMigrations(db: DB): number {
  ensureMigrationsTable(db);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (appliedVersion(db) >= latest) return 0;

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  return db
    .transaction(() => {
      const applied = appliedVersion(db);
      let count = 0;
      for (const m of MIGRATIONS) {
        if (m.version <= applied) continue;
        db.exec(m.sql);
        insertMigration.run(m.version, m.name, new Date().toISOString());
        count++;
      }
      return count;
    })
    .immediate();
}

export function closeDatabase(db: DB): void {
  db.close();
}
