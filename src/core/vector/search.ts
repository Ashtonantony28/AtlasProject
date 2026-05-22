// Hybrid search: vec0 KNN over the embeddings table for the semantic side,
// blended with a structural score (exact/substring name + path + docstring
// hits). Filters by --kind / --file run after KNN since vec0 has no support
// for arbitrary WHERE predicates on joined columns.

import {
  type DB,
  getAllFiles,
  type SymbolKind,
  type SymbolRow,
} from '../db/index.js';
import { vectorKnn } from './store.js';
import type { Embedder } from './embedder.js';

export interface SearchOptions {
  kind?: SymbolKind | SymbolKind[];
  file?: string;
  limit?: number;
  // Weights: semantic vs structural. Default 0.6/0.4.
  semanticWeight?: number;
  structuralWeight?: number;
  // How many candidates to ask KNN for before re-ranking. Default = limit*8.
  candidatePoolSize?: number;
}

export interface SearchHit {
  symbol: SymbolRow;
  filePath: string;
  semanticScore: number;
  structuralScore: number;
  totalScore: number;
}

export async function search(
  db: DB,
  embedder: Embedder,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const [qVec] = await embedder.embed([query]);
  if (!qVec) return [];

  const limit = opts.limit ?? 10;
  const semW = opts.semanticWeight ?? 0.6;
  const strW = opts.structuralWeight ?? 0.4;
  const poolSize = opts.candidatePoolSize ?? Math.max(50, limit * 8);
  const kindFilter: SymbolKind[] | null = opts.kind
    ? Array.isArray(opts.kind)
      ? opts.kind
      : [opts.kind]
    : null;

  // KNN candidates: top-pool by semantic similarity.
  const knn = vectorKnn(db, qVec, poolSize);
  if (knn.length === 0) return [];

  // Hydrate symbol + file rows for the candidates.
  const symbolById = loadSymbolsByIds(
    db,
    knn.map((r) => r.symbolId),
  );
  const files = new Map(getAllFiles(db).map((f) => [f.id, f]));

  const qLower = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const cand of knn) {
    const sym = symbolById.get(cand.symbolId);
    if (!sym) continue;
    if (sym.kind === 'module') continue;
    if (kindFilter && !kindFilter.includes(sym.kind)) continue;
    const file = files.get(sym.file_id);
    if (!file) continue;
    if (opts.file && !file.path.includes(opts.file)) continue;

    const structural = structuralScore(qLower, sym, file.path);
    const total = semW * cand.similarity + strW * structural;
    if (total <= 0) continue;
    hits.push({
      symbol: sym,
      filePath: file.path,
      semanticScore: cand.similarity,
      structuralScore: structural,
      totalScore: total,
    });
  }

  hits.sort((a, b) => b.totalScore - a.totalScore);
  return hits.slice(0, limit);
}

function loadSymbolsByIds(db: DB, ids: number[]): Map<number, SymbolRow> {
  if (ids.length === 0) return new Map();
  // SQLite IN-list with bound parameters.
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, file_id, kind, name, signature, start_line, end_line, docstring, qualified_name
       FROM symbols WHERE id IN (${placeholders})`,
    )
    .all(...ids) as SymbolRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function structuralScore(qLower: string, sym: SymbolRow, filePath: string): number {
  const nameLower = sym.name.toLowerCase();
  const qnameLower = (sym.qualified_name ?? sym.name).toLowerCase();
  let score = 0;
  if (nameLower === qLower) score += 1.0;
  else if (nameLower.includes(qLower)) score += 0.5;
  else if (qnameLower.includes(qLower)) score += 0.3;
  if (filePath.toLowerCase().includes(qLower)) score += 0.1;
  if (sym.docstring && sym.docstring.toLowerCase().includes(qLower)) score += 0.2;
  return Math.min(score, 1.0);
}

