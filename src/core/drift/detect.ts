// Drift detection: compare the index's current state against stored docs.
//
// Two signals:
//   - stale: a doc exists for a file whose current content_hash differs from
//     the doc's stored source_hash (the source moved on; the doc didn't).
//   - undocumented: a public symbol (kind in {function, class, interface,
//     type, method}) in a file that has no doc at all, OR a top-level
//     public symbol whose file-level doc is missing.
//
// Drift exits non-zero in the CLI; that's the CI signal.

import {
  type DB,
  getAllFiles,
  getAllDocs,
  getSymbolsForFile,
  type FileRow,
  type SymbolRow,
} from '../db/index.js';
import { sha256 } from '../ingest/index.js';
import { buildArchitectureContext, architectureContextToPrompt } from '../graph/context.js';

export type StaleKind = 'file' | 'architecture';

export interface StaleDocReport {
  kind: StaleKind;
  targetId: number;
  targetPath: string; // file path or "architecture"
  storedHash: string;
  currentHash: string;
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
    publicSymbols: number;
  };
  hasDrift: boolean;
}

const PUBLIC_KINDS = new Set(['function', 'class', 'interface', 'type', 'method']);

export interface DetectOptions {
  // Skip the architecture-level drift check.
  skipArchitecture?: boolean;
}

export function detectDrift(db: DB, opts: DetectOptions = {}): DriftReport {
  const files = getAllFiles(db);
  const docs = getAllDocs(db);
  const fileDocByFileId = new Map<number, (typeof docs)[number]>();
  let archDoc: (typeof docs)[number] | undefined;
  for (const d of docs) {
    if (d.target_kind === 'file') fileDocByFileId.set(d.target_id, d);
    else if (d.target_kind === 'architecture') archDoc = d;
  }

  const stale: StaleDocReport[] = [];
  const undocumented: UndocumentedSymbolReport[] = [];
  let publicSymbolCount = 0;

  for (const file of files) {
    const doc = fileDocByFileId.get(file.id);
    if (doc && doc.source_hash !== file.content_hash) {
      stale.push({
        kind: 'file',
        targetId: file.id,
        targetPath: file.path,
        storedHash: doc.source_hash,
        currentHash: file.content_hash,
      });
    }

    const symbols = getSymbolsForFile(db, file.id);
    const publicSyms = symbols.filter((s) => PUBLIC_KINDS.has(s.kind));
    publicSymbolCount += publicSyms.length;
    if (publicSyms.length === 0) continue;

    if (!doc) {
      // The file has public symbols but no module doc — every public symbol is undocumented.
      for (const sym of publicSyms) {
        undocumented.push({
          file: file.path,
          symbol: sym.qualified_name ?? sym.name,
          kind: sym.kind,
          startLine: sym.start_line,
        });
      }
    } else {
      // Doc exists; surface any public symbol whose name isn't mentioned in the doc.
      // (Conservative: a name match means the doc at least references the symbol.)
      const docText = doc.content;
      for (const sym of publicSyms) {
        const ref = sym.qualified_name ?? sym.name;
        if (!mentions(docText, ref) && !mentions(docText, sym.name)) {
          undocumented.push(buildUndocumented(file, sym));
        }
      }
    }
  }

  if (!opts.skipArchitecture) {
    const archCtx = buildArchitectureContext(db);
    const expected = sha256(architectureContextToPrompt(archCtx));
    if (archDoc && archDoc.source_hash !== expected) {
      stale.push({
        kind: 'architecture',
        targetId: 0,
        targetPath: 'architecture',
        storedHash: archDoc.source_hash,
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

function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function buildUndocumented(file: FileRow, sym: SymbolRow): UndocumentedSymbolReport {
  return {
    file: file.path,
    symbol: sym.qualified_name ?? sym.name,
    kind: sym.kind,
    startLine: sym.start_line,
  };
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
