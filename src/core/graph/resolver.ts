// Reference resolution: turn imports and parsed references (`refs`) into typed edges.
//
// - Each file gets a 'module' symbol (created here if missing) that imports and
//   module-level calls attach to.
// - imports: module symbol → imported symbol, or → target module for namespace,
//   default and side-effect imports. Unresolved imports become weak edges.
// - extends/implements and calls come from CST references recorded by the parser:
//   bare `f()` resolves to a local top-level symbol or an imported binding,
//   `this.m()`/`self.m()` to a method of the enclosing class or its resolved
//   parents, `super.m()` to a parent's method, `ns.m()` through an imported
//   module or class binding. Unresolved `this`/`super` calls and calls through
//   an import binding are weak (dst null); calls on unbound names or receivers
//   (builtins, locals, parameters) give no edge.

import {
  type DB,
  getAllFiles,
  getAllSymbols,
  getAllImports,
  getAllRefs,
  insertSymbol,
  insertEdges,
  clearEdges,
} from '../db/index.js';
import type { EdgeKind, ImportRow, InsertEdgeInput, RefRow, SymbolRow } from '../db/index.js';
import { posix } from 'node:path';

interface FileCtx {
  fileId: number;
  filePath: string;
  language: string;
  byQName: Map<string, SymbolRow>;
  // Importable names: top-level symbols, then members of a default-export object literal.
  exportsByName: Map<string, SymbolRow>;
  moduleSymbolId: number;
}

type Binding =
  | { kind: 'symbol'; sym: SymbolRow }
  | { kind: 'module'; ctx: FileCtx }
  | { kind: 'external' };

export interface ResolveOptions {
  // Project root. Kept for callers; references come from the index, not from disk.
  root: string;
}

export interface ResolveStats {
  edges: number;
  weakEdges: number;
  imports: number;
  calls: number;
  heritage: number;
}

export function resolveGraph(db: DB, _opts: ResolveOptions): ResolveStats {
  return db.transaction(() => resolveAll(db))();
}

function resolveAll(db: DB): ResolveStats {
  clearEdges(db);

  const symbolsByFile = groupByFile(getAllSymbols(db));
  const importsByFile = groupByFile<ImportRow>(getAllImports(db));
  const refsByFile = groupByFile<RefRow>(getAllRefs(db));
  const contexts = new Map<number, FileCtx>();
  for (const file of getAllFiles(db)) {
    const symbols = symbolsByFile.get(file.id) ?? [];
    let moduleSymbolId = symbols.find((s) => s.kind === 'module')?.id;
    if (moduleSymbolId === undefined) {
      moduleSymbolId = insertSymbol(db, {
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
    }
    const byQName = new Map<string, SymbolRow>();
    const exportsByName = new Map<string, SymbolRow>();
    const members: SymbolRow[] = [];
    for (const s of symbols) {
      if (s.kind === 'module') continue;
      const q = s.qualified_name ?? s.name;
      byQName.set(q, s);
      if (!q.includes('.')) exportsByName.set(s.name, s);
      else if (q === `default.${s.name}`) members.push(s);
    }
    for (const s of members) if (!exportsByName.has(s.name)) exportsByName.set(s.name, s);
    contexts.set(file.id, {
      fileId: file.id,
      filePath: file.path,
      language: file.language,
      byQName,
      exportsByName,
      moduleSymbolId,
    });
  }

  const byPath = new Map<string, FileCtx>();
  for (const ctx of contexts.values()) byPath.set(ctx.filePath, ctx);

  const stats: ResolveStats = { edges: 0, weakEdges: 0, imports: 0, calls: 0, heritage: 0 };
  const seen = new Set<string>();
  const edges: InsertEdgeInput[] = [];
  const emit = (
    src: number,
    dst: number | null,
    kind: EdgeKind,
    meta: object,
    weak = dst === null,
  ): void => {
    const key = `${src}|${dst ?? JSON.stringify(meta)}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ src_symbol: src, dst_symbol: dst, kind, weak, meta: JSON.stringify(meta) });
    stats.edges++;
    if (weak) stats.weakEdges++;
    if (kind === 'imports') stats.imports++;
    else if (kind === 'calls') stats.calls++;
    else stats.heritage++;
  };

  // 1) Imports, and the local bindings they create.
  const bindings = new Map<number, Map<string, Binding>>();
  for (const ctx of contexts.values()) {
    const local = new Map<string, Binding>();
    for (const [name, sym] of ctx.exportsByName) {
      if (!(sym.qualified_name ?? name).includes('.')) local.set(name, { kind: 'symbol', sym });
    }
    for (const imp of importsByFile.get(ctx.fileId) ?? []) {
      const meta = { module: imp.module, imported: imp.imported, alias: imp.alias };
      const named = imp.imported !== null && imp.imported !== '*' && imp.imported !== 'default';
      const localName = imp.alias ?? (named ? imp.imported : null);
      const target = resolveModule(ctx, imp.module, byPath);
      let binding: Binding = { kind: 'external' };
      let dst: number | null = null;
      let weak = false;
      if (target) {
        dst = target.moduleSymbolId;
        binding = { kind: 'module', ctx: target };
        if (named) {
          const sym = target.exportsByName.get(imp.imported!);
          const sub = sym ? null : resolveSubmodule(ctx, imp.module, imp.imported!, byPath);
          if (sym) {
            dst = sym.id;
            binding = { kind: 'symbol', sym };
          } else if (sub) {
            dst = sub.moduleSymbolId;
            binding = { kind: 'module', ctx: sub };
          } else {
            weak = true;
            binding = { kind: 'external' };
          }
        }
      } else if (named) {
        const sub = resolveSubmodule(ctx, imp.module, imp.imported!, byPath);
        if (sub) {
          dst = sub.moduleSymbolId;
          binding = { kind: 'module', ctx: sub };
        }
      }
      emit(ctx.moduleSymbolId, dst, 'imports', meta, weak || dst === null);
      const name =
        localName ?? (imp.imported === null && ctx.language === 'python' ? imp.module : null);
      if (name) local.set(name, binding);
    }
    bindings.set(ctx.fileId, local);
  }

  const srcOf = (ctx: FileCtx, ref: RefRow): SymbolRow | number | null =>
    ref.src_qualified_name === null
      ? ctx.moduleSymbolId
      : (ctx.byQName.get(ref.src_qualified_name) ?? null);

  // `ns.Name` / `Name` through bindings; for a class binding, `Class.Name`. Undefined if unbound.
  const viaBinding = (ctx: FileCtx, ref: RefRow): SymbolRow | null | undefined => {
    const local = bindings.get(ctx.fileId)!;
    const key = ref.receiver === 'none' ? ref.name : (ref.object ?? '');
    const b = local.get(key);
    if (!b) return local.has(key.split('.')[0]!) ? null : undefined;
    if (ref.receiver === 'none') {
      if (b.kind === 'symbol') return b.sym;
      // `const x = require('...')` also declares a top-level variable `x`: the call goes through it.
      const own = ctx.byQName.get(ref.name);
      return own && own.kind !== 'module' ? own : null;
    }
    if (b.kind === 'module') return b.ctx.exportsByName.get(ref.name) ?? null;
    if (b.kind === 'symbol') return member(b.sym, ref.name);
    return null;
  };

  // 2) Heritage. Resolved `extends` edges feed method lookup through parents.
  const parents = new Map<number, SymbolRow[]>();
  for (const ctx of contexts.values()) {
    for (const ref of refsByFile.get(ctx.fileId) ?? []) {
      if (ref.kind === 'calls') continue;
      const src = srcOf(ctx, ref);
      if (src === null || typeof src === 'number') continue;
      const dst =
        ref.receiver === 'none' || ref.receiver === 'member' ? viaBinding(ctx, ref) : null;
      emit(src.id, dst?.id ?? null, ref.kind, refMeta(ref));
      if (dst && ref.kind === 'extends') parents.set(src.id, [...(parents.get(src.id) ?? []), dst]);
    }
  }

  // Method `name` on class `cls` or, failing that, on its resolved ancestors.
  function member(cls: SymbolRow, name: string, visited = new Set<number>()): SymbolRow | null {
    if (visited.has(cls.id)) return null;
    visited.add(cls.id);
    const hit = contexts.get(cls.file_id)?.byQName.get(`${cls.qualified_name ?? cls.name}.${name}`);
    if (hit) return hit;
    for (const p of parents.get(cls.id) ?? []) {
      const found = member(p, name, visited);
      if (found) return found;
    }
    return null;
  }

  // 3) Calls.
  for (const ctx of contexts.values()) {
    for (const ref of refsByFile.get(ctx.fileId) ?? []) {
      if (ref.kind !== 'calls') continue;
      const src = srcOf(ctx, ref);
      if (src === null) continue;
      const srcId = typeof src === 'number' ? src : src.id;
      let dst: SymbolRow | null | undefined;
      if (ref.receiver === 'this' || ref.receiver === 'super') {
        const owner = typeof src === 'number' ? null : ownerOf(src);
        const cls = owner === null ? undefined : ctx.byQName.get(owner);
        if (ref.receiver === 'super') {
          dst = null;
          for (const p of (cls && parents.get(cls.id)) ?? []) dst ??= member(p, ref.name);
        } else {
          dst = cls
            ? member(cls, ref.name)
            : owner
              ? ctx.byQName.get(`${owner}.${ref.name}`)
              : null;
        }
      } else {
        dst = viaBinding(ctx, ref);
        // Unbound names and receivers (builtins, locals, parameters) give no edge.
        if (dst === undefined) continue;
      }
      emit(srcId, dst?.id ?? null, 'calls', refMeta(ref));
    }
  }

  insertEdges(db, edges);
  return stats;
}

function groupByFile<T extends { file_id: number }>(rows: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const list = out.get(r.file_id);
    if (list) list.push(r);
    else out.set(r.file_id, [r]);
  }
  return out;
}

function refMeta(ref: RefRow): object {
  return ref.receiver === 'none'
    ? { name: ref.name }
    : { name: ref.name, receiver: ref.receiver, object: ref.object };
}

/** Qualified name of the class (or object literal) whose `this` a symbol sees. */
function ownerOf(sym: SymbolRow): string | null {
  const q = sym.qualified_name ?? sym.name;
  if (sym.kind === 'class') return q;
  if (sym.kind !== 'method') return null;
  const dot = q.lastIndexOf('.');
  return dot > 0 ? q.slice(0, dot) : null;
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_CANDIDATES = ['', ...TS_EXTS, ...TS_EXTS.map((e) => `/index${e}`)];

/** Resolve a module specifier against the indexed files. */
function resolveModule(from: FileCtx, spec: string, byPath: Map<string, FileCtx>): FileCtx | null {
  if (from.language === 'python') return resolvePython(from, spec, byPath);
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // package, not indexable
  const base = posix.join(posix.dirname(from.filePath), spec.replace(/\.[cm]?[jt]sx?$/i, ''));
  for (const ext of TS_CANDIDATES) {
    const hit = byPath.get(normalizePosix(base + ext));
    if (hit) return hit;
  }
  return null;
}

/** `from pkg import util` where `util` is a submodule rather than a name in `pkg/__init__.py`. */
function resolveSubmodule(
  from: FileCtx,
  spec: string,
  name: string,
  byPath: Map<string, FileCtx>,
): FileCtx | null {
  if (from.language !== 'python') return null;
  return resolvePython(from, /\.$/.test(spec) ? spec + name : `${spec}.${name}`, byPath);
}

/**
 * Python: N leading dots go up N-1 directories from the importing file; absolute
 * dotted names are searched from the repo root and from the importing file's
 * top-level package root (the parent of the outermost dir with `__init__.py`).
 */
function resolvePython(from: FileCtx, spec: string, byPath: Map<string, FileCtx>): FileCtx | null {
  const dots = /^\.*/.exec(spec)![0].length;
  const rel = spec.slice(dots).split('.').filter(Boolean).join('/');
  let roots: string[];
  if (dots > 0) {
    let dir = posix.dirname(from.filePath);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    roots = [dir];
  } else {
    let dir = posix.dirname(from.filePath);
    while (dir !== '.' && byPath.has(normalizePosix(`${dir}/__init__.py`)))
      dir = posix.dirname(dir);
    roots = dir === '.' ? ['.'] : ['.', dir];
  }
  for (const root of roots) {
    const base = posix.join(root, rel);
    for (const cand of rel
      ? [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]
      : [`${base}/__init__.py`]) {
      const hit = byPath.get(normalizePosix(cand));
      if (hit) return hit;
    }
  }
  return null;
}

function normalizePosix(p: string): string {
  return p
    .split(/[\\/]/)
    .filter((s) => s && s !== '.')
    .join('/');
}
