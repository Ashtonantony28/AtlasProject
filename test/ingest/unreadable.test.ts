// SG17: a path the walk cannot read is a failure, not a deletion. Its rows stay, it is
// counted in `filesFailed`, and the next clean run picks it up again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  counts,
  getDocTombstones,
  getFileByPath,
  getSymbolsForFile,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo, type IndexOptions } from '../../src/core/ingest/index.js';
import { createOfflineClient, synthesizeDocs } from '../../src/core/synth/index.js';

// Fault injection by absolute path, off unless a test sets it.
const fault = vi.hoisted(() => ({
  readdir: null as string | null,
  stat: null as string | null,
  read: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const failing = <F extends (...a: never[]) => unknown>(
    fn: F,
    key: keyof typeof fault,
    code: string,
  ): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (fault[key] !== null && String(path) === fault[key]) {
        throw Object.assign(new Error(`${code}: injected, '${String(path)}'`), { code });
      }
      return (fn as unknown as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as F;
  const readdirSync = failing(real.readdirSync, 'readdir', 'EACCES');
  const statSync = failing(real.statSync, 'stat', 'EIO');
  const readFileSync = failing(real.readFileSync, 'read', 'EACCES');
  const patched = { readdirSync, statSync, readFileSync };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  fault.readdir = fault.stat = fault.read = null;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { root: string; db: DB } {
  const base = mkdtempSync(join(tmpdir(), 'atlas-unreadable-'));
  dirs.push(base);
  const root = join(base, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const db = openDatabase(join(base, 'index.db'));
  dbs.push(db);
  return { root, db };
}

const FILES = {
  'a.ts': "import { b } from './lib/b';\nexport function a(): number { return b(); }\n",
  'lib/b.ts': 'export function b(): number { return 2; }\n',
  'library.ts': 'export function lib(): number { return 3; }\n',
};

async function index(db: DB, root: string) {
  const failed: Parameters<NonNullable<IndexOptions['onFile']>>[0][] = [];
  const stats = await indexRepo(db, root, {
    skipEmbeddings: true,
    onFile: (e) => e.status === 'failed' && failed.push(e),
  });
  return { stats, failed };
}

const names = (db: DB, fileId: number) =>
  getSymbolsForFile(db, fileId)
    .map((s) => s.name)
    .sort();

describe('indexRepo on unreadable paths', () => {
  it('keeps the rows and docs under an unreadable directory and reports it once', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    const before = getFileByPath(db, 'lib/b.ts')!;
    const docs = counts(db).docs;
    expect(docs).toBeGreaterThan(0);

    fault.readdir = join(root, 'lib');
    const { stats, failed } = await index(db, root);
    expect(stats).toMatchObject({ filesFailed: 1, filesRemoved: 0 });
    expect(failed).toEqual([
      { path: 'lib/', status: 'failed', reason: expect.stringContaining('EACCES') },
    ]);
    expect(getFileByPath(db, 'lib/b.ts')).toEqual(before);
    expect(names(db, before.id)).toEqual(['b', 'lib/b.ts']);
    expect(getDocTombstones(db)).toEqual([]);
    expect(counts(db).docs).toBe(docs);

    fault.readdir = null;
    const healed = await index(db, root);
    expect(healed.stats).toMatchObject({ filesFailed: 0, filesRemoved: 0, filesSkipped: 3 });
  });

  it('protects only paths under the unreadable directory, not siblings sharing its prefix', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    unlinkSync(join(root, 'library.ts'));
    fault.readdir = join(root, 'lib');
    const { stats } = await index(db, root);
    expect(stats).toMatchObject({ filesFailed: 1, filesRemoved: 1 });
    expect(getFileByPath(db, 'library.ts')).toBeUndefined();
    expect(getFileByPath(db, 'lib/b.ts')).toBeDefined();
  });

  it('keeps the whole index when the root is unreadable', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    fault.readdir = root;
    const { stats, failed } = await index(db, root);
    expect(stats).toMatchObject({ filesScanned: 0, filesFailed: 1, filesRemoved: 0 });
    expect(failed.map((f) => f.path)).toEqual(['.']);
    for (const p of Object.keys(FILES)) expect(getFileByPath(db, p)).toBeDefined();
  });

  it('keeps the rows of a file that fails to stat', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    const before = getFileByPath(db, 'lib/b.ts');
    fault.stat = join(root, 'lib', 'b.ts');
    const { stats, failed } = await index(db, root);
    expect(stats).toMatchObject({ filesFailed: 1, filesRemoved: 0 });
    expect(failed.map((f) => f.path)).toEqual(['lib/b.ts']);
    expect(getFileByPath(db, 'lib/b.ts')).toEqual(before);
  });

  it('keeps the rows of a walked file whose read fails, then re-indexes it on a clean run', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    const before = getFileByPath(db, 'lib/b.ts')!;
    writeFileSync(join(root, 'lib', 'b.ts'), 'export function b2(): number { return 3; }\n');
    fault.read = join(root, 'lib', 'b.ts');
    const { stats, failed } = await index(db, root);
    expect(stats).toMatchObject({ filesScanned: 3, filesFailed: 1, filesRemoved: 0 });
    expect(failed).toEqual([
      { path: 'lib/b.ts', status: 'failed', reason: expect.stringContaining('EACCES') },
    ]);
    expect(getFileByPath(db, 'lib/b.ts')).toEqual(before);
    expect(names(db, before.id)).toEqual(['b', 'lib/b.ts']);

    fault.read = null;
    const retried = await index(db, root);
    expect(retried.stats).toMatchObject({ filesFailed: 0, filesIndexed: 1, filesRemoved: 0 });
    expect(names(db, before.id)).toEqual(['b2', 'lib/b.ts']);
  });
});
