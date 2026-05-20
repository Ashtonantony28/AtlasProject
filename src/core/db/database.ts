import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

export interface OpenDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

/**
 * Open (or create) the Atlas SQLite index, applying any pending migrations.
 */
export function openDatabase(dbPath: string, opts: OpenDbOptions = {}): DB {
  if (!opts.readonly && !existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false,
  });

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

export function runMigrations(db: DB): number {
  ensureMigrationsTable(db);
  const appliedRow = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as
    | { v: number | null }
    | undefined;
  const applied = appliedRow?.v ?? 0;

  let count = 0;
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of MIGRATIONS) {
    if (m.version <= applied) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      insertMigration.run(m.version, m.name, new Date().toISOString());
    });
    tx();
    count++;
  }
  return count;
}

export function closeDatabase(db: DB): void {
  db.close();
}
