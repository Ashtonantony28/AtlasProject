// Drift detection: compare the index's current state against stored docs.
//
// Two signals:
//   - stale: a doc whose stored source_hash differs from sha256 of the prompt
//     it would be generated from now (its grounding context moved on), or a
//     persisted doc whose file no longer exists, or a doc whose file on disk no
//     longer matches its indexed content hash (edited, or failed to re-index).
//     In DB mode a pruned file's doc survives as a tombstone until the next
//     `atlas docs`, so deletions are stale here too. Fatal in the CLI.
//   - undocumented: an exported symbol whose name (qualified or bare) does
//     not appear as a whole identifier in its file's doc, or a `module` entry
//     for a file with no doc and no exported symbols (e.g. added since), so
//     every undocumented file is listed. Reported only;
//     fatal with `strict` (`atlas drift --strict`).
//
// `hasDrift` is true when either list is non-empty; `failing` is the gate
// (stale docs, or undocumented symbols under `strict`) and is exactly when
// `atlas drift` exits 2.

import { type DB, getAllFiles, getSymbolsForFile } from '../db/index.js';
import { sha256 } from '../ingest/index.js';
import { readIndexedSource } from '../vector/index.js';
import {
  architecturePrompt,
  deletedDocsFromDb,
  docsFromDb,
  modulePrompt,
  type PersistedDoc,
} from '../synth/index.js';

export type StaleKind = 'file' | 'architecture';

export interface StaleDocReport {
  kind: StaleKind;
  targetId: number;
  targetPath: string; // file path or "architecture"
  storedHash: string;
  currentHash: string; // "missing" when the file no longer exists; "unindexed" when it changed since indexing
}

export interface UndocumentedSymbolReport {
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
}

export interface DriftReport {
  stale: StaleDocReport[];
  undocumented: UndocumentedSymbolReport[];
  totals: {
    files: number;
    docs: number;
    publicSymbols: number; // exported, non-module symbols
    stale: number;
    undocumented: number;
  };
  // Anything to report: stale docs or undocumented symbols.
  hasDrift: boolean;
  // The drift gate failed: stale docs, or undocumented symbols when `strict`.
  failing: boolean;
  strict: boolean;
  // `stale` or `undocumented` lists only part of the report (see `pageDriftReport`).
  truncated: boolean;
}

export interface DetectOptions {
  // Project root; needed to rebuild each module's prompt (source excerpts).
  root: string;
  // Skip the architecture-level drift check.
  skipArchitecture?: boolean;
  // Check these docs (e.g. read from `.atlas/docs`) instead of the docs table.
  docs?: PersistedDoc[];
  // Undocumented symbols also fail the gate (`failing`).
  strict?: boolean;
}

export function detectDrift(db: DB, opts: DetectOptions): DriftReport {
  const files = getAllFiles(db);
  const strict = opts.strict ?? false;
  const docs = opts.docs ?? [...deletedDocsFromDb(db), ...docsFromDb(db)];
  const fileDocs = new Map<string, PersistedDoc>();
  let archDoc: PersistedDoc | undefined;
  for (const d of docs) {
    if (d.kind === 'file') fileDocs.set(d.target, d);
    else archDoc = d;
  }

  const stale: StaleDocReport[] = [];
  const undocumented: UndocumentedSymbolReport[] = [];
  let publicSymbolCount = 0;
  const seen = new Set<string>();

  for (const file of files) {
    seen.add(file.path);
    const doc = fileDocs.get(file.path);
    if (doc) {
      const current = readIndexedSource(opts.root, file).changed
        ? 'unindexed'
        : sha256(modulePrompt(db, opts.root, file));
      if (doc.sourceHash !== current) {
        stale.push({
          kind: 'file',
          targetId: file.id,
          targetPath: file.path,
          storedHash: doc.sourceHash,
          currentHash: current,
        });
      }
    }

    const exported = getSymbolsForFile(db, file.id).filter(
      (s) => s.exported === 1 && s.kind !== 'module',
    );
    if (!doc && exported.length === 0) {
      undocumented.push({ file: file.path, symbol: file.path, kind: 'module', startLine: 1 });
    }
    publicSymbolCount += exported.length;
    for (const sym of exported) {
      const ref = sym.qualified_name ?? sym.name;
      if (doc && (mentions(doc.content, ref) || mentions(doc.content, sym.name))) continue;
      undocumented.push({
        file: file.path,
        symbol: ref,
        kind: sym.kind,
        startLine: sym.start_line,
      });
    }
  }

  for (const doc of fileDocs.values()) {
    if (seen.has(doc.target)) continue;
    stale.push({
      kind: 'file',
      targetId: 0,
      targetPath: doc.target,
      storedHash: doc.sourceHash,
      currentHash: 'missing',
    });
  }

  if (!opts.skipArchitecture && archDoc) {
    const expected = sha256(architecturePrompt(db));
    if (archDoc.sourceHash !== expected) {
      stale.push({
        kind: 'architecture',
        targetId: 0,
        targetPath: 'architecture',
        storedHash: archDoc.sourceHash,
        currentHash: expected,
      });
    }
  }

  return {
    stale,
    undocumented,
    totals: {
      files: files.length,
      docs: fileDocs.size + (archDoc ? 1 : 0),
      publicSymbols: publicSymbolCount,
      stale: stale.length,
      undocumented: undocumented.length,
    },
    hasDrift: stale.length > 0 || undocumented.length > 0,
    failing: stale.length > 0 || (strict && undocumented.length > 0),
    strict,
    truncated: false,
  };
}

/** Entries `offset`..`offset + limit` of each list; counts and the gate still cover the whole report. */
export function pageDriftReport(
  report: DriftReport,
  page: { offset: number; limit: number },
): DriftReport {
  const end = page.offset + page.limit;
  return {
    ...report,
    stale: report.stale.slice(page.offset, end),
    undocumented: report.undocumented.slice(page.offset, end),
    truncated:
      report.truncated ||
      page.offset > 0 ||
      end < report.totals.stale ||
      end < report.totals.undocumented,
  };
}

/** Whole-identifier, case-sensitive match (`get` does not match inside `target`). */
function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(haystack);
}

export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [];
  const { stale, undocumented } = report.totals;
  if (stale === 0 && undocumented === 0) {
    lines.push('no drift: docs are up to date and all public symbols documented.');
    lines.push(
      `totals: files=${report.totals.files} docs=${report.totals.docs} public symbols=${report.totals.publicSymbols}`,
    );
    return lines.join('\n');
  }
  if (report.stale.length > 0) {
    lines.push('Stale docs:');
    for (const s of report.stale) {
      lines.push(
        `  - [${s.kind}] ${s.targetPath}  (stored ${s.storedHash.slice(0, 8)}, current ${s.currentHash.slice(0, 8)})`,
      );
    }
  }
  if (report.undocumented.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Undocumented public symbols:');
    for (const u of report.undocumented) {
      lines.push(`  - [${u.kind}] ${u.symbol} (${u.file}:${u.startLine})`);
    }
  }
  lines.push('');
  if (report.truncated) {
    lines.push('');
    lines.push(
      `showing ${report.stale.length} of ${stale} stale, ${report.undocumented.length} of ${undocumented} undocumented (use offset/limit for more)`,
    );
  }
  lines.push(
    `summary: ${stale} stale, ${undocumented} undocumented (of ${report.totals.publicSymbols} public)`,
  );
  lines.push(
    report.failing
      ? 'drift check: failed'
      : 'drift check: passed (undocumented symbols fail only with --strict)',
  );
  return lines.join('\n');
}
