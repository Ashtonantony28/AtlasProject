// Hybrid search: combine cosine similarity (semantic) with a structural
// scoring boost (exact/substring name matches, kind/file filters).

import {
  type DB,
  getAllSymbols,
  getAllFiles,
  type SymbolKind,
  type SymbolRow,
} from '../db/index.js';
import { cosine } from './embedder.js';
import { getAllEmbeddings } from './store.js';
import type { Embedder } from './embedder.js';

export interface SearchOptions {
  kind?: SymbolKind | SymbolKind[];
  file?: string;
  limit?: number;
  // Weights: semantic (cosine) vs structural (name/path match). Default 0.6/0.4.
  semanticWeight?: number;
  structuralWeight?: number;
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
  const kindFilter: SymbolKind[] | null = opts.kind
    ? Array.isArray(opts.kind)
      ? opts.kind
      : [opts.kind]
    : null;

  const symbols = getAllSymbols(db);
  const files = new Map(getAllFiles(db).map((f) => [f.id, f]));
  const embeddings = new Map(getAllEmbeddings(db).map((e) => [e.symbol_id, e.vector]));

  const qLower = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const sym of symbols) {
    if (sym.kind === 'module') continue;
    if (kindFilter && !kindFilter.includes(sym.kind)) continue;
    const file = files.get(sym.file_id);
    if (!file) continue;
    if (opts.file && !file.path.includes(opts.file)) continue;

    const vec = embeddings.get(sym.id);
    const semantic = vec ? cosine(qVec, vec) : 0;
    const structural = structuralScore(qLower, sym, file.path);
    const total = semW * semantic + strW * structural;
    if (total <= 0) continue;
    hits.push({
      symbol: sym,
      filePath: file.path,
      semanticScore: semantic,
      structuralScore: structural,
      totalScore: total,
    });
  }

  hits.sort((a, b) => b.totalScore - a.totalScore);
  return hits.slice(0, limit);
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
