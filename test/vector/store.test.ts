import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { EMBEDDING_DIM } from '../../src/core/db/schema.js';
import { deleteEmbeddingsForFile } from '../../src/core/vector/index.js';

const FILES = 2_000;
const PER_FILE = 10;

function vecFor(id: number): Buffer {
  const v = new Float32Array(EMBEDDING_DIM);
  v[id % EMBEDDING_DIM] = 1;
  return Buffer.from(v.buffer);
}

describe('deleteEmbeddingsForFile at 20k embeddings (A2-03)', () => {
  let db: DB;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-store-'));
    db = openDatabase(join(dir, 'index.db'));
    const file = db.prepare(
      `INSERT INTO files(path, language, content_hash, indexed_at) VALUES (?, 'typescript', 'h', '')`,
    );
    const sym = db.prepare(
      `INSERT INTO symbols(file_id, kind, name, start_line, end_line) VALUES (?, 'function', ?, 1, 1)`,
    );
    const vec = db.prepare('INSERT INTO embeddings_vec(rowid, embedding) VALUES (?, ?)');
    const meta = db.prepare(
      `INSERT INTO embeddings_meta(symbol_id, model, dim) VALUES (?, 'm', ${EMBEDDING_DIM})`,
    );
    db.transaction(() => {
      for (let f = 0; f < FILES; f++) {
        const fileId = Number(file.run(`f${f}.ts`).lastInsertRowid);
        for (let s = 0; s < PER_FILE; s++) {
          const id = Number(sym.run(fileId, `fn${f}_${s}`).lastInsertRowid);
          vec.run(BigInt(id), vecFor(id));
          meta.run(id);
        }
      }
    })();
  }, 60_000);
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const idsOf = (fileId: number) =>
    (db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(fileId) as { id: number }[]).map(
      (r) => r.id,
    );

  it('removes exactly that file’s vec0 and meta rows', () => {
    expect(count('SELECT COUNT(*) AS c FROM embeddings_vec')).toBe(FILES * PER_FILE);
    const target = 1_234;
    const doomed = idsOf(target);
    expect(doomed).toHaveLength(PER_FILE);

    db.transaction(() => deleteEmbeddingsForFile(db, target))();

    expect(count('SELECT COUNT(*) AS c FROM embeddings_vec')).toBe(FILES * PER_FILE - PER_FILE);
    expect(count('SELECT COUNT(*) AS c FROM embeddings_meta')).toBe(FILES * PER_FILE - PER_FILE);
    const point = db.prepare('SELECT rowid FROM embeddings_vec WHERE rowid = ?');
    for (const id of doomed) expect(point.get(BigInt(id))).toBeUndefined();
    for (const id of [...idsOf(target - 1), ...idsOf(target + 1)])
      expect(point.get(BigInt(id))).toBeDefined();
    const missingMeta = count(
      `SELECT COUNT(*) AS c FROM symbols s LEFT JOIN embeddings_meta m ON m.symbol_id = s.id
       WHERE m.symbol_id IS NULL`,
    );
    expect(missingMeta).toBe(PER_FILE);
  });

  it('deletes vec0 rows by single rowid (vec0 scans every chunk for rowid IN)', () => {
    const sqls: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = ((sql: string) => (sqls.push(sql), prepare(sql))) as typeof db.prepare;
    const traced = new Proxy(db, {
      get: (t, p) => (p === 'prepare' ? spy : Reflect.get(t, p, t)),
    });
    deleteEmbeddingsForFile(traced, 1_500);
    const vecSql = sqls.filter((s) => /embeddings_vec/.test(s));
    expect(vecSql.length).toBeGreaterThan(0);
    for (const s of vecSql) expect(s).toMatch(/rowid\s*=\s*\?/);
  });

  it('is a no-op for a file with no symbols and is repeatable', () => {
    const before = count('SELECT COUNT(*) AS c FROM embeddings_vec');
    deleteEmbeddingsForFile(db, 999_999);
    deleteEmbeddingsForFile(db, 1_234);
    expect(count('SELECT COUNT(*) AS c FROM embeddings_vec')).toBe(before);
  });
});
