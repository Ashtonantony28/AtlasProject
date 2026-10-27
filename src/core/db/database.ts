import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, linkSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

/** How long a statement or `immediate` transaction waits for another connection's lock. */
const BUSY_TIMEOUT_MS = 5000;
/** How often `immediate` retries the write lock while another connection holds it. */
const LOCK_POLL_MS = 10;

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
    // A `-wal` left by a killed run would be replayed into a pre-made file; SQLite drops it beside
    // a 0-byte one (and `switchToWal` waits out the processes racing to switch that file).
    if (dbPath !== ':memory:' && !existsSync(`${dbPath}-wal`)) createWalFile(dbPath);
  }

  const db = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false,
    timeout: BUSY_TIMEOUT_MS,
  });

  // sqlite-vec is needed even in read-only mode because the embeddings_vec
  // virtual table created by migration v2 is queried on search.
  loadVecExtension(db);

  if (!opts.readonly) {
    let op = 'journal mode';
    try {
      switchToWal(db, dbPath);
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = NORMAL');
      op = 'migrations';
      runMigrations(db);
    } catch (err) {
      nameBusy(err, op);
      throw err;
    }
  }

  return db;
}

/**
 * Creates `dbPath` already in WAL mode, by linking a finished file into place. Switching an
 * existing file to WAL upgrades a read lock to a write lock, which SQLite refuses at once (no busy
 * wait) when another process is switching it too. Best effort: on any failure the open creates it.
 */
function createWalFile(dbPath: string): void {
  const tmp = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const db = new Database(tmp);
    try {
      db.pragma('journal_mode = WAL');
    } finally {
      db.close();
    }
    linkSync(tmp, dbPath);
  } catch {
    // EEXIST: another process created it first.
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * `journal_mode = WAL`. While the file is still empty, another process switching it at the same
 * time makes SQLite refuse the switch at once (`SQLITE_BUSY`), and two first reads both try to
 * delete a stale `-wal` (`SQLITE_IOERR_DELETE_NOENT`): both are retried until the busy timeout.
 * The size is taken before the first try: by the time of a refusal, the other process may have
 * written page 1 already.
 */
function switchToWal(db: DB, dbPath: string): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const empty = statSync(dbPath, { throwIfNoEntry: false })?.size === 0;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const transient = code === 'SQLITE_BUSY' || code === 'SQLITE_IOERR_DELETE_NOENT';
      if (!transient || !empty || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

/**
 * Runs `fn` in a transaction that takes the write lock up front (`BEGIN IMMEDIATE`), waiting up to
 * the busy timeout for another connection to release it. A deferred transaction that reads first
 * gets `SQLITE_BUSY` at once in WAL mode instead. The lock is retried every few ms, because
 * SQLite's busy handler sleeps up to 100 ms between tries and misses a writer's short gaps.
 * Inside another transaction, `fn` runs in a savepoint.
 */
export function immediate<T>(db: DB, fn: () => T): T {
  let began = false;
  const tx = db.transaction(() => {
    began = true;
    return fn();
  });
  if (db.inTransaction) return tx();
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  db.pragma(`busy_timeout = ${LOCK_POLL_MS}`);
  try {
    for (;;) {
      try {
        return tx.immediate();
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (began || code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw err;
      }
    }
  } finally {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

const BUSY_REMEDY = ' (another process is writing the index; retry when it finishes)';

/**
 * Names the operation in an `SQLITE_BUSY` error's message, with its cause and remedy
 * (`migrations: database is locked (another process is writing the index; …)`). Names it once.
 */
export function nameBusy(err: unknown, op: string): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (
    err instanceof Error &&
    typeof code === 'string' &&
    code.startsWith('SQLITE_BUSY') &&
    !err.message.endsWith(BUSY_REMEDY)
  ) {
    err.message = `${op}: ${err.message}${BUSY_REMEDY}`;
  }
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
