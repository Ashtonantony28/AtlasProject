import { readFileSync } from 'node:fs';
import {
  type DB,
  upsertFile,
  insertSymbols,
  insertImports,
  insertRefs,
  deleteSymbolsForFile,
  deleteImportsForFile,
  deleteRefsForFile,
  deleteFile,
  startRun,
  finishRun,
  counts,
  getLastRunStats,
} from '../db/index.js';
import { DEFAULT_MAX_BYTES, walkRepoReport, type WalkOptions } from './walker.js';
import { sha256, countLoc } from './hash.js';
import { parseSourceOrThrow } from '../parse/parser.js';
import { resolveGraph } from '../graph/resolver.js';
import { resolverFingerprint } from '../graph/modules.js';
import { EXTRACTOR_VERSION } from '../parse/version.js';
import { embedAllSymbols, createEmbedder, deleteEmbeddingsForFile } from '../vector/index.js';
import { loadConfig } from '../config.js';
import type { LanguageId } from './language.js';

export interface IndexOptions extends WalkOptions {
  // Reparse even if content hash is unchanged.
  force?: boolean;
  // Skip embedding generation (useful for fast incremental runs).
  skipEmbeddings?: boolean;
  // Per-file callback for progress reporting.
  onFile?: (file: {
    path: string;
    status: 'parsed' | 'skipped' | 'failed';
    reason?: string;
  }) => void;
}

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesFailed: number;
  filesWithDiagnostics: number; // indexed files whose parse reported syntax errors or partial results
  filesRemoved: number;
  filesTooLarge: number; // over `maxBytes`: not indexed (also counted in filesSkipped)
  symbols: number;
  imports: number;
  edges: number;
  weakEdges: number;
  embeddings: number;
  durationMs: number;
  // Every file was re-parsed because the index was written by another extractor version
  // (`from` is null for an index older than the recorded version).
  extractorUpgrade?: { from: number | null; to: number };
  // Why edges were rebuilt this run; null when the stored graph was kept.
  resolveReason: 'forced' | 'files changed' | 'resolver config changed' | 'no edges' | null;
  // Unreadable or malformed resolver configs, ambiguous workspace packages (first
  // MAX_RESOLVER_DIAGNOSTICS); from the last resolve when this run kept the graph.
  resolverDiagnostics: string[];
  resolverDiagnosticCount: number;
}

export const MAX_RESOLVER_DIAGNOSTICS = 20;

// Kept in `runs.stats_json` under `state`; read back from the last finished run.
interface IndexState {
  extractorVersion: number | null;
  resolverFingerprint: string | null;
  resolverInputs: string[];
  resolverDiagnostics: string[];
  resolverDiagnosticCount: number;
}

function lastState(db: DB): IndexState {
  const raw = getLastRunStats(db).state;
  const st = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const diags = strings(st.resolverDiagnostics);
  return {
    extractorVersion: typeof st.extractorVersion === 'number' ? st.extractorVersion : null,
    resolverFingerprint: typeof st.resolverFingerprint === 'string' ? st.resolverFingerprint : null,
    resolverInputs: strings(st.resolverInputs),
    resolverDiagnostics: diags,
    resolverDiagnosticCount:
      typeof st.resolverDiagnosticCount === 'number' ? st.resolverDiagnosticCount : diags.length,
  };
}

export async function indexRepo(
  db: DB,
  root: string,
  opts: IndexOptions = {},
): Promise<IndexStats> {
  const t0 = Date.now();
  const prev = lastState(db);
  const runId = startRun(db, null);
  const stats: IndexStats = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    filesWithDiagnostics: 0,
    filesRemoved: 0,
    filesTooLarge: 0,
    symbols: 0,
    imports: 0,
    edges: 0,
    weakEdges: 0,
    embeddings: 0,
    durationMs: 0,
    resolveReason: null,
    resolverDiagnostics: [],
    resolverDiagnosticCount: 0,
  };

  const { files, unreadable, tooLarge } = walkRepoReport(root, opts);
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

  // Rows written by another extractor version are re-parsed even when the content is unchanged.
  const upgrade = existingByPath.size > 0 && prev.extractorVersion !== EXTRACTOR_VERSION;
  if (upgrade && !opts.force)
    stats.extractorUpgrade = { from: prev.extractorVersion, to: EXTRACTOR_VERSION };
  // During an upgrade, kept rows that are not re-parsed get a blank hash so the next run retries.
  const retry: number[] = [];

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  for (const { path, sizeBytes } of tooLarge) {
    stats.filesTooLarge++;
    stats.filesSkipped++;
    opts.onFile?.({
      path,
      status: 'skipped',
      reason: `too large: ${sizeBytes} bytes > ${maxBytes}`,
    });
  }

  // An unreadable directory or file is a failure, not a deletion: keep its rows.
  for (const { path, reason } of unreadable) {
    const isDir = path === '' || path.endsWith('/');
    for (const [indexed, row] of [...existingByPath]) {
      if (!(isDir ? indexed.startsWith(path) : indexed === path)) continue;
      existingByPath.delete(indexed);
      if (upgrade) retry.push(row.id);
    }
    stats.filesFailed++;
    opts.onFile?.({ path: path || '.', status: 'failed', reason: `unreadable: ${reason}` });
  }

  for (const file of files) {
    const existing = existingByPath.get(file.relativePath);
    existingByPath.delete(file.relativePath);

    let content: string;
    try {
      content = readFileSync(file.absolutePath, 'utf8');
    } catch (err) {
      if (upgrade && existing) retry.push(existing.id);
      stats.filesFailed++;
      opts.onFile?.({
        path: file.relativePath,
        status: 'failed',
        reason: (err as Error).message,
      });
      continue;
    }

    const hash = sha256(content);
    if (!opts.force && !upgrade && existing && existing.content_hash === hash) {
      stats.filesSkipped++;
      opts.onFile?.({ path: file.relativePath, status: 'skipped', reason: 'unchanged' });
      continue;
    }

    // Parse before touching the DB: a failure leaves the previous rows and
    // hash in place so the next run retries.
    let parsed: Awaited<ReturnType<typeof parseSourceOrThrow>>;
    try {
      parsed = await parseSourceOrThrow(content, file.language as LanguageId, file.relativePath);
    } catch (err) {
      if (upgrade && existing) retry.push(existing.id);
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
      insertSymbols(
        db,
        parsed.symbols.map((sym) => ({
          file_id: fileId,
          kind: sym.kind,
          name: sym.name,
          signature: sym.signature,
          start_line: sym.startLine,
          end_line: sym.endLine,
          docstring: sym.docstring,
          qualified_name: sym.qualifiedName,
          exported: sym.exported,
        })),
      );
      insertImports(
        db,
        parsed.imports.map((imp) => ({
          file_id: fileId,
          module: imp.module,
          imported: imp.imported,
          alias: imp.alias,
          start_line: imp.line,
          reexport: imp.reexport ?? false,
        })),
      );
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

  if (retry.length > 0) {
    const blank = db.prepare("UPDATE files SET content_hash = '' WHERE id = ?");
    db.transaction(() => {
      for (const id of retry) blank.run(id);
    })();
  }

  // Prune paths the walk no longer returns (deleted, renamed, now ignored or too large).
  if (existingByPath.size > 0) {
    db.transaction(() => {
      for (const { id } of existingByPath.values()) {
        deleteEmbeddingsForFile(db, id);
        deleteFile(db, id);
      }
    })();
    stats.filesRemoved = existingByPath.size;
  }

  // Resolve cross-file references and rebuild the edges table — only if a file or a
  // resolver input (configs, RESOLVER_VERSION) changed, or the edges table is empty.
  const currentTotals = counts(db);
  const indexedPaths = () => db.prepare('SELECT path FROM files').pluck().all() as string[];
  let fingerprint = prev.resolverFingerprint;
  let resolverInputs = prev.resolverInputs;
  if (opts.force === true) stats.resolveReason = 'forced';
  else if (stats.filesIndexed > 0 || stats.filesRemoved > 0) stats.resolveReason = 'files changed';
  else if (currentTotals.edges === 0) stats.resolveReason = 'no edges';
  else if (resolverFingerprint(root, indexedPaths(), prev.resolverInputs).hash !== fingerprint)
    stats.resolveReason = 'resolver config changed';
  let diagnostics = prev.resolverDiagnostics;
  let diagnosticCount = prev.resolverDiagnosticCount;
  if (stats.resolveReason !== null) {
    const resolveStats = resolveGraph(db, { root });
    stats.edges = resolveStats.edges;
    stats.weakEdges = resolveStats.weakEdges;
    diagnostics = resolveStats.diagnostics.slice(0, MAX_RESOLVER_DIAGNOSTICS);
    diagnosticCount = resolveStats.diagnostics.length;
    const fp = resolverFingerprint(root, indexedPaths(), resolveStats.configInputs);
    fingerprint = fp.hash;
    resolverInputs = fp.extraInputs;
  } else {
    stats.edges = currentTotals.edges;
  }
  stats.resolverDiagnostics = diagnostics;
  stats.resolverDiagnosticCount = diagnosticCount;

  // Generate embeddings for any new/changed symbols. Local-only, no API spend.
  if (!opts.skipEmbeddings) {
    const embedder = createEmbedder(loadConfig(root));
    const embStats = await embedAllSymbols(db, embedder, root);
    stats.embeddings = embStats.generated;
  }

  stats.durationMs = Date.now() - t0;
  const state: IndexState = {
    extractorVersion: EXTRACTOR_VERSION,
    resolverFingerprint: fingerprint,
    resolverInputs,
    resolverDiagnostics: diagnostics,
    resolverDiagnosticCount: diagnosticCount,
  };
  finishRun(db, runId, { ...stats, totals: counts(db), state });
  return stats;
}
