// Drift detection: compare the index's current state against stored docs.
//
// Two signals:
//   - stale: a doc whose stored source_hash differs from sha256 of the prompt
//     it would be generated from now (its grounding context moved on), or a
//     persisted doc whose file no longer exists, or a doc whose file on disk no
//     longer matches its indexed content hash (edited, or failed to re-index).
//     Fatal in the CLI.
//   - undocumented: an exported symbol whose name (qualified or bare) does
//     not appear as a whole identifier in its file's doc. Reported only;
//     fatal with `atlas drift --strict`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DB, type FileRow, getAllFiles, getSymbolsForFile } from '../db/index.js';
import { sha256 } from '../ingest/index.js';
import {
  architecturePrompt,
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
  };
  hasDrift: boolean;
}

export interface DetectOptions {
  // Project root; needed to rebuild each module's prompt (source excerpts).
  root: string;
  // Skip the architecture-level drift check.
  skipArchitecture?: boolean;
  // Check these docs (e.g. read from `.atlas/docs`) instead of the docs table.
  docs?: PersistedDoc[];
}

export function detectDrift(db: DB, opts: DetectOptions): DriftReport {
  const files = getAllFiles(db);
  const docs = opts.docs ?? docsFromDb(db);
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
      const current = indexedContentChanged(opts.root, file)
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
    publicSymbolCount += exported.length;
    for (const sym of exported) {
      const ref = sym.qualified_name ?? sym.name;
      if (doc && (mentions(doc.content, ref) || mentions(doc.content, sym.name))) continue;
      undocumented.push({ file: file.path, symbol: ref, kind: sym.kind, startLine: sym.start_line });
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
    totals: { files: files.length, docs: docs.length, publicSymbols: publicSymbolCount },
    hasDrift: stale.length > 0 || undocumented.length > 0,
  };
}

/** The index is behind the file (edited since, or its re-index failed and kept the old rows). */
function indexedContentChanged(root: string, file: FileRow): boolean {
  let content: string;
  try {
    content = readFileSync(join(root, file.path), 'utf8');
  } catch {
    return false; // unreadable or deleted: the prompt check and pruning cover it
  }
  return sha256(content) !== file.content_hash;
}

/** Whole-identifier, case-sensitive match (`get` does not match inside `target`). */
function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(haystack);
}

export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [];
  if (report.stale.length === 0 && report.undocumented.length === 0) {
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
  lines.push(
    `summary: ${report.stale.length} stale, ${report.undocumented.length} undocumented (of ${report.totals.publicSymbols} public)`,
  );
  return lines.join('\n');
}
