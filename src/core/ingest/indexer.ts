import { readFileSync } from 'node:fs';
import {
  type DB,
  upsertFile,
  insertSymbol,
  insertImport,
  insertRefs,
  deleteSymbolsForFile,
  deleteImportsForFile,
  deleteRefsForFile,
  deleteFile,
  startRun,
  finishRun,
  counts,
} from '../db/index.js';
import { walkRepo, type WalkOptions } from './walker.js';
import { sha256, countLoc } from './hash.js';
import { parseSource } from '../parse/parser.js';
import { resolveGraph } from '../graph/resolver.js';
import { embedAllSymbols, createEmbedder, deleteEmbeddingsForFile } from '../vector/index.js';
import { loadConfig } from '../config.js';
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
  filesWithDiagnostics: number; // indexed files whose parse reported syntax errors or partial results
  filesRemoved: number;
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
    filesWithDiagnostics: 0,
    filesRemoved: 0,
    symbols: 0,
    imports: 0,
    edges: 0,
    weakEdges: 0,
    embeddings: 0,
    durationMs: 0,
  };

  const files = walkRepo(root, opts);
  stats.filesScanned = files.length;

  const existingByPath = new Map(
    (
      db.prepare('SELECT id, path, content_hash FROM files').all() as {
        id: number;
        path: string;
        content_hash: string;
      }[]
    ).map((f) => [f.path, f]),
  );

  for (const file of files) {
    const existing = existingByPath.get(file.relativePath);
    existingByPath.delete(file.relativePath);

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
    if (!opts.force && existing && existing.content_hash === hash) {
      stats.filesSkipped++;
      opts.onFile?.({ path: file.relativePath, status: 'skipped', reason: 'unchanged' });
      continue;
    }

    // Parse before touching the DB: a failure leaves the previous rows and
    // hash in place so the next run retries.
    let parsed: Awaited<ReturnType<typeof parseSource>>;
    try {
      parsed = await parseSource(content, file.language as LanguageId, file.relativePath);
    } catch (err) {
      stats.filesFailed++;
      opts.onFile?.({
        path: file.relativePath,
        status: 'failed',
        reason: (err as Error).message,
      });
      continue;
    }

    db.transaction(() => {
      if (existing) {
        deleteEmbeddingsForFile(db, existing.id);
        deleteSymbolsForFile(db, existing.id);
        deleteImportsForFile(db, existing.id);
        deleteRefsForFile(db, existing.id);
      }
      const fileId = upsertFile(db, {
        path: file.relativePath,
        language: file.language,
        content_hash: hash,
        loc: countLoc(content),
      });
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
      }
      for (const imp of parsed.imports) {
        insertImport(db, {
          file_id: fileId,
          module: imp.module,
          imported: imp.imported,
          alias: imp.alias,
          start_line: imp.line,
          reexport: imp.reexport ?? false,
        });
      }
      insertRefs(
        db,
        fileId,
        parsed.references.map((r) => ({
          src_qualified_name: r.fromQualifiedName,
          name: r.name,
          receiver: r.receiver,
          object: r.object,
          kind: r.kind,
          line: r.line,
        })),
      );
    })();
    stats.symbols += parsed.symbols.length;
    stats.imports += parsed.imports.length;
    stats.filesIndexed++;
    const nDiag = parsed.diagnostics.length;
    if (nDiag > 0) stats.filesWithDiagnostics++;
    opts.onFile?.({
      path: file.relativePath,
      status: 'parsed',
      ...(nDiag > 0 ? { reason: `${nDiag} parse diagnostic${nDiag === 1 ? '' : 's'}` } : {}),
    });
  }

  // Prune paths the walk no longer returns (deleted, renamed or now ignored).
  if (existingByPath.size > 0) {
    db.transaction(() => {
      for (const { id } of existingByPath.values()) {
        deleteEmbeddingsForFile(db, id);
        deleteFile(db, id);
      }
    })();
    stats.filesRemoved = existingByPath.size;
  }

  // Resolve cross-file references and rebuild the edges table — only if
  // something actually changed (or the edges table is empty).
  const currentTotals = counts(db);
  const needsResolve =
    stats.filesIndexed > 0 ||
    stats.filesRemoved > 0 ||
    currentTotals.edges === 0 ||
    opts.force === true;
  if (needsResolve) {
    const resolveStats = resolveGraph(db, { root });
    stats.edges = resolveStats.edges;
    stats.weakEdges = resolveStats.weakEdges;
  } else {
    stats.edges = currentTotals.edges;
  }

  // Generate embeddings for any new/changed symbols. Local-only, no API spend.
  if (!opts.skipEmbeddings) {
    const embedder = createEmbedder(loadConfig(root));
    const embStats = await embedAllSymbols(db, embedder, root);
    stats.embeddings = embStats.generated;
  }

  stats.durationMs = Date.now() - t0;
  finishRun(db, runId, { ...stats, totals: counts(db) });
  return stats;
}
