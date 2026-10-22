import {
  type DB,
  getAllSymbols,
  getAllFiles,
} from '../db/index.js';
import { upsertEmbedding, countEmbeddings } from './store.js';
import { buildSymbolText, makeSourceLoader } from './textForSymbol.js';
import type { Embedder } from './embedder.js';

export interface EmbedAllOptions {
  force?: boolean;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EmbedAllStats {
  generated: number;
  skipped: number;
  total: number;
  model: string;
  dim: number;
  durationMs: number;
}

// Yield to the event loop between batches at least this often (A18-02).
const YIELD_MS = 50;

/**
 * Embed every (non-module) symbol that does not yet have an embedding for the
 * current model. With force=true, re-embed everything.
 */
export async function embedAllSymbols(
  db: DB,
  embedder: Embedder,
  root: string,
  opts: EmbedAllOptions = {},
): Promise<EmbedAllStats> {
  const t0 = Date.now();
  const batch = opts.batchSize ?? 32;
  const symbols = getAllSymbols(db).filter((s) => s.kind !== 'module');
  const files = new Map(getAllFiles(db).map((f) => [f.id, f]));
  const loadSource = makeSourceLoader(root);

  // Find which symbols still need embeddings.
  const existing = new Map<number, string>(
    (db.prepare('SELECT symbol_id, model FROM embeddings_meta').all() as
      { symbol_id: number; model: string }[])
      .map((r) => [r.symbol_id, r.model]),
  );

  const targets = symbols.filter(
    (s) => opts.force || existing.get(s.id) !== embedder.model,
  );

  const stats: EmbedAllStats = {
    generated: 0,
    skipped: symbols.length - targets.length,
    total: symbols.length,
    model: embedder.model,
    dim: embedder.dim,
    durationMs: 0,
  };

  let lastYield = Date.now();
  for (let i = 0; i < targets.length; i += batch) {
    if (Date.now() - lastYield >= YIELD_MS) {
      await new Promise(setImmediate);
      lastYield = Date.now();
    }
    const chunk = targets.slice(i, i + batch);
    const texts = chunk.map((sym) => {
      const file = files.get(sym.file_id);
      const source = file ? loadSource(sym.file_id, file.path) : null;
      return buildSymbolText(sym, { path: file?.path ?? '' }, source);
    });
    const vecs = await embedder.embed(texts);
    const tx = db.transaction(() => {
      for (let k = 0; k < chunk.length; k++) {
        const sym = chunk[k]!;
        const vec = vecs[k]!;
        upsertEmbedding(db, sym.id, embedder.model, vec);
        stats.generated++;
      }
    });
    tx();
    opts.onProgress?.(stats.generated, targets.length);
  }

  stats.durationMs = Date.now() - t0;
  // Sanity check: counts match
  if (countEmbeddings(db) < stats.generated) {
    // Should never happen — every upsert is a write.
    throw new Error('embedding write did not persist');
  }
  return stats;
}
