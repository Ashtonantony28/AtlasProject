// Embedding storage + retrieval, backed by a sqlite-vec vec0 virtual table.
//
// Schema (see migration v2 in core/db/schema.ts):
//   embeddings_vec  — vec0 virtual table, rowid = symbol_id, float[N] vector
//   embeddings_meta — symbol_id PK, model, dim (for tracking which model
//                     produced each row; vec0 doesn't carry metadata of its own)

import type { DB } from '../db/index.js';
import { EMBEDDING_DIM } from '../db/schema.js';

function vecBuffer(vec: Float32Array): Buffer {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding length ${vec.length} does not match schema dim ${EMBEDDING_DIM}`,
    );
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function upsertEmbedding(
  db: DB,
  symbolId: number,
  model: string,
  vec: Float32Array,
): void {
  const buf = vecBuffer(vec);
  const rowid = BigInt(symbolId);
  // vec0 supports INSERT OR REPLACE — clear the slot first to be explicit,
  // then insert. (UPDATE on vec0 requires you to drop the row first.)
  db.prepare('DELETE FROM embeddings_vec WHERE rowid = ?').run(rowid);
  db.prepare('INSERT INTO embeddings_vec(rowid, embedding) VALUES (?, ?)').run(rowid, buf);
  db.prepare(
    `INSERT INTO embeddings_meta(symbol_id, model, dim) VALUES (?, ?, ?)
     ON CONFLICT(symbol_id) DO UPDATE SET model = excluded.model, dim = excluded.dim`,
  ).run(symbolId, model, vec.length);
}

export interface StoredEmbedding {
  symbol_id: number;
  model: string;
  dim: number;
  vector: Float32Array;
}

export function getAllEmbeddings(db: DB): StoredEmbedding[] {
  const rows = db
    .prepare(
      `SELECT v.rowid AS symbol_id, m.model AS model, m.dim AS dim, v.embedding AS vec
       FROM embeddings_vec v JOIN embeddings_meta m ON m.symbol_id = v.rowid`,
    )
    .all() as Array<{ symbol_id: number | bigint; model: string; dim: number; vec: Buffer }>;
  return rows.map((r) => ({
    symbol_id: Number(r.symbol_id),
    model: r.model,
    dim: r.dim,
    vector: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim),
  }));
}

export function countEmbeddings(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM embeddings_meta').get() as { c: number };
  return row.c;
}

export function deleteEmbeddingsForFile(db: DB, fileId: number): void {
  // Collect symbol ids first so we can delete from both tables atomically.
  const rows = db
    .prepare('SELECT id FROM symbols WHERE file_id = ?')
    .all(fileId) as { id: number }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const idsBig = ids.map((i) => BigInt(i));
  db.prepare(`DELETE FROM embeddings_vec WHERE rowid IN (${placeholders})`).run(...idsBig);
  db.prepare(`DELETE FROM embeddings_meta WHERE symbol_id IN (${placeholders})`).run(...ids);
}

export function getEmbeddingMeta(
  db: DB,
  symbolId: number,
): { model: string; dim: number } | undefined {
  const row = db
    .prepare('SELECT model, dim FROM embeddings_meta WHERE symbol_id = ?')
    .get(symbolId) as { model: string; dim: number } | undefined;
  return row;
}

/**
 * KNN search: returns the top-N nearest symbols to `query` ordered by
 * vec0's L2 distance. Distance is converted to a similarity score in
 * [0, 1] so callers can blend it with structural signals.
 */
export function vectorKnn(
  db: DB,
  query: Float32Array,
  k: number,
): Array<{ symbolId: number; distance: number; similarity: number }> {
  const buf = vecBuffer(query);
  const rows = db
    .prepare(
      `SELECT rowid AS symbol_id, distance
       FROM embeddings_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(buf, k) as { symbol_id: number | bigint; distance: number }[];
  return rows.map((r) => ({
    symbolId: Number(r.symbol_id),
    distance: r.distance,
    // For L2-normalized unit vectors (our local embedder produces them),
    // distance^2 = 2 - 2*cos, so cos = 1 - distance^2 / 2. Clamp to [0, 1].
    similarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
  }));
}
