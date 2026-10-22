import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DB,
  type EdgeKind,
  upsertFile,
  insertSymbols,
  insertImports,
  insertRefs,
  insertEdges,
  prepareCached,
  deleteImportsForFile,
  deleteRefsForFile,
  deleteFile,
  startRun,
  finishRun,
  counts,
  getLastRunStats,
  getFileByPath,
  nameBusy,
} from '../db/index.js';
import { acquireIndexLock } from './lock.js';
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
  // 'previous run interrupted': an index run started after the last finished one never finished.
  resolveReason:
    | 'forced'
    | 'files changed'
    | 'previous run interrupted'
    | 'resolver config changed'
    | 'no edges'
    | null;
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

// Runs on one DB file (or in-memory connection) queue: each starts after the previous settles,
// so no two runs snapshot `files` and insert the same symbols; other processes wait on the file lock.
// A call whose run kind matches a queued run that has not started joins it instead of queuing.
interface Queue {
  tail: Promise<void>;
  pending: Map<string, Promise<IndexStats>>;
}
const queues = new Map<unknown, Queue>();

// Index runs yield to the event loop at least this often, so timers, stdin and finalizers run.
const YIELD_MS = 50;

function dbFile(db: DB): string {
  try {
    return realpathSync(db.name);
  } catch {
    return resolve(db.name);
  }
}

// Calls with a progress callback never share a run: each caller sees its own files.
function runKind(root: string, opts: IndexOptions): string | undefined {
  if (opts.onFile) return undefined;
  const { force = false, skipEmbeddings = false, exclude, include, languages, maxBytes } = opts;
  return JSON.stringify([
    resolve(root),
    force,
    skipEmbeddings,
    exclude,
    include,
    languages,
    maxBytes,
  ]);
}

export function indexRepo(db: DB, root: string, opts: IndexOptions = {}): Promise<IndexStats> {
  const key = db.memory ? db : dbFile(db);
  let queue = queues.get(key);
  if (!queue) queues.set(key, (queue = { tail: Promise.resolve(), pending: new Map() }));
  const kind = runKind(root, opts);
  const joined = kind === undefined ? undefined : queue.pending.get(kind);
  if (joined) return joined;
  const { pending } = queue;
  const run = queue.tail
    .then(() => new Promise(setImmediate))
    .then(async () => {
      if (kind !== undefined) pending.delete(kind);
      const release = db.memory ? undefined : await acquireIndexLock(key as string);
      const step = { op: 'run stamp' };
      try {
        return await runIndex(db, root, opts, step);
      } catch (err) {
        nameBusy(err, step.op);
        throw err;
      } finally {
        release?.();
      }
    });
  if (kind !== undefined) pending.set(kind, run);
  const tail = (queue.tail = run.then(
    () => undefined,
    () => undefined,
  ));
  void tail.then(() => {
    if (queues.get(key)?.tail === tail) queues.delete(key);
  });
  return run;
}

function stampedExtractorVersion(statsJson: string | null): number | null {
  try {
    const v = (JSON.parse(statsJson ?? '{}') as { state?: { extractorVersion?: unknown } }).state
      ?.extractorVersion;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

type SymbolKey = { id: number; kind: string; name: string; qualified_name: string | null };

/**
 * Deleting a re-parsed file's symbols cascades to every edge touching them, and edges come back
 * only in `resolveGraph`; the run yields in between (SG34). So the edges are re-pointed at the
 * new symbols with the same kind and name (by occurrence), and readers keep the previous graph
 * until the resolve transaction replaces it (A17-03). Edges of vanished symbols are dropped.
 */
function carryEdges(db: DB, fileId: number): (() => void) | undefined {
  const symbols = (): SymbolKey[] =>
    prepareCached(
      db,
      "SELECT id, kind, name, qualified_name FROM symbols WHERE file_id = ? AND kind != 'module' ORDER BY id",
    ).all(fileId) as SymbolKey[];
  const edges = prepareCached(
    db,
    `SELECT src_symbol, dst_symbol, kind, weak, meta FROM edges
       WHERE src_symbol IN (SELECT id FROM symbols WHERE file_id = ? AND kind != 'module')
          OR dst_symbol IN (SELECT id FROM symbols WHERE file_id = ? AND kind != 'module')`,
  ).all(fileId, fileId) as {
    src_symbol: number | null;
    dst_symbol: number | null;
    kind: EdgeKind;
    weak: number;
    meta: string | null;
  }[];
  if (edges.length === 0) return undefined;
  const old = symbols();
  return () => {
    const key = (s: SymbolKey): string => `${s.kind}\0${s.qualified_name ?? s.name}`;
    const fresh = new Map<string, number[]>();
    for (const s of symbols()) fresh.set(key(s), [...(fresh.get(key(s)) ?? []), s.id]);
    const remap = new Map<number, number | undefined>(
      old.map((s) => [s.id, fresh.get(key(s))?.shift()]),
    );
    const to = (id: number | null): number | null | undefined =>
      id !== null && remap.has(id) ? remap.get(id) : id;
    insertEdges(
      db,
      edges.flatMap((e) => {
        const src = to(e.src_symbol);
        const dst = to(e.dst_symbol);
        return src === undefined || dst === undefined
          ? []
          : [{ src_symbol: src, dst_symbol: dst, kind: e.kind, weak: e.weak === 1, meta: e.meta }];
      }),
    );
  };
}

/** `step.op` names what the run is writing, for an `SQLITE_BUSY` error. */
async function runIndex(
  db: DB,
  root: string,
  opts: IndexOptions,
  step: { op: string },
): Promise<IndexStats> {
  const t0 = Date.now();
  let lastYield = t0;
  const yieldIfDue = async (always = false): Promise<void> => {
    if (!always && Date.now() - lastYield < YIELD_MS) return;
    await new Promise(setImmediate);
    lastYield = Date.now();
  };
  const prev = lastState(db);
  // Runs started after the last finished one never finished; each stamped its extractor version.
  const unfinished = db
    .prepare(
      'SELECT stats_json FROM runs WHERE finished_at IS NULL AND id > (SELECT COALESCE(MAX(id), 0) FROM runs WHERE finished_at IS NOT NULL)',
    )
    .pluck()
    .all() as (string | null)[];
  const interrupted = unfinished.length > 0;
  const anyFinished =
    db.prepare('SELECT 1 FROM runs WHERE finished_at IS NOT NULL').get() !== undefined;
  // Extractor versions that wrote the current rows. Runs from before the stamp count as unknown
  // only when no run has finished.
  const stamps = unfinished.map(stampedExtractorVersion);
  const writers =
    anyFinished || !interrupted
      ? [prev.extractorVersion, ...stamps.filter((v) => v !== null)]
      : stamps;
  const runId = startRun(db, null);
  db.prepare('UPDATE runs SET stats_json = ? WHERE id = ?').run(
    JSON.stringify({ state: { extractorVersion: EXTRACTOR_VERSION } }),
    runId,
  );
  step.op = 'index write';
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
  await yieldIfDue(true);

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
  const staleWriter = writers.find((v) => v !== EXTRACTOR_VERSION);
  const upgrade = existingByPath.size > 0 && staleWriter !== undefined;
  if (upgrade && !opts.force) stats.extractorUpgrade = { from: staleWriter, to: EXTRACTOR_VERSION };
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
    await yieldIfDue();
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
      // By path, not by the start-of-run snapshot: the row may be newer than the snapshot.
      const current = getFileByPath(db, file.relativePath);
      const carry = current ? carryEdges(db, current.id) : undefined;
      if (current) {
        deleteEmbeddingsForFile(db, current.id);
        // The module symbol is the resolver's (no parser emits one): keep it, and its edges.
        prepareCached(db, "DELETE FROM symbols WHERE file_id = ? AND kind != 'module'").run(
          current.id,
        );
        deleteImportsForFile(db, current.id);
        deleteRefsForFile(db, current.id);
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
      carry?.();
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

  await yieldIfDue(true);
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
  else if (interrupted) stats.resolveReason = 'previous run interrupted';
  else if (currentTotals.edges === 0) stats.resolveReason = 'no edges';
  else if (resolverFingerprint(root, indexedPaths(), prev.resolverInputs).hash !== fingerprint)
    stats.resolveReason = 'resolver config changed';
  let diagnostics = prev.resolverDiagnostics;
  let diagnosticCount = prev.resolverDiagnosticCount;
  if (stats.resolveReason !== null) {
    step.op = 'graph resolve';
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
    await yieldIfDue(true);
    step.op = 'embeddings write';
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
  step.op = 'run stamp';
  finishRun(db, runId, { ...stats, totals: counts(db), state });
  return stats;
}
