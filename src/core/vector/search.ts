// Hybrid search. Candidates are the union of vec0 KNN (semantic), FTS5 over
// symbols_fts plus an exact-name lookup (lexical); each candidate also gets a
// structural score (name/path/docstring hits). The three rankings are fused
// with Reciprocal Rank Fusion. --kind / --file filters are pushed into every
// candidate query, so they apply before truncation.

import { type DB, type SymbolKind, type SymbolRow } from '../db/index.js';
import { vectorKnn, vectorSimilarities } from './store.js';
import { tokenize, type Embedder } from './embedder.js';

export interface SearchOptions {
  kind?: SymbolKind | SymbolKind[];
  file?: string;
  limit?: number;
  // RRF weights: semantic list vs lexical (FTS + structural) lists. Default 0.6/0.4.
  semanticWeight?: number;
  structuralWeight?: number;
  // How many candidates each retriever contributes. Default = max(50, limit*8).
  candidatePoolSize?: number;
}

export interface SearchHit {
  symbol: SymbolRow;
  filePath: string;
  semanticScore: number;
  structuralScore: number;
  totalScore: number;
}

const RRF_K = 60;
// vec0 rejects k above 4096.
const MAX_KNN_K = 4096;
const MAX_TERMS = 16;

interface Filter {
  sql: string;
  params: unknown[];
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
  const poolSize = Math.min(MAX_KNN_K, opts.candidatePoolSize ?? Math.max(50, limit * 8));
  const filter = buildFilter(opts);

  const knn = vectorKnn(
    db,
    qVec,
    poolSize,
    filter
      ? {
          sql: `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE ${filter.sql}`,
          params: filter.params,
        }
      : undefined,
  ).filter((r) => r.similarity > 0);
  const lexical = [
    ...new Set([...exactIds(db, query, filter, poolSize), ...ftsIds(db, query, filter, poolSize)]),
  ];

  const similarity = new Map(knn.map((r) => [r.symbolId, r.similarity]));
  const missing = lexical.filter((id) => !similarity.has(id));
  for (const [id, sim] of vectorSimilarities(db, qVec, missing)) similarity.set(id, sim);

  const candidateIds = [...new Set([...knn.map((r) => r.symbolId), ...lexical])];
  const symbolById = loadSymbolsByIds(db, candidateIds);
  const qLower = query.toLowerCase();

  const hits: SearchHit[] = [];
  for (const id of candidateIds) {
    const row = symbolById.get(id);
    if (!row || row.symbol.kind === 'module') continue;
    hits.push({
      symbol: row.symbol,
      filePath: row.filePath,
      semanticScore: similarity.get(id) ?? 0,
      structuralScore: structuralScore(qLower, row.symbol, row.filePath),
      totalScore: 0,
    });
  }

  const fused = new Map<number, number>();
  const addList = (ids: number[], weight: number) =>
    ids.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + i + 1)));
  addList(
    knn.map((r) => r.symbolId),
    semW,
  );
  addList(lexical, strW);
  // Structural ranking uses competition ranks so equal scores tie.
  const structural = hits
    .filter((h) => h.structuralScore > 0)
    .sort((a, b) => b.structuralScore - a.structuralScore);
  let rank = 0;
  structural.forEach((h, i) => {
    if (i > 0 && h.structuralScore < structural[i - 1]!.structuralScore) rank = i;
    fused.set(h.symbol.id, (fused.get(h.symbol.id) ?? 0) + strW / (RRF_K + rank + 1));
  });

  for (const h of hits) h.totalScore = fused.get(h.symbol.id) ?? 0;
  return hits
    .filter((h) => h.totalScore > 0)
    .sort((a, b) => b.totalScore - a.totalScore || b.semanticScore - a.semanticScore)
    .slice(0, limit);
}

function buildFilter(opts: SearchOptions): Filter | null {
  const kinds = opts.kind ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : [];
  if (kinds.length === 0 && !opts.file) return null;
  const clauses = ["s.kind != 'module'"];
  const params: unknown[] = [];
  if (kinds.length > 0) {
    clauses.push(`s.kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (opts.file) {
    clauses.push('instr(f.path, ?) > 0');
    params.push(opts.file);
  }
  return { sql: clauses.join(' AND '), params };
}

function rawWords(query: string): string[] {
  return query.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
}

function exactIds(db: DB, query: string, filter: Filter | null, k: number): number[] {
  const names = [...new Set([query.trim(), ...rawWords(query)])].slice(0, MAX_TERMS);
  const rows = db
    .prepare(
      `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE (s.name IN (${names.map(() => '?').join(',')}) OR s.qualified_name = ?)
       ${filter ? `AND ${filter.sql}` : "AND s.kind != 'module'"}
       LIMIT ?`,
    )
    .all(...names, query.trim(), ...(filter?.params ?? []), k) as { id: number }[];
  return rows.map((r) => r.id);
}

// Builds an FTS5 query from identifier tokens only; each term is quoted and
// restricted to [a-z0-9], so user text can never inject FTS5 syntax.
function ftsQuery(query: string): string | null {
  const terms = new Set(tokenize(query));
  for (const w of rawWords(query)) {
    const lc = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (lc.length >= 2 && tokenize(w).length > 0) terms.add(lc);
  }
  const quoted = [...terms]
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((t) => `"${t}"`);
  return quoted.length > 0 ? quoted.join(' OR ') : null;
}

function ftsIds(db: DB, query: string, filter: Filter | null, k: number): number[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT s.id FROM symbols_fts
       JOIN symbols s ON s.id = symbols_fts.rowid
       JOIN files f ON f.id = s.file_id
       WHERE symbols_fts MATCH ? AND ${filter ? filter.sql : "s.kind != 'module'"}
       ORDER BY bm25(symbols_fts, 10.0, 5.0, 1.0)
       LIMIT ?`,
    )
    .all(match, ...(filter?.params ?? []), k) as { id: number }[];
  return rows.map((r) => r.id);
}

function loadSymbolsByIds(
  db: DB,
  ids: number[],
): Map<number, { symbol: SymbolRow; filePath: string }> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.id, s.file_id, s.kind, s.name, s.signature, s.start_line, s.end_line, s.docstring,
              s.qualified_name, s.exported, f.path AS file_path
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as Array<SymbolRow & { file_path: string }>;
  return new Map(
    rows.map(({ file_path, ...symbol }) => [symbol.id, { symbol, filePath: file_path }]),
  );
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
