// Build grounding context (prompt input) for synthesis from the index graph.

import {
  type DB,
  getSymbolsForFile,
  getImportsForFile,
  type SymbolRow,
  type FileRow,
} from '../db/index.js';
import type { Statement } from 'better-sqlite3';
import { readIndexedSource } from '../vector/index.js';
import { sha256 } from '../ingest/index.js';

export interface ModuleContext {
  file: FileRow;
  publicSymbols: SymbolRow[];
  omittedSymbols: number;
  imports: Array<{ module: string; imported: string | null; alias: string | null }>;
  omittedImports: number;
  incomingCalls: Array<{ from: string; symbol: string }>;
  outgoingCalls: Array<{ to: string; symbol: string }>;
  // A trimmed source snippet for top symbols (capped to keep prompt small).
  sourceSnippets: Array<{ symbol: string; file: string; line: number; code: string }>;
  contentHash: string;
  // Digest of every cross-file edge (uncapped), so the prompt hash covers what the caps drop.
  neighbourhoodHash: string;
}

// Hard caps that keep each prompt (and so each doc's token cost) bounded
// regardless of file size. All trimming is deterministic.
export const MAX_MODULE_PROMPT_CHARS = 6_000;
export const MAX_ARCH_PROMPT_CHARS = 12_000;
const MAX_PROMPT_SYMBOLS = 60;
const MAX_IMPORTS = 30;
const MAX_CALLS = 12;
const SNIPPET_LINES = 25;
const MAX_SNIPPETS = 6;
const MAX_LINE_CHARS = 160;
const MAX_ARCH_FILES = 150;
const MAX_TOP_CONNECTED = 10;

type Stmt = Statement<unknown[]>;
const stmtCache = new WeakMap<DB, Map<string, Stmt>>();
function stmt(db: DB, sql: string): Stmt {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

// Every resolved cross-file edge touching one file, in both directions.
const NEIGHBOUR_SQL = `
  SELECT 'out' AS dir, e.kind, e.weak, s.kind AS skind, t.file_id AS fid,
    COALESCE(s.qualified_name, s.name) AS symbol, f.path || '#' || COALESCE(t.qualified_name, t.name) AS other
  FROM symbols s
  JOIN edges e ON e.src_symbol = s.id
  JOIN symbols t ON t.id = e.dst_symbol
  JOIN files f ON f.id = t.file_id
  WHERE s.file_id = ? AND t.file_id != s.file_id
  UNION ALL
  SELECT 'in', e.kind, e.weak, s.kind, t.file_id,
    COALESCE(s.qualified_name, s.name), f.path || '#' || COALESCE(t.qualified_name, t.name)
  FROM symbols s
  JOIN edges e ON e.dst_symbol = s.id
  JOIN symbols t ON t.id = e.src_symbol
  JOIN files f ON f.id = t.file_id
  WHERE s.file_id = ? AND t.file_id != s.file_id`;

interface NeighbourRow {
  dir: 'in' | 'out';
  kind: string;
  weak: number;
  skind: string;
  fid: number;
  symbol: string;
  other: string;
}

/**
 * Distinct call pairs in one direction, files with the most call pairs first,
 * then by name; capped at MAX_CALLS.
 */
function topCalls(
  rows: NeighbourRow[],
  dir: 'in' | 'out',
): Array<{ symbol: string; other: string }> {
  const pairs = new Map<string, { symbol: string; other: string; fid: number }>();
  for (const r of rows) {
    if (r.dir !== dir || r.kind !== 'calls' || r.skind === 'module') continue;
    pairs.set(`${r.symbol}\0${r.other}`, { symbol: r.symbol, other: r.other, fid: r.fid });
  }
  const perFile = new Map<number, number>();
  for (const p of pairs.values()) perFile.set(p.fid, (perFile.get(p.fid) ?? 0) + 1);
  return [...pairs.values()]
    .sort(
      (a, b) =>
        (perFile.get(b.fid) ?? 0) - (perFile.get(a.fid) ?? 0) ||
        cmp(a.other, b.other) ||
        cmp(a.symbol, b.symbol),
    )
    .slice(0, MAX_CALLS)
    .map(({ symbol, other }) => ({ symbol, other }));
}

/** sha256 over the whole cross-file neighbourhood, so capped prompts still change with it. */
function neighbourhoodHash(rows: NeighbourRow[]): string {
  const lines = [
    ...new Set(rows.map((r) => `${r.dir} ${r.kind} ${r.weak} ${r.symbol} ${r.other}`)),
  ].sort(cmp);
  return sha256(lines.join('\n'));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exported symbols first, then source order; `n` of them, back in source order. */
function pickSymbols(symbols: SymbolRow[], n: number): SymbolRow[] {
  if (symbols.length <= n) return symbols;
  const keep = new Set(
    [...symbols]
      .sort((a, b) => b.exported - a.exported)
      .slice(0, n)
      .map((s) => s.id),
  );
  return symbols.filter((s) => keep.has(s.id));
}

export function buildModuleContext(db: DB, root: string, file: FileRow): ModuleContext {
  const symbols = getSymbolsForFile(db, file.id).filter((s) => s.kind !== 'module');
  const publicSymbols = pickSymbols(symbols, MAX_PROMPT_SYMBOLS);
  const allImports = getImportsForFile(db, file.id);
  const imports = allImports.slice(0, MAX_IMPORTS).map((i) => ({
    module: i.module,
    imported: i.imported,
    alias: i.alias,
  }));
  const neighbours = stmt(db, NEIGHBOUR_SQL).all(file.id, file.id) as NeighbourRow[];
  const outgoingCalls = topCalls(neighbours, 'out').map((r) => ({ to: r.other, symbol: r.symbol }));
  const incomingCalls = topCalls(neighbours, 'in').map((r) => ({
    from: r.other,
    symbol: r.symbol,
  }));

  const { source } = readIndexedSource(root, file);
  const lines = source ? source.split('\n') : [];
  const snippets: ModuleContext['sourceSnippets'] = [];
  if (lines.length > 0) {
    for (const sym of pickSymbols(publicSymbols, MAX_SNIPPETS)) {
      const start = Math.max(0, sym.start_line - 1);
      const end = Math.min(
        lines.length,
        Math.max(sym.end_line, sym.start_line),
        start + SNIPPET_LINES,
      );
      snippets.push({
        symbol: sym.qualified_name ?? sym.name,
        file: file.path,
        line: sym.start_line,
        code: lines
          .slice(start, end)
          .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l))
          .join('\n'),
      });
    }
  }

  return {
    file,
    publicSymbols,
    omittedSymbols: symbols.length - publicSymbols.length,
    imports,
    omittedImports: allImports.length - imports.length,
    incomingCalls,
    outgoingCalls,
    sourceSnippets: snippets,
    contentHash: file.content_hash,
    neighbourhoodHash: neighbourhoodHash(neighbours),
  };
}

/**
 * Render the prompt, dropping trailing snippets and then halving the symbol
 * list until it fits MAX_MODULE_PROMPT_CHARS.
 */
export function moduleContextToPrompt(ctx: ModuleContext): string {
  let snippets = ctx.sourceSnippets.length;
  let symbols = ctx.publicSymbols.length;
  for (;;) {
    const prompt = renderModule(ctx, snippets, symbols);
    if (prompt.length <= MAX_MODULE_PROMPT_CHARS || (snippets === 0 && symbols === 0)) {
      return prompt.slice(0, MAX_MODULE_PROMPT_CHARS);
    }
    if (snippets > 0) snippets--;
    else symbols = Math.floor(symbols / 2);
  }
}

function renderModule(ctx: ModuleContext, snippetCount: number, symbolCount: number): string {
  const lines: string[] = [];
  lines.push(`Target: module ${ctx.file.path}`);
  lines.push(`Language: ${ctx.file.language}`);
  lines.push(`LOC: ${ctx.file.loc}`);
  lines.push(`Content hash: ${ctx.contentHash}`);
  lines.push(`Neighbourhood hash: ${ctx.neighbourhoodHash}`);
  const symbols = pickSymbols(ctx.publicSymbols, symbolCount);
  if (symbols.length > 0) {
    lines.push('');
    lines.push('Symbols:');
    for (const s of symbols) {
      lines.push(
        `  - [${s.kind}] ${s.qualified_name ?? s.name} (${ctx.file.path}:${s.start_line})${
          s.docstring ? ` — ${oneLine(s.docstring).slice(0, 120)}` : ''
        }`,
      );
    }
  }
  const omitted = ctx.omittedSymbols + ctx.publicSymbols.length - symbols.length;
  if (omitted > 0) lines.push(`  … ${omitted} more symbols omitted`);
  if (ctx.imports.length > 0) {
    lines.push('');
    lines.push('Imports:');
    for (const i of ctx.imports) {
      lines.push(
        `  - from "${i.module}" import ${i.imported ?? '*'}${i.alias ? ` as ${i.alias}` : ''}`,
      );
    }
    if (ctx.omittedImports > 0) lines.push(`  … ${ctx.omittedImports} more imports omitted`);
  }
  if (ctx.outgoingCalls.length > 0) {
    lines.push('');
    lines.push('Outgoing calls (this module -> others):');
    for (const o of ctx.outgoingCalls) {
      lines.push(`  - ${o.symbol} -> ${o.to}`);
    }
  }
  if (ctx.incomingCalls.length > 0) {
    lines.push('');
    lines.push('Incoming calls (others -> this module):');
    for (const i of ctx.incomingCalls) {
      lines.push(`  - ${i.from} -> ${i.symbol}`);
    }
  }
  if (snippetCount > 0) {
    lines.push('');
    lines.push('Source excerpts (truncated):');
    for (const s of ctx.sourceSnippets.slice(0, snippetCount)) {
      lines.push(`\n// ${s.symbol} — ${s.file}:${s.line}`);
      lines.push(s.code);
    }
  }
  return lines.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Aggregate digest across all modules for the architecture doc. */
export interface ArchitectureContext {
  files: Array<{ path: string; language: string; loc: number; symbolCount: number }>;
  omittedFiles: number;
  totals: { files: number; symbols: number; edges: number };
  // Digest of every indexed path (uncapped), so renames among omitted files still count.
  filesHash: string;
  topConnected: Array<{ file: string; degree: number }>;
}

export function buildArchitectureContext(db: DB): ArchitectureContext {
  const all = stmt(
    db,
    `SELECT f.path, f.language, f.loc,
       (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id AND s.kind != 'module') AS symbolCount
     FROM files f ORDER BY f.path`,
  ).all() as ArchitectureContext['files'];
  const files =
    all.length <= MAX_ARCH_FILES
      ? all
      : [...all]
          .sort((a, b) => b.symbolCount - a.symbolCount)
          .slice(0, MAX_ARCH_FILES)
          .sort((a, b) => (a.path < b.path ? -1 : 1));
  const edges = (stmt(db, 'SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
  const topConnected = stmt(
    db,
    `SELECT f.path AS file, COUNT(*) AS degree
     FROM (SELECT src_symbol AS sid FROM edges UNION ALL SELECT dst_symbol FROM edges) x
     JOIN symbols s ON s.id = x.sid
     JOIN files f ON f.id = s.file_id
     GROUP BY f.path ORDER BY degree DESC, f.path LIMIT ${MAX_TOP_CONNECTED}`,
  ).all() as ArchitectureContext['topConnected'];

  return {
    files,
    omittedFiles: all.length - files.length,
    totals: {
      files: all.length,
      symbols: all.reduce((sum, f) => sum + f.symbolCount, 0),
      edges,
    },
    filesHash: sha256(all.map((f) => `${f.path} ${f.language}`).join('\n')),
    topConnected,
  };
}

export function architectureContextToPrompt(ctx: ArchitectureContext): string {
  let n = ctx.files.length;
  for (;;) {
    const prompt = renderArchitecture(ctx, n);
    if (prompt.length <= MAX_ARCH_PROMPT_CHARS || n === 0)
      return prompt.slice(0, MAX_ARCH_PROMPT_CHARS);
    n = Math.floor(n / 2);
  }
}

function renderArchitecture(ctx: ArchitectureContext, fileCount: number): string {
  const lines: string[] = [];
  lines.push(`Target: architecture overview`);
  lines.push(
    `Totals: files=${ctx.totals.files} symbols=${ctx.totals.symbols} edges=${ctx.totals.edges}`,
  );
  lines.push(`Files hash: ${ctx.filesHash}`);
  lines.push('');
  lines.push('Files:');
  const keep = new Set(
    [...ctx.files].sort((a, b) => b.symbolCount - a.symbolCount).slice(0, fileCount),
  );
  for (const f of ctx.files) {
    if (keep.has(f))
      lines.push(`  - ${f.path} [${f.language}] loc=${f.loc} symbols=${f.symbolCount}`);
  }
  const omitted = ctx.omittedFiles + ctx.files.length - keep.size;
  if (omitted > 0) lines.push(`  … ${omitted} more files omitted`);
  if (ctx.topConnected.length > 0) {
    lines.push('');
    lines.push('Top connected files (by edge degree):');
    for (const t of ctx.topConnected) {
      lines.push(`  - ${t.file} (degree=${t.degree})`);
    }
  }
  return lines.join('\n');
}

/** The exact prompt a module doc is generated from; its sha256 is the doc's source_hash. */
export function modulePrompt(db: DB, root: string, file: FileRow): string {
  return moduleContextToPrompt(buildModuleContext(db, root, file));
}

export function architecturePrompt(db: DB): string {
  return architectureContextToPrompt(buildArchitectureContext(db));
}
