import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { endianness } from 'node:os';
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
  if (dbPath !== ':memory:') {
    lastOpened = dbPath;
    if (dropForeignWal(dbPath)) checkIntegrity(dbPath);
  }
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
 * A `-wal` left beside `dbPath` by a stopped process may not belong to it when `dbPath` changed
 * (ctime) after the WAL was last written: a WAL-mode file changes only by a checkpoint, or by being
 * replaced (`cp`/`mv` of a backup or another checkout's index). SQLite would replay it into a file
 * it does not belong to (A31-01). When no connection (in any process) holds the file:
 * - if the `-shm` left with it says no checkpoint of it was ever attempted, it is deleted;
 * - otherwise it may be the rest of an interrupted checkpoint, so it is kept and the caller checks
 *   the index's integrity after SQLite replays it (returns true).
 * Best effort: on any error it is left to SQLite.
 */
function dropForeignWal(dbPath: string): boolean {
  const wal = `${dbPath}-wal`;
  try {
    const db = statSync(dbPath, { bigint: true, throwIfNoEntry: false });
    const log = statSync(wal, { bigint: true, throwIfNoEntry: false });
    if (!db || !log || db.size === 0n || log.size <= 32n || db.ctimeNs <= log.mtimeNs) return false;
    if (fileInUse(dbPath)) return false;
    if (!neverCheckpointed(dbPath)) return true;
    const now = statSync(wal, { bigint: true, throwIfNoEntry: false });
    if (now?.ino === log.ino && now.mtimeNs === log.mtimeNs) rmSync(wal);
  } catch {
    // Unreadable or not removable: SQLite decides, and a mix is reported as corrupt.
  }
  return false;
}

/**
 * Throws a named `SQLITE_CORRUPT` error unless `PRAGMA integrity_check` passes on `dbPath` with its
 * WAL replayed. Read-only, so closing it never checkpoints a mixed WAL into the file.
 */
function checkIntegrity(dbPath: string): void {
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    loadVecExtension(db);
    if (db.pragma('integrity_check(1)', { simple: true }) !== 'ok') {
      throw Object.assign(new Error('database disk image is malformed'), {
        code: 'SQLITE_CORRUPT',
      });
    }
  } catch (err) {
    nameCorrupt(err, dbPath);
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Reads the `-shm` wal-index (native byte order): its header copies the WAL's salts (offset 32)
 * and frame count (16); `nBackfill` (96) and `nBackfillAttempted` (128) stay 0 until a checkpoint
 * of this WAL starts. Recovery after a crash sets the latter to the frame count.
 */
function neverCheckpointed(dbPath: string): boolean {
  const head = readHead(`${dbPath}-wal`, 32);
  const shm = readHead(`${dbPath}-shm`, 136);
  if (!head || !shm) return false;
  const u32 = (at: number): number =>
    endianness() === 'LE' ? shm.readUInt32LE(at) : shm.readUInt32BE(at);
  return (
    shm.subarray(32, 40).equals(head.subarray(16, 24)) &&
    u32(16) > 0 &&
    u32(96) === 0 &&
    u32(128) === 0
  );
}

function readHead(path: string, size: number): Buffer | undefined {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size);
    return readSync(fd, buf, 0, size, 0) === size ? buf : undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * True when a connection holds `dbPath`: in WAL mode each holds a shared lock on the file for its
 * whole life. Probed through a hard link (locks are per inode) in exclusive locking mode, so the
 * probe neither reads nor checkpoints `dbPath`'s WAL.
 */
function fileInUse(dbPath: string): boolean {
  const link = `${dbPath}.${process.pid}.${Date.now()}.probe`;
  linkSync(dbPath, link);
  try {
    const db = new Database(link, { timeout: 0 });
    try {
      db.pragma('locking_mode = EXCLUSIVE');
      db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
      return false;
    } catch {
      return true;
    } finally {
      db.close();
    }
  } finally {
    for (const f of [link, `${link}-wal`, `${link}-shm`]) rmSync(f, { force: true });
  }
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

/** The index this process opened last, named by `nameCorrupt` when the caller has no handle. */
let lastOpened: string | undefined;

/**
 * Names the index, the stale WAL and the remedy in an `SQLITE_CORRUPT*`/`SQLITE_NOTADB` error's
 * message (A31-01), once. Every surface reports the same text.
 */
export function nameCorrupt(err: unknown, dbPath: string | undefined = lastOpened): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (
    err instanceof Error &&
    dbPath !== undefined &&
    typeof code === 'string' &&
    /^SQLITE_(CORRUPT|NOTADB)/.test(code) &&
    !err.message.includes(`${dbPath}-wal`)
  ) {
    err.message =
      `index ${dbPath} is unreadable (${err.message}): it may have been replaced beside a ` +
      `${dbPath}-wal it does not belong to; delete ${dbPath} with its -wal and -shm and run ` +
      '`atlas index`';
  }
}

/**
 * Closes `db` when SIGINT or SIGTERM stops the process, then lets the signal end it as before, so
 * the index is checkpointed into `index.db` and no `-wal` is left (A31-02). Returns the remover.
 */
export function closeOnSignal(db: DB): () => void {
  const stop = (signal: NodeJS.Signals): void => {
    remove();
    if (db.open) closeDatabase(db);
    process.kill(process.pid, signal);
  };
  const remove = (): void => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return remove;
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
