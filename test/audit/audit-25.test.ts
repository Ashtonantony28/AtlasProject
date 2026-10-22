// AUDIT-25: soundness, round 7 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-25.md (IDs A25-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held: SG65
// (`createWalFile`, `nameBusy` step labels) and SG80 (`immediate` on every write of an index run,
// doc writes and tombstones).
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  counts,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  getDocTombstones,
  openDatabase,
  upsertDoc,
  upsertFile,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo, type IndexOptions } from '../../src/core/ingest/index.js';
import { runDrift } from '../../src/core/drift/index.js';
import { createOfflineClient, docsFromDb, synthesizeDocs } from '../../src/core/synth/index.js';
import { SAMPLE } from '../cli/helpers.js';
import { lockHolder, type LockHolder } from '../helpers/lockHolder.js';

const dirs: string[] = [];
const dbs: DB[] = [];
const holders: LockHolder[] = [];
afterEach(async () => {
  for (const h of holders.splice(0)) await h.close();
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit25-'));
  dirs.push(d);
  return d;
}

function writeTree(root: string, files: Record<string, string | null>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    if (text === null) {
      rmSync(p, { force: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function newRepo(files: Record<string, string>): string {
  const root = join(tmp(), 'repo');
  mkdirSync(root, { recursive: true });
  writeTree(root, files);
  return root;
}

function open(path: string): DB {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

/** Everything a reader can see, by path and qualified name (ids differ between indexes). */
function snapshot(db: DB): Record<string, string[]> {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const syms = getAllSymbols(db);
  const byId = new Map(syms.map((s) => [s.id, s]));
  const label = (id: number | null): string => {
    if (id === null) return 'null';
    const s = byId.get(id)!;
    const name = s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name);
    return `${paths.get(s.file_id)}::${s.kind}:${name}@${s.start_line}`;
  };
  const embedded = new Set(
    db.prepare('SELECT symbol_id FROM embeddings_meta').pluck().all() as number[],
  );
  return {
    files: getAllFiles(db)
      .map((f) => `${f.path} ${f.content_hash}`)
      .sort(),
    symbols: syms.map((s) => label(s.id)).sort(),
    edges: getAllEdges(db)
      .map((e) => `${label(e.src_symbol)} -${e.kind}${e.weak ? '?' : ''}-> ${label(e.dst_symbol)}`)
      .sort(),
    embedded: syms
      .filter((s) => s.kind !== 'module' && embedded.has(s.id))
      .map((s) => label(s.id))
      .sort(),
    vectors: [String(db.prepare('SELECT COUNT(*) FROM embeddings_vec').pluck().get())],
    tombstones: getDocTombstones(db)
      .map((t) => t.path)
      .sort(),
  };
}

/**
 * `db` whose k-th `immediate` fails at once with `SQLITE_BUSY`, as when another process holds the
 * write lock past the 5 s busy timeout (`immediate` lowers `busy_timeout` to 10 ms just before its
 * `BEGIN IMMEDIATE`, so that call marks each one). `calls()` counts the `immediate`s seen.
 */
function failingAt(db: DB, k: number): { db: DB; calls: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'pragma') return value;
      return (source: string, opts?: Database.PragmaOptions) => {
        if (source === 'busy_timeout = 10' && ++n === k) {
          throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
        }
        return target.pragma(source, opts);
      };
    },
  });
  return { db: proxy, calls: () => n };
}

const LIB = {
  'lib.ts':
    'export function helper() {\n  return 1;\n}\nexport function other() {\n  return 2;\n}\n',
  'app.ts': "import { helper } from './lib';\nexport function main() {\n  return helper();\n}\n",
  'gone.ts': "import { other } from './lib';\nexport function g() {\n  return other();\n}\n",
  'keep.py': 'def keep():\n    return 1\n',
  'use.py': 'from keep import keep\n\ndef use():\n    return keep()\n',
};
const EDIT = {
  'lib.ts':
    'export function helper() {\n  return 1;\n}\nexport function renamed() {\n  return 2;\n}\nexport function added() {\n  return 3;\n}\n',
  'app.ts':
    "import { helper, added } from './lib';\nexport function main() {\n  return helper() + added();\n}\n",
  'gone.ts': null,
  'new.ts': "import { renamed } from './lib';\nexport const n = () => renamed();\n",
};

describe('A25-01 (high) a new index file is linked in already in WAL mode (SG65)', () => {
  /** A WAL a killed run left beside `index.db`, after the user deleted `index.db` itself. */
  function leftoverWal(partial: boolean): string {
    const dir = tmp();
    const path = join(dir, 'index.db');
    const db = openDatabase(path);
    db.pragma('wal_autocheckpoint = 0');
    const add = (n: number, tag: string): void =>
      db.transaction(() => {
        for (let i = 0; i < n; i++) {
          upsertFile(db, {
            path: `${tag}${i}.ts`,
            language: 'typescript',
            content_hash: 'h'.repeat(64),
            loc: 1,
          });
        }
      })();
    add(500, 'old');
    // After a checkpoint the WAL only holds the pages written since: the usual case.
    if (partial) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      add(50, 'newer');
    }
    copyFileSync(`${path}-wal`, join(dir, 'saved-wal')); // what SIGKILL would have left
    closeDatabase(db);
    rmSync(path);
    copyFileSync(join(dir, 'saved-wal'), `${path}-wal`);
    return path;
  }

  it('A25-01 an index created where a deleted index left its WAL does not come up corrupt', () => {
    const path = leftoverWal(true);
    // Before SG90: `database disk image is malformed`, on every later open too.
    const db = open(path);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(counts(db).files).toBe(0);
  });

  it('A25-01 an index created where a deleted index left its WAL starts empty', () => {
    const path = leftoverWal(false);
    const db = open(path);
    // Before SG90 the deleted index's 500 rows came back.
    expect(counts(db).files).toBe(0);
  });

  it('SQLite itself drops a leftover WAL beside a 0-byte database file (the pre-SG65 open)', () => {
    const path = leftoverWal(true);
    writeFileSync(path, '');
    const raw = new Database(path);
    raw.pragma('journal_mode = WAL');
    raw.close();
    const db = open(path);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(counts(db).files).toBe(0);
  });

  it('opening a fresh index leaves only index.db and its WAL files, and never replaces a file that exists', () => {
    const dir = tmp();
    const path = join(dir, 'index.db');
    const a = open(path);
    upsertFile(a, { path: 'a.ts', language: 'typescript', content_hash: 'x', loc: 1 });
    const b = open(path); // the file exists now: opened, not re-created
    expect(counts(b).files).toBe(1);
    expect(readdirSync(dir).filter((f) => !/^index\.db(-wal|-shm)?$/.test(f))).toEqual([]);
  });
});

describe('A25-02 (medium) drift after a run that stopped before its resolve (SG80 failures, kills)', () => {
  const A = {
    'a.ts': 'export function f() {\n  return 1;\n}\n',
    'b.ts': 'export function g() {\n  return 2;\n}\n',
  };
  const B_CALLS_F = {
    'b.ts': "import { f } from './a';\nexport function g() {\n  return f();\n}\n",
  };

  async function documented(): Promise<{ root: string; db: DB }> {
    const root = newRepo(A);
    const db = open(join(root, '..', 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    expect(runDrift(db, { root }).stale).toEqual([]);
    writeTree(root, B_CALLS_F);
    return { root, db };
  }
  const staleFiles = (db: DB, root: string): string[] =>
    runDrift(db, { root, skipArchitecture: true })
      .stale.map((s) => s.targetPath)
      .sort();

  it('a doc whose file gained a caller is stale once the run that saw the edit finishes', async () => {
    const { root, db } = await documented();
    await indexRepo(db, root, { skipEmbeddings: true });
    expect(staleFiles(db, root)).toEqual(['a.ts', 'b.ts']);
  });

  it.fails(
    'A25-02 drift after an index run that failed at its resolve still reports a doc whose callers changed',
    async () => {
      const { root, db } = await documented();
      // immediates: start stamp, b.ts, resolve
      await expect(indexRepo(failingAt(db, 3).db, root, { skipEmbeddings: true })).rejects.toThrow(
        /^graph resolve: database is locked/,
      );
      // On this build drift reads the carried graph (no b.g -> a.f edge) and calls a.ts fresh.
      expect(staleFiles(db, root)).toEqual(['a.ts', 'b.ts']);
    },
  );
});

describe('A25-03 (low) a doc written for a file an index run pruned meanwhile', () => {
  it.fails(
    'A25-03 `upsertDoc` for a file pruned after `atlas docs` read the file list leaves no orphan doc',
    async () => {
      const root = newRepo(LIB);
      const db = open(join(root, '..', 'index.db'));
      await indexRepo(db, root, { skipEmbeddings: true });
      const gone = getAllFiles(db).find((f) => f.path === 'gone.ts')!;
      // `atlas docs` has read the file list and is waiting on the LLM; `atlas index` prunes gone.ts.
      writeTree(root, { 'gone.ts': null });
      await indexRepo(db, root, { skipEmbeddings: true });
      // The LLM answers and `atlas docs` stores the doc (now waiting out the index run's lock).
      upsertDoc(db, { target_kind: 'file', target_id: gone.id, content: 'doc', source_hash: 'h' });
      // On this build: counts().docs = 1 (stats, `/api/stats`) while no doc has a target.
      expect(counts(db).docs).toBe(docsFromDb(db).length);
    },
  );
});

describe('SG80 index runs that hit a busy write lock (pinned)', () => {
  /** An index of LIB with a doc per file, closed (checkpointed) so each case starts from a copy. */
  async function base(): Promise<{ root: string; dbPath: string; want: Record<string, string[]> }> {
    const root = newRepo(LIB);
    const dbPath = join(root, '..', 'base.db');
    const db = openDatabase(dbPath);
    await indexRepo(db, root);
    for (const f of getAllFiles(db)) {
      upsertDoc(db, { target_kind: 'file', target_id: f.id, content: f.path, source_hash: 'h' });
    }
    closeDatabase(db);
    writeTree(root, EDIT);
    // The uninterrupted edit run.
    copyFileSync(dbPath, join(root, '..', 'ref.db'));
    const ref = open(join(root, '..', 'ref.db'));
    await indexRepo(ref, root);
    const want = snapshot(ref);
    // A fresh index of the edited tree agrees with it (but has no tombstones).
    const fresh = open(join(root, '..', 'fresh.db'));
    await indexRepo(fresh, root, { force: true });
    expect({ ...snapshot(fresh), tombstones: want.tombstones }).toEqual(want);
    expect(want.tombstones).toEqual(['gone.ts']);
    return { root, dbPath, want };
  }

  it('a busy failure at any write of a run names its step, and the next run equals the uninterrupted run and a fresh index (no lost or duplicated rows, one tombstone)', async () => {
    const { root, dbPath, want } = await base();
    const labels: string[] = [];
    let total = Infinity;
    for (let k = 1; k <= total; k++) {
      const path = join(root, '..', `k${k}.db`);
      copyFileSync(dbPath, path);
      const db = open(path);
      const runsBefore = db.prepare('SELECT COUNT(*) FROM runs').pluck().get() as number;
      const before = snapshot(db);
      const f = failingAt(db, k);
      let err: Error | undefined;
      await indexRepo(f.db, root).catch((e: Error) => (err = e));
      if (!err) {
        total = k - 1; // k ran past the last immediate: the run had k - 1
        break;
      }
      expect(err.message).toMatch(
        /^[a-z ]+: database is locked \(another process is writing the index; retry when it finishes\)$/,
      );
      labels.push(err.message.split(':')[0]!);
      const runs = db.prepare('SELECT COUNT(*) FROM runs').pluck().get() as number;
      // The start stamp is one transaction: a failure there leaves no unstamped run behind.
      expect(runs).toBe(k === 1 ? runsBefore : runsBefore + 1);
      if (k === 1) expect(snapshot(db)).toEqual(before);
      const next = await indexRepo(db, root);
      // Failed before the resolve: files are still to write or prune. At or after it: a re-resolve.
      const resolved = labels.includes('graph resolve');
      expect(next.resolveReason).toBe(resolved ? 'previous run interrupted' : 'files changed');
      expect(snapshot(db), `failure at immediate #${k} (${labels.at(-1)})`).toEqual(want);
      expect(db.prepare('SELECT COUNT(*) FROM runs WHERE finished_at IS NULL').pluck().get()).toBe(
        k === 1 ? 0 : 1,
      );
    }
    // start stamp, 3 re-parsed or new files, prune, resolve, 1 embedding batch, finish stamp
    expect(labels.join(',')).toMatch(
      /^run stamp,(index write,){3}index write,graph resolve,(embeddings write,)+run stamp$/,
    );
  });

  it('the run after a resolve or later failure re-resolves ("previous run interrupted")', async () => {
    const { root, dbPath, want } = await base();
    copyFileSync(dbPath, join(root, '..', 'r.db'));
    const db = open(join(root, '..', 'r.db'));
    // start stamp, 3 files, prune, resolve: fail at the resolve
    await expect(indexRepo(failingAt(db, 6).db, root)).rejects.toThrow(/^graph resolve: /);
    const next = await indexRepo(db, root);
    expect(next.resolveReason).toBe('previous run interrupted');
    expect(snapshot(db)).toEqual(want);
  });

  it('writes from another process held ~150 ms after every file are waited out; the run equals a fresh index', async () => {
    const root = join(tmp(), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    writeTree(root, EDIT);
    const path = join(root, '..', 'index.db');
    const db = open(path);
    const holder = await lockHolder(path);
    holders.push(holder);
    let holds = 0;
    const opts: IndexOptions = {
      onFile: (e) => {
        if (e.status !== 'parsed') return;
        holds++;
        holder.hold(150); // the next write (a file, the prune, the resolve) waits for it
      },
    };
    const t0 = Date.now();
    await indexRepo(db, root, opts);
    expect(holds).toBeGreaterThan(3);
    expect(Date.now() - t0).toBeGreaterThan(holds * 100);
    const fresh = open(join(root, '..', 'fresh.db'));
    await indexRepo(fresh, root, { force: true });
    expect(snapshot(db)).toEqual(snapshot(fresh));
  });
});
