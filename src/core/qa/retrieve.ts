// Retrieval for Q&A. Combines:
//   - hybrid search to find the seed symbols,
//   - one-hop graph expansion (callers/callees, heritage) over the seeds,
//     ranked resolved-before-weak, then extends > implements > calls > imports > references,
//   - source excerpts covering each symbol's full span, capped at `excerptLines` lines.

import {
  type DB,
  type EdgeKind,
  type EdgeRow,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  type SymbolRow,
  type FileRow,
} from '../db/index.js';
import { createEmbedder, search } from '../vector/index.js';
import { loadConfig } from '../config.js';
import { readIndexedSource } from '../vector/index.js';

export interface RetrievedSnippet {
  symbol: SymbolRow;
  file: FileRow;
  score: number;
  excerpt: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  reason: 'search' | 'graph';
}

export interface RetrieveOptions {
  seedLimit?: number;
  expansionLimit?: number;
  /** Per-snippet line cap; a longer symbol is cut and marked as truncated. */
  excerptLines?: number;
}

const DEFAULT_SEED_LIMIT = 5;
const DEFAULT_EXPANSION = 5;
export const DEFAULT_EXCERPT_LINES = 120;
const KIND_RANK: Record<EdgeKind, number> = {
  extends: 0,
  implements: 1,
  calls: 2,
  imports: 3,
  references: 4,
};

export async function retrieveForQuery(
  db: DB,
  root: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedSnippet[]> {
  return (await retrieve(db, root, query, opts)).snippets;
}

/** `retrieveForQuery`, plus the paths whose snippets were left out because the file changed since indexing. */
export async function retrieve(
  db: DB,
  root: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<{ snippets: RetrievedSnippet[]; changed: string[] }> {
  const seedLimit = opts.seedLimit ?? DEFAULT_SEED_LIMIT;
  const expansionLimit = opts.expansionLimit ?? DEFAULT_EXPANSION;
  const excerptLines = opts.excerptLines ?? DEFAULT_EXCERPT_LINES;

  const embedder = createEmbedder(loadConfig(root));
  const hits = await search(db, embedder, query, { limit: seedLimit });
  const fileById = new Map(getAllFiles(db).map((f) => [f.id, f]));
  const symbolById = new Map(getAllSymbols(db).map((s) => [s.id, s]));
  const edges = getAllEdges(db);

  const seen = new Set<number>();
  const out: RetrievedSnippet[] = [];

  const fileSourceCache = new Map<number, string | null>();
  const changed: string[] = [];
  const sourceFor = (file: FileRow): string | null => {
    if (fileSourceCache.has(file.id)) return fileSourceCache.get(file.id) ?? null;
    const read = readIndexedSource(root, file);
    if (read.changed) changed.push(file.path);
    fileSourceCache.set(file.id, read.source);
    return read.source;
  };

  const add = (sym: SymbolRow, score: number, reason: 'search' | 'graph') => {
    if (seen.has(sym.id)) return;
    const file = fileById.get(sym.file_id);
    if (!file) return;
    const source = sourceFor(file);
    if (!source) return;
    const lines = source.split('\n');
    const start = Math.min(lines.length, Math.max(1, sym.start_line));
    const fullEnd = Math.min(lines.length, Math.max(start, sym.end_line));
    const end = Math.min(fullEnd, start + Math.max(1, excerptLines) - 1);
    const truncated = end < fullEnd;
    let excerpt = lines.slice(start - 1, end).join('\n');
    if (truncated)
      excerpt += `\n… [truncated: ${fullEnd - end} more lines through line ${fullEnd}]`;
    seen.add(sym.id);
    out.push({
      symbol: sym,
      file,
      score,
      excerpt,
      startLine: start,
      endLine: end,
      truncated,
      reason,
    });
  };

  // Seed
  for (const hit of hits) {
    add(hit.symbol, hit.totalScore, 'search');
  }

  // One-hop graph expansion: callers/callees + heritage from each seed, strongest edge first.
  const seedRank = new Map(out.map((o, i) => [o.symbol.id, i]));
  const best = new Map<number, { edge: EdgeRow; seed: number }>();
  for (const e of edges) {
    if (e.src_symbol === null || e.dst_symbol === null) continue;
    const fromSrc = seedRank.get(e.src_symbol);
    const fromDst = seedRank.get(e.dst_symbol);
    const [candidateId, seed] =
      fromSrc !== undefined ? [e.dst_symbol, fromSrc] : [e.src_symbol, fromDst];
    if (seed === undefined || seen.has(candidateId)) continue;
    const prev = best.get(candidateId);
    if (!prev || compareExpansion({ edge: e, seed }, prev) < 0)
      best.set(candidateId, { edge: e, seed });
  }
  const ranked = [...best.entries()].sort((a, b) => compareExpansion(a[1], b[1]));
  let added = 0;
  for (const [candidateId] of ranked) {
    if (added >= expansionLimit) break;
    const sym = symbolById.get(candidateId);
    if (!sym || sym.kind === 'module') continue;
    const before = out.length;
    add(sym, 0, 'graph');
    if (out.length > before) added++;
  }

  return { snippets: out, changed };
}

function compareExpansion(
  a: { edge: EdgeRow; seed: number },
  b: { edge: EdgeRow; seed: number },
): number {
  return (
    a.edge.weak - b.edge.weak ||
    KIND_RANK[a.edge.kind] - KIND_RANK[b.edge.kind] ||
    a.seed - b.seed ||
    a.edge.id - b.edge.id
  );
}
