// Retrieval for Q&A. Combines:
//   - hybrid search to find the seed symbols,
//   - one-hop graph expansion (callers/callees, heritage) over the seeds,
//   - source excerpts for the final set.

import {
  type DB,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  type SymbolRow,
  type FileRow,
} from '../db/index.js';
import { LocalHashEmbedder, search } from '../vector/index.js';
import { readFileFromRoot } from '../vector/index.js';

export interface RetrievedSnippet {
  symbol: SymbolRow;
  file: FileRow;
  score: number;
  excerpt: string;
  startLine: number;
  endLine: number;
  reason: 'search' | 'graph';
}

export interface RetrieveOptions {
  seedLimit?: number;
  expansionLimit?: number;
  excerptLines?: number;
}

const DEFAULT_SEED_LIMIT = 5;
const DEFAULT_EXPANSION = 5;
const DEFAULT_EXCERPT_LINES = 25;

export async function retrieveForQuery(
  db: DB,
  root: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedSnippet[]> {
  const seedLimit = opts.seedLimit ?? DEFAULT_SEED_LIMIT;
  const expansionLimit = opts.expansionLimit ?? DEFAULT_EXPANSION;
  const excerptLines = opts.excerptLines ?? DEFAULT_EXCERPT_LINES;

  const embedder = new LocalHashEmbedder();
  const hits = await search(db, embedder, query, { limit: seedLimit });
  const fileById = new Map(getAllFiles(db).map((f) => [f.id, f]));
  const symbolById = new Map(getAllSymbols(db).map((s) => [s.id, s]));
  const edges = getAllEdges(db);

  const seen = new Set<number>();
  const out: RetrievedSnippet[] = [];

  const fileSourceCache = new Map<number, string | null>();
  const sourceFor = (fileId: number): string | null => {
    if (fileSourceCache.has(fileId)) return fileSourceCache.get(fileId) ?? null;
    const src = readFileFromRoot(root, db, fileId);
    fileSourceCache.set(fileId, src);
    return src;
  };

  const add = (sym: SymbolRow, score: number, reason: 'search' | 'graph') => {
    if (seen.has(sym.id)) return;
    const file = fileById.get(sym.file_id);
    if (!file) return;
    const source = sourceFor(file.id);
    if (!source) return;
    const lines = source.split('\n');
    const start = Math.max(1, sym.start_line);
    const end = Math.min(lines.length, sym.start_line + excerptLines);
    const excerpt = lines.slice(start - 1, end).join('\n');
    seen.add(sym.id);
    out.push({ symbol: sym, file, score, excerpt, startLine: start, endLine: end, reason });
  };

  // Seed
  for (const hit of hits) {
    add(hit.symbol, hit.totalScore, 'search');
  }

  // One-hop graph expansion: callers/callees + heritage from each seed.
  const seedIds = new Set(out.map((o) => o.symbol.id));
  let added = 0;
  for (const e of edges) {
    if (added >= expansionLimit) break;
    let candidateId: number | null = null;
    if (e.src_symbol && seedIds.has(e.src_symbol) && e.dst_symbol) {
      candidateId = e.dst_symbol;
    } else if (e.dst_symbol && seedIds.has(e.dst_symbol) && e.src_symbol) {
      candidateId = e.src_symbol;
    }
    if (candidateId === null || seen.has(candidateId)) continue;
    const sym = symbolById.get(candidateId);
    if (!sym || sym.kind === 'module') continue;
    add(sym, 0, 'graph');
    added++;
  }

  return out;
}
