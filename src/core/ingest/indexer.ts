import { readFileSync } from 'node:fs';
import {
  type DB,
  upsertFile,
  insertSymbol,
  insertImport,
  deleteSymbolsForFile,
  deleteImportsForFile,
  startRun,
  finishRun,
  counts,
} from '../db/index.js';
import { walkRepo, type WalkOptions } from './walker.js';
import { sha256, countLoc } from './hash.js';
import { parseSource } from '../parse/parser.js';
import { resolveGraph } from '../graph/resolver.js';
import { embedAllSymbols, LocalHashEmbedder, deleteEmbeddingsForFile } from '../vector/index.js';
import type { LanguageId } from './language.js';

export interface IndexOptions extends WalkOptions {
  // Reparse even if content hash is unchanged.
  force?: boolean;
  // Skip embedding generation (useful for fast incremental runs).
  skipEmbeddings?: boolean;
  // Per-file callback for progress reporting.
  onFile?: (file: { path: string; status: 'parsed' | 'skipped' | 'failed'; reason?: string }) => void;
}

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesFailed: number;
  symbols: number;
  imports: number;
  edges: number;
  weakEdges: number;
  embeddings: number;
  durationMs: number;
}

export async function indexRepo(
  db: DB,
  root: string,
  opts: IndexOptions = {},
): Promise<IndexStats> {
  const t0 = Date.now();
  const runId = startRun(db, null);
  const stats: IndexStats = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    symbols: 0,
    imports: 0,
    edges: 0,
    weakEdges: 0,
    embeddings: 0,
    durationMs: 0,
  };

  const files = walkRepo(root, opts);
  stats.filesScanned = files.length;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.absolutePath, 'utf8');
    } catch (err) {
      stats.filesFailed++;
      opts.onFile?.({
        path: file.relativePath,
        status: 'failed',
        reason: (err as Error).message,
      });
      continue;
    }

    const hash = sha256(content);

    // Hash-based skip: only when not forcing AND the file exists with the
    // same hash. Cheaper than re-parsing on every run.
    const existing = db
      .prepare('SELECT id, content_hash FROM files WHERE path = ?')
      .get(file.relativePath) as { id: number; content_hash: string } | undefined;

    if (!opts.force && existing && existing.content_hash === hash) {
      stats.filesSkipped++;
      opts.onFile?.({ path: file.relativePath, status: 'skipped', reason: 'unchanged' });
      continue;
    }

    const fileId = upsertFile(db, {
      path: file.relativePath,
      language: file.language,
      content_hash: hash,
      loc: countLoc(content),
    });

    // Reparse: clear stale symbols/imports/embeddings for this file.
    deleteEmbeddingsForFile(db, fileId);
    deleteSymbolsForFile(db, fileId);
    deleteImportsForFile(db, fileId);

    try {
      const parsed = await parseSource(content, file.language as LanguageId);
      const insertAll = db.transaction(() => {
        for (const sym of parsed.symbols) {
          insertSymbol(db, {
            file_id: fileId,
            kind: sym.kind,
            name: sym.name,
            signature: sym.signature,
            start_line: sym.startLine,
            end_line: sym.endLine,
            docstring: sym.docstring,
            qualified_name: sym.qualifiedName,
            exported: sym.exported,
          });
          stats.symbols++;
        }
        for (const imp of parsed.imports) {
          insertImport(db, {
            file_id: fileId,
            module: imp.module,
            imported: imp.imported,
            alias: imp.alias,
            start_line: imp.line,
          });
          stats.imports++;
        }
      });
      insertAll();
      stats.filesIndexed++;
      opts.onFile?.({ path: file.relativePath, status: 'parsed' });
    } catch (err) {
      stats.filesFailed++;
      opts.onFile?.({
        path: file.relativePath,
        status: 'failed',
        reason: (err as Error).message,
      });
    }
  }

  // Resolve cross-file references and rebuild the edges table — only if
  // something actually changed (or the edges table is empty).
  const currentTotals = counts(db);
  const needsResolve = stats.filesIndexed > 0 || currentTotals.edges === 0 || opts.force === true;
  if (needsResolve) {
    const resolveStats = resolveGraph(db, { root });
    stats.edges = resolveStats.edges;
    stats.weakEdges = resolveStats.weakEdges;
  } else {
    stats.edges = currentTotals.edges;
  }

  // Generate embeddings for any new/changed symbols. Local-only, no API spend.
  if (!opts.skipEmbeddings) {
    const embedder = new LocalHashEmbedder();
    const embStats = await embedAllSymbols(db, embedder, root);
    stats.embeddings = embStats.generated;
  }

  stats.durationMs = Date.now() - t0;
  finishRun(db, runId, { ...stats, totals: counts(db) });
  return stats;
}
