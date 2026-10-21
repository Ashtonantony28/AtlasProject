// Reference resolution: turn raw imports + parsed symbols into typed edges.
//
// Strategy is intentionally conservative for v1:
// - "module symbol" per file (id = file_id, kind = 'module'). Created implicitly
//   here so imports always have a source to attach to.
// - imports: src = importing file's module symbol, dst = symbol in target file
//   matching the imported name (or the module symbol itself for namespace/side-effect).
//   Unresolved imports become weak edges.
// - extends/implements: parse the class/interface header text; resolve the heritage
//   name against the file's local symbols and imported names.
// - calls: scan each function/method body's source text for identifiers that
//   match a known imported name or a top-level symbol in the same file. This is
//   a heuristic that picks up the common cases; later phases can swap in a real
//   call-resolver.

import {
  type DB,
  getAllFiles,
  getSymbolsForFile,
  insertSymbol,
  insertEdge,
  clearEdges,
  getImportsForFile,
} from '../db/index.js';
import type { SymbolRow } from '../db/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';

interface FileCtx {
  fileId: number;
  filePath: string;
  language: string;
  symbols: SymbolRow[];
  // Symbols indexed by lowercased basename for cross-file resolution.
  exportsByName: Map<string, SymbolRow>;
  moduleSymbolId: number;
}

export interface ResolveOptions {
  // Project root, used to resolve relative module specifiers.
  root: string;
}

export interface ResolveStats {
  edges: number;
  weakEdges: number;
  imports: number;
  calls: number;
  heritage: number;
}

export function resolveGraph(db: DB, opts: ResolveOptions): ResolveStats {
  // Start fresh — edges are derived data.
  clearEdges(db);

  const files = getAllFiles(db);
  const contexts = new Map<number, FileCtx>();

  // Ensure each file has a 'module' symbol that imports can attach to.
  for (const file of files) {
    let symbols = getSymbolsForFile(db, file.id);
    const hasModule = symbols.some((s) => s.kind === 'module');
    if (!hasModule) {
      insertSymbol(db, {
        file_id: file.id,
        kind: 'module',
        name: file.path,
        signature: null,
        start_line: 1,
        end_line: 1,
        docstring: null,
        qualified_name: file.path,
        exported: false,
      });
      symbols = getSymbolsForFile(db, file.id);
    }
    const moduleSym = symbols.find((s) => s.kind === 'module')!;
    const exports = new Map<string, SymbolRow>();
    for (const s of symbols) {
      if (s.kind === 'module') continue;
      // Only top-level symbols (qualified_name has no '.') can be imported by name.
      if (s.qualified_name && !s.qualified_name.includes('.')) {
        exports.set(s.name, s);
      } else if (!s.qualified_name) {
        exports.set(s.name, s);
      }
    }
    contexts.set(file.id, {
      fileId: file.id,
      filePath: file.path,
      language: file.language,
      symbols,
      exportsByName: exports,
      moduleSymbolId: moduleSym.id,
    });
  }

  // Index of file path -> ctx for resolving relative module specifiers.
  const byPath = new Map<string, FileCtx>();
  for (const ctx of contexts.values()) byPath.set(ctx.filePath, ctx);

  const stats: ResolveStats = { edges: 0, weakEdges: 0, imports: 0, calls: 0, heritage: 0 };

  // 1) Imports
  for (const ctx of contexts.values()) {
    const imps = getImportsForFile(db, ctx.fileId);
    for (const imp of imps) {
      const target = resolveModule(ctx, imp.module, byPath);
      if (!target) {
        insertEdge(db, {
          src_symbol: ctx.moduleSymbolId,
          dst_symbol: null,
          kind: 'imports',
          weak: true,
          meta: JSON.stringify({ module: imp.module, imported: imp.imported }),
        });
        stats.imports++;
        stats.weakEdges++;
        stats.edges++;
        continue;
      }
      // If imported a specific name, point at that symbol; otherwise at the module.
      let dstId = target.moduleSymbolId;
      let weak = false;
      if (imp.imported && imp.imported !== '*' && imp.imported !== 'default') {
        const sym = target.exportsByName.get(imp.imported);
        if (sym) dstId = sym.id;
        else weak = true;
      }
      insertEdge(db, {
        src_symbol: ctx.moduleSymbolId,
        dst_symbol: dstId,
        kind: 'imports',
        weak,
        meta: JSON.stringify({ module: imp.module, imported: imp.imported, alias: imp.alias }),
      });
      stats.imports++;
      stats.edges++;
      if (weak) stats.weakEdges++;
    }
  }

  // 2) Extends / implements / calls — need source text. Read files once.
  for (const ctx of contexts.values()) {
    let source: string;
    const abs = pathResolve(opts.root, ctx.filePath);
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = source.split('\n');

    // Build a name -> symbol id resolver visible from this file:
    // imported names + this file's top-level symbols.
    const localResolver = buildLocalResolver(db, ctx, byPath);

    // heritage
    for (const sym of ctx.symbols) {
      if (sym.kind !== 'class' && sym.kind !== 'interface') continue;
      const text = sliceLines(lines, sym.start_line, Math.min(sym.start_line + 2, sym.end_line));
      const extendsMatches = matchHeritage(text, /\bextends\s+([A-Za-z_$][\w$.]*)/g);
      const implMatches = matchHeritage(text, /\bimplements\s+([A-Za-z_$][\w$.,\s]*)/g);
      for (const name of extendsMatches) {
        const dst = localResolver(name);
        insertEdge(db, {
          src_symbol: sym.id,
          dst_symbol: dst,
          kind: 'extends',
          weak: dst === null,
          meta: JSON.stringify({ name }),
        });
        stats.heritage++;
        stats.edges++;
        if (dst === null) stats.weakEdges++;
      }
      for (const block of implMatches) {
        for (const raw of block.split(',')) {
          const name = raw.trim();
          if (!name) continue;
          const dst = localResolver(name);
          insertEdge(db, {
            src_symbol: sym.id,
            dst_symbol: dst,
            kind: 'implements',
            weak: dst === null,
            meta: JSON.stringify({ name }),
          });
          stats.heritage++;
          stats.edges++;
          if (dst === null) stats.weakEdges++;
        }
      }
    }

    // calls — for each function/method, scan its body for identifiers that match a known callable.
    const callableNames = new Set<string>();
    for (const sym of ctx.symbols) {
      if (sym.kind === 'function' || sym.kind === 'method' || sym.kind === 'class') {
        callableNames.add(sym.name);
      }
    }
    // Also include imported names (their resolved targets handled by localResolver).
    const imps = getImportsForFile(db, ctx.fileId);
    for (const imp of imps) {
      const name = imp.alias ?? imp.imported ?? null;
      if (name && name !== '*' && name !== 'default') callableNames.add(name);
    }

    for (const sym of ctx.symbols) {
      if (sym.kind !== 'function' && sym.kind !== 'method') continue;
      const body = sliceLines(lines, sym.start_line, sym.end_line);
      // Find <name>( occurrences.
      const seen = new Set<string>();
      const re = /([A-Za-z_$][\w$]*)\s*\(/g;
      for (let m = re.exec(body); m !== null; m = re.exec(body)) {
        const ident = m[1] ?? '';
        if (!ident) continue;
        if (ident === sym.name) continue;
        if (!callableNames.has(ident)) continue;
        if (seen.has(ident)) continue;
        seen.add(ident);
        const dst = localResolver(ident);
        insertEdge(db, {
          src_symbol: sym.id,
          dst_symbol: dst,
          kind: 'calls',
          weak: dst === null,
          meta: JSON.stringify({ name: ident }),
        });
        stats.calls++;
        stats.edges++;
        if (dst === null) stats.weakEdges++;
      }
    }
  }

  return stats;
}

function sliceLines(lines: string[], start1: number, end1: number): string {
  const s = Math.max(0, start1 - 1);
  const e = Math.min(lines.length, end1);
  return lines.slice(s, e).join('\n');
}

function matchHeritage(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const captured = m[1];
    if (captured) out.push(captured.trim());
  }
  return out;
}

/** Resolve a module specifier against the indexed files. Strips JS extensions and tries common variants. */
function resolveModule(
  from: FileCtx,
  spec: string,
  byPath: Map<string, FileCtx>,
): FileCtx | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    // External (e.g. 'fs', 'react'). Not indexable.
    return null;
  }
  const baseDir = dirname(from.filePath);
  // Normalize spec (strip .js / .ts extensions).
  const stripped = spec.replace(/\.(m?[jt]sx?)$/i, '');
  const candidatesRel = [
    stripped,
    stripped + '.ts',
    stripped + '.tsx',
    stripped + '.js',
    stripped + '.jsx',
    stripped + '/index.ts',
    stripped + '/index.tsx',
    stripped + '/index.js',
  ];
  for (const cand of candidatesRel) {
    const candPath = normalizePosix(join(baseDir, cand));
    const hit = byPath.get(candPath);
    if (hit) return hit;
  }
  // Python: convert dotted modules to paths.
  if (from.language === 'python') {
    const candPy = stripped.replace(/\./g, '/') + '.py';
    const candPath = normalizePosix(join(baseDir, candPy));
    const hit = byPath.get(candPath);
    if (hit) return hit;
  }
  return null;
}

function normalizePosix(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).join('/');
}

function buildLocalResolver(
  db: DB,
  ctx: FileCtx,
  byPath: Map<string, FileCtx>,
): (name: string) => number | null {
  const local = new Map<string, number>();
  for (const s of ctx.symbols) {
    if (s.qualified_name && !s.qualified_name.includes('.')) {
      local.set(s.name, s.id);
    }
  }
  // Imports: alias -> target symbol id.
  const imps = getImportsForFile(db, ctx.fileId);
  for (const imp of imps) {
    const target = resolveModule(ctx, imp.module, byPath);
    const localName = imp.alias ?? imp.imported ?? null;
    if (!localName || localName === '*' || localName === 'default') continue;
    if (!target) continue;
    const sym = target.exportsByName.get(imp.imported ?? localName);
    if (sym) local.set(localName, sym.id);
  }
  return (name: string): number | null => {
    if (local.has(name)) return local.get(name)!;
    return null;
  };
}

