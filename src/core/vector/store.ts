// Embedding storage + retrieval. Vectors are stored as raw Float32Array bytes
// (BLOB). For small repos this is plenty fast; we can swap in sqlite-vec later
// without touching callers above the store.

import type { DB } from '../db/index.js';

export function upsertEmbedding(db: DB, symbolId: number, model: string, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  const existing = db
    .prepare('SELECT symbol_id FROM embeddings WHERE symbol_id = ?')
    .get(symbolId);
  if (existing) {
    db.prepare(
      'UPDATE embeddings SET model = ?, dim = ?, vector = ? WHERE symbol_id = ?',
    ).run(model, vec.length, buf, symbolId);
  } else {
    db.prepare(
      'INSERT INTO embeddings (symbol_id, model, dim, vector) VALUES (?, ?, ?, ?)',
    ).run(symbolId, model, vec.length, buf);
  }
}

export function getAllEmbeddings(
  db: DB,
): Array<{ symbol_id: number; model: string; dim: number; vector: Float32Array }> {
  const rows = db
    .prepare('SELECT symbol_id, model, dim, vector FROM embeddings')
    .all() as Array<{ symbol_id: number; model: string; dim: number; vector: Buffer }>;
  return rows.map((r) => ({
    symbol_id: r.symbol_id,
    model: r.model,
    dim: r.dim,
    vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dim),
  }));
}

export function countEmbeddings(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
  return row.c;
}

export function deleteEmbeddingsForFile(db: DB, fileId: number): void {
  db.prepare(
    `DELETE FROM embeddings
     WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)`,
  ).run(fileId);
}
