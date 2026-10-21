import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  getFileByPath,
  getSymbolsForFile,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { synthesizeDocs, createOfflineClient } from '../../src/core/synth/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

function rowsFor(db: DB, fileId: number, symbolIds: number[]): Record<string, number> {
  const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
  const ids = symbolIds.join(',') || '-1';
  return {
    files: n('SELECT COUNT(*) AS c FROM files WHERE id = ?', fileId),
    symbols: n('SELECT COUNT(*) AS c FROM symbols WHERE file_id = ?', fileId),
    imports: n('SELECT COUNT(*) AS c FROM imports WHERE file_id = ?', fileId),
    edges: n(
      `SELECT COUNT(*) AS c FROM edges WHERE src_symbol IN (${ids}) OR dst_symbol IN (${ids})`,
    ),
    embeddings_meta: n(`SELECT COUNT(*) AS c FROM embeddings_meta WHERE symbol_id IN (${ids})`),
    embeddings_vec: n(`SELECT COUNT(*) AS c FROM embeddings_vec WHERE rowid IN (${ids})`),
    docs: n("SELECT COUNT(*) AS c FROM docs WHERE target_kind = 'file' AND target_id = ?", fileId),
    fts: n(`SELECT COUNT(*) AS c FROM symbols_fts WHERE rowid IN (${ids})`),
  };
}

describe('indexRepo pruning', () => {
  let dir: string;
  let root: string;
  let db: DB;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-prune-'));
    root = join(dir, 'repo');
    cpSync(FIXTURE, root, { recursive: true });
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes every row of a deleted file', async () => {
    const file = getFileByPath(db, 'src/math.ts')!;
    const ids = getSymbolsForFile(db, file.id).map((s) => s.id);
    const before = rowsFor(db, file.id, ids);
    for (const k of [
      'files',
      'symbols',
      'edges',
      'embeddings_meta',
      'embeddings_vec',
      'docs',
      'fts',
    ]) {
      expect(before[k], k).toBeGreaterThan(0);
    }

    rmSync(join(root, 'src/math.ts'));
    const stats = await indexRepo(db, root);
    expect(stats.filesRemoved).toBe(1);
    expect(rowsFor(db, file.id, ids)).toEqual(
      Object.fromEntries(Object.keys(before).map((k) => [k, 0])),
    );
    expect(() =>
      db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });

  it('treats a rename as delete + add', async () => {
    const old = getFileByPath(db, 'src/shapes.ts')!;
    const ids = getSymbolsForFile(db, old.id).map((s) => s.id);
    renameSync(join(root, 'src/shapes.ts'), join(root, 'src/geometry.ts'));

    const stats = await indexRepo(db, root);
    expect(stats.filesRemoved).toBe(1);
    expect(stats.filesIndexed).toBe(1);
    expect(getFileByPath(db, 'src/shapes.ts')).toBeUndefined();
    const added = getFileByPath(db, 'src/geometry.ts')!;
    expect(getSymbolsForFile(db, added.id).map((s) => s.qualified_name)).toContain('Circle.area');
    const gone = rowsFor(db, old.id, ids);
    expect(gone.docs + gone.embeddings_vec + gone.embeddings_meta + gone.fts + gone.edges).toBe(0);
    expect(() =>
      db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
  });
});
