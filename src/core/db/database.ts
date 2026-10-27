import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { endianness } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

/** How long a statement or `immediate` transaction waits for another connection's lock. */
const BUSY_TIMEOUT_MS = 5000;
/** How often `immediate` retries the write lock while another connection holds it. */
const LOCK_POLL_MS = 10;
/** How long an opener waits for another to finish checking a leftover WAL. */
const OPEN_LOCK_MS = 60_000;

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
  let release = (): void => undefined;
  if (dbPath !== ':memory:') {
    lastOpened = dbPath;
    release = checkLeftoverWal(dbPath);
  }
  try {
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
  } finally {
    release();
  }
}

/**
 * SQLite replays any `-wal` beside the file it opens, and a WAL does not name its database: one left
 * by a killed writer beside a replaced `index.db` would be mixed into it (A31-01). A leftover WAL
 * that no connection holds is checked first, under a lock every Atlas opener takes, held until the
 * caller has opened the file (so racing openers cannot replay it meanwhile):
 * - with the WAL replayed, the file passes `PRAGMA integrity_check`: kept (its own WAL, copied or
 *   moved with it);
 * - it fails, and the `-shm` says no checkpoint of the WAL ever started (so the file was never
 *   written from it): the WAL is renamed aside, never deleted, and reported on stderr, then on
 *   every later open while the renamed file is there;
 * - the check cannot run (a full disk, `EDQUOT`, `EFBIG`, `sqlite-vec` not loading): refused with
 *   the cause, the WAL left in place (A34-01);
 * - anything else (no `-shm`, a checkpoint started, not movable) fails with `nameCorrupt`'s message.
 * Timestamps play no part. Returns the lock's release.
 */
function checkLeftoverWal(dbPath: string): () => void {
  const path = walOwner(dbPath);
  reportAside(path);
  if (!leftoverWal(path) || liveWal(holders(path))) return () => undefined;
  const release = lockOpens(path);
  try {
    if (leftoverWal(path)) decideWal(dbPath, path);
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

function decideWal(dbPath: string, path: string): void {
  const before = holders(path) ?? probe(path);
  if (liveWal(before)) return;
  // A live connection to a file renamed over by this one: its WAL is still in use (A33-05).
  if (before.shm) throw corrupt(dbPath, 'another process still has the replaced index open');
  if (integrityOk(dbPath, path)) return;
  const after = holders(path) ?? probe(path);
  if (!after.db && !after.shm && neverCheckpointed(path) && setAside(path)) return;
  throw corrupt(dbPath, 'database disk image is malformed');
}

/** The file whose `-wal` SQLite uses for `dbPath`: a symlinked index's target. */
function walOwner(dbPath: string): string {
  try {
    return lstatSync(dbPath).isSymbolicLink() ? realpathSync(dbPath) : dbPath;
  } catch {
    return dbPath;
  }
}

function leftoverWal(path: string): boolean {
  try {
    const db = statSync(path, { throwIfNoEntry: false });
    const wal = statSync(`${path}-wal`, { throwIfNoEntry: false });
    return !!db && db.size > 0 && !!wal && wal.size > 32;
  } catch {
    return false;
  }
}

interface Holders {
  db: boolean;
  shm: boolean;
}

/** A live WAL connection holds a lock on the file and on its `-shm` for its whole life. */
function liveWal(h: Holders | undefined): boolean {
  return !!h && h.db && h.shm;
}

/**
 * Who holds locks on `path` and its `-shm`, read from the kernel's lock table: passive, so unlike a
 * probe it takes no lock another opener could mistake for a holder. Entries are matched by device
 * and inode (A34-02). Undefined where there is none, or where a lock is on the inode number on
 * another device (another filesystem, or one whose locks name another device, as overlayfs may).
 */
function holders(path: string): Holders | undefined {
  let table: string;
  try {
    table = readFileSync('/proc/locks', 'utf8');
  } catch {
    return undefined;
  }
  const locks = Array.from(table.matchAll(/ ([0-9a-f]+):([0-9a-f]+):(\d+) /g), (m) => ({
    dev: `${parseInt(m[1]!, 16)}:${parseInt(m[2]!, 16)}`,
    ino: m[3],
  }));
  let unsure = false;
  const held = (f: string): boolean => {
    const st = statSync(f, { bigint: true, throwIfNoEntry: false });
    if (!st) return false;
    // glibc's encoding of `st_dev`; /proc/locks prints the major and minor numbers.
    const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & ~0xfffn);
    const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & ~0xffn);
    const same = locks.filter((l) => l.ino === String(st.ino));
    if (same.some((l) => l.dev === `${major}:${minor}`)) return true;
    unsure ||= same.length > 0;
    return false;
  };
  const h = { db: held(path), shm: held(`${path}-shm`) };
  return unsure ? undefined : h;
}

/** `holders` by a probe (under the open lock). When it cannot tell, the WAL is never set aside. */
function probe(path: string): Holders {
  try {
    const used = fileInUse(path);
    return { db: used, shm: used };
  } catch {
    return { db: true, shm: false };
  }
}

/**
 * Takes `<db>.open.lock` with an exclusive SQLite (OS file) lock, released by the returned function;
 * the OS drops it if the process dies. Where it cannot be created (a read-only directory), nothing
 * can write the WAL or set it aside, so the check runs without it.
 */
function lockOpens(path: string): () => void {
  let lock: DB;
  try {
    lock = new Database(`${path}.open.lock`, { timeout: OPEN_LOCK_MS });
  } catch {
    return () => undefined;
  }
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lock.close();
    if ((err as { code?: unknown } | null)?.code !== 'SQLITE_BUSY') return () => undefined;
    nameBusy(err, 'open');
    throw err;
  }
  return () => lock.close();
}

/**
 * `PRAGMA integrity_check` of `path` with its WAL replayed, on a read-only connection (so a mix is
 * never checkpointed into the file) through hard links, so the check is not taken for a live
 * connection to `path` and its `-shm`. Without hard links it runs on `path` itself. False only when
 * SQLite reports corruption; an error that stops the check from running is thrown, named.
 */
function integrityOk(dbPath: string, path: string): boolean {
  const link = `${path}.${process.pid}.${Date.now()}.check`;
  const made: string[] = [];
  try {
    linkSync(path, link);
    made.push(link, `${link}-shm`);
    linkSync(`${path}-wal`, `${link}-wal`);
    made.push(`${link}-wal`);
  } catch {
    // No hard links here.
  }
  try {
    const db = new Database(made.length === 3 ? link : path, {
      readonly: true,
      fileMustExist: true,
      timeout: BUSY_TIMEOUT_MS,
    });
    try {
      loadVecExtension(db);
      return db.pragma('integrity_check(1)', { simple: true }) === 'ok';
    } finally {
      db.close();
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^SQLITE_(CORRUPT|NOTADB)/.test(code)) return false;
    nameBusy(err, 'integrity check');
    if (err instanceof Error && !(typeof code === 'string' && code.startsWith('SQLITE_BUSY'))) {
      err.message =
        `index ${dbPath}: cannot check ${path}-wal, left by a process that stopped ` +
        `(${typeof code === 'string' ? `${code}: ` : ''}${err.message}); it is kept: free disk ` +
        'space (or fix the cause) and retry';
    }
    throw err;
  } finally {
    for (const f of made) rmSync(f, { force: true });
  }
}

/** Renames the WAL to `<db>-wal.foreign-<ms>` and says so on stderr. False if it cannot. */
function setAside(path: string): boolean {
  const wal = `${path}-wal`;
  const aside = `${wal}.foreign-${Date.now()}`;
  try {
    renameSync(wal, aside);
  } catch {
    return false;
  }
  process.stderr.write(`atlas: ${wal} does not belong to ${path}; moved it to ${aside}\n`);
  return true;
}

/** Says on stderr which WALs `setAside` renamed beside `path`, on every open until they are gone. */
function reportAside(path: string): void {
  const prefix = `${basename(path)}-wal.foreign-`;
  let names: string[];
  try {
    names = readdirSync(dirname(path)).filter((f) => f.startsWith(prefix));
  } catch {
    return;
  }
  for (const f of names) {
    process.stderr.write(
      `atlas: ${join(dirname(path), f)} was set aside from ${path}; if its writes belong there, ` +
        `move it back to ${path}-wal before anything writes the index, otherwise delete it\n`,
    );
  }
}

function corrupt(dbPath: string, cause: string): Error {
  const err = Object.assign(new Error(cause), { code: 'SQLITE_CORRUPT' });
  nameCorrupt(err, dbPath);
  return err;
}

/**
 * Reads the `-shm` wal-index (native byte order): its header copies the WAL's salts (offset 32)
 * and frame count (16); `nBackfill` (96) and `nBackfillAttempted` (128) stay 0 until a checkpoint
 * of this WAL starts. Recovery after a crash sets the latter to the frame count.
 */
function neverCheckpointed(dbPath: string): boolean {
  let head: Buffer | undefined;
  let shm: Buffer | undefined;
  try {
    head = readHead(`${dbPath}-wal`, 32);
    shm = readHead(`${dbPath}-shm`, 136);
  } catch {
    return false;
  }
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
    !err.message.includes(`${walOwner(dbPath)}-wal`)
  ) {
    const file = walOwner(dbPath);
    err.message =
      `index ${dbPath} is unreadable (${err.message}): it may have been replaced beside a ` +
      `${file}-wal it does not belong to; delete ${file} with its -wal and -shm and run ` +
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
