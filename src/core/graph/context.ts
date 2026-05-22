// Architecture-level context used by drift detection and the MCP layer.
// (Module-level context lives here too for completeness.)

import {
  type DB,
  getAllFiles,
  getAllEdges,
  getSymbolsForFile,
  getImportsForFile,
  type SymbolRow,
  type FileRow,
} from '../db/index.js';
import { readFileFromRoot } from '../vector/index.js';

export interface ModuleContext {
  file: FileRow;
  publicSymbols: SymbolRow[];
  imports: Array<{ module: string; imported: string | null; alias: string | null }>;
  incomingCalls: Array<{ from: string; symbol: string }>;
  outgoingCalls: Array<{ to: string; symbol: string }>;
  sourceSnippets: Array<{ symbol: string; file: string; line: number; code: string }>;
  contentHash: string;
}

const SNIPPET_LINES = 25;
const MAX_SNIPPETS = 6;

export function buildModuleContext(db: DB, root: string, file: FileRow): ModuleContext {
  const symbols = getSymbolsForFile(db, file.id);
  const publicSymbols = symbols.filter((s) => s.kind !== 'module');
  const imports = getImportsForFile(db, file.id).map((i) => ({
    module: i.module,
    imported: i.imported,
    alias: i.alias,
  }));

  const edges = getAllEdges(db);
  const fileSymbolIds = new Set(publicSymbols.map((s) => s.id));
  const symbolName = new Map<number, { file: string; name: string }>();
  for (const f of getAllFiles(db)) {
    for (const s of getSymbolsForFile(db, f.id)) {
      symbolName.set(s.id, { file: f.path, name: s.qualified_name ?? s.name });
    }
  }
  const incomingCalls: Array<{ from: string; symbol: string }> = [];
  const outgoingCalls: Array<{ to: string; symbol: string }> = [];
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    if (e.src_symbol && fileSymbolIds.has(e.src_symbol) && e.dst_symbol) {
      const me = symbolName.get(e.src_symbol);
      const them = symbolName.get(e.dst_symbol);
      if (me && them && them.file !== file.path) {
        outgoingCalls.push({ to: `${them.file}#${them.name}`, symbol: me.name });
      }
    } else if (e.dst_symbol && fileSymbolIds.has(e.dst_symbol) && e.src_symbol) {
      const them = symbolName.get(e.src_symbol);
      const me = symbolName.get(e.dst_symbol);
      if (me && them && them.file !== file.path) {
        incomingCalls.push({ from: `${them.file}#${them.name}`, symbol: me.name });
      }
    }
  }

  const source = readFileFromRoot(root, db, file.id);
  const lines = source ? source.split('\n') : [];
  const snippets: ModuleContext['sourceSnippets'] = [];
  for (const sym of publicSymbols.slice(0, MAX_SNIPPETS)) {
    if (!lines.length) break;
    const start = Math.max(0, sym.start_line - 1);
    const end = Math.min(lines.length, sym.start_line + SNIPPET_LINES);
    snippets.push({
      symbol: sym.qualified_name ?? sym.name,
      file: file.path,
      line: sym.start_line,
      code: lines.slice(start, end).join('\n'),
    });
  }

  return {
    file,
    publicSymbols,
    imports,
    incomingCalls,
    outgoingCalls,
    sourceSnippets: snippets,
    contentHash: file.content_hash,
  };
}

export interface ArchitectureContext {
  files: Array<{ path: string; language: string; loc: number; symbolCount: number }>;
  totals: { files: number; symbols: number; edges: number };
  topConnected: Array<{ file: string; degree: number }>;
}

export function buildArchitectureContext(db: DB): ArchitectureContext {
  const files = getAllFiles(db);
  const filesOut = files.map((f) => ({
    path: f.path,
    language: f.language,
    loc: f.loc,
    symbolCount: getSymbolsForFile(db, f.id).filter((s) => s.kind !== 'module').length,
  }));
  const edges = getAllEdges(db);
  const degree = new Map<string, number>();
  const symbolFile = new Map<number, string>();
  for (const f of files) {
    for (const s of getSymbolsForFile(db, f.id)) symbolFile.set(s.id, f.path);
  }
  for (const e of edges) {
    if (e.src_symbol) {
      const f = symbolFile.get(e.src_symbol);
      if (f) degree.set(f, (degree.get(f) ?? 0) + 1);
    }
    if (e.dst_symbol) {
      const f = symbolFile.get(e.dst_symbol);
      if (f) degree.set(f, (degree.get(f) ?? 0) + 1);
    }
  }
  const topConnected = [...degree.entries()]
    .map(([file, d]) => ({ file, degree: d }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 10);

  return {
    files: filesOut,
    totals: {
      files: files.length,
      symbols: filesOut.reduce((sum, f) => sum + f.symbolCount, 0),
      edges: edges.length,
    },
    topConnected,
  };
}

export function architectureContextToPrompt(ctx: ArchitectureContext): string {
  const lines: string[] = [];
  lines.push(`Target: architecture overview`);
  lines.push(`Totals: files=${ctx.totals.files} symbols=${ctx.totals.symbols} edges=${ctx.totals.edges}`);
  lines.push('');
  lines.push('Files:');
  for (const f of ctx.files) {
    lines.push(`  - ${f.path} [${f.language}] loc=${f.loc} symbols=${f.symbolCount}`);
  }
  if (ctx.topConnected.length > 0) {
    lines.push('');
    lines.push('Top connected files (by edge degree):');
    for (const t of ctx.topConnected) {
      lines.push(`  - ${t.file} (degree=${t.degree})`);
    }
  }
  return lines.join('\n');
}
