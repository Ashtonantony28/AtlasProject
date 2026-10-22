// Reference resolution: turn imports and parsed references (`refs`) into typed edges.
//
// - Each file gets a 'module' symbol (created here if missing) that imports and
//   module-level calls attach to.
// - imports: module symbol → imported symbol, or → target module for namespace,
//   side-effect and unknown default imports. Named and default imports follow
//   re-exports (`export … from`, `export *`, names bound in a Python `__init__`,
//   `export default x`, `module.exports = x`) to the defining symbol; an import
//   through such a barrel also gets an edge to the barrel module. A barrel gets an
//   import edge per re-export. Unresolved imports become weak edges.
// - extends/implements and calls come from CST references recorded by the parser:
//   bare `f()` resolves to a local top-level symbol or an imported binding,
//   `this.m()`/`self.m()` to a method of the enclosing class or its resolved
//   parents, `super.m()` to a parent's method, `ns.m()` through an imported
//   module or class binding. Unresolved `this`/`super` calls and calls through
//   an import binding are weak (dst null); calls on unbound names or receivers
//   (builtins, locals, parameters) give no edge.
// - references: a function, method or class used as a value (a callback, an
//   assigned or exported function) resolves like a call; only resolved ones become edges.

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
  imports: ImportRow[]; // bindings (reexport = 0)
  reexports: ImportRow[]; // reexport = 1; module '' exports a local name as `alias`
  byLocal: Map<string, ImportRow>; // import rows by the local name they bind
}

type Binding =
  // `home`: the module whose exports `x.m()` falls back to when `sym` is a function
  // default export (CJS `module.exports = fn; exports.m = ...`).
  | { kind: 'symbol'; sym: SymbolRow; home?: FileCtx }
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
  references: number;
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
    // Members of `export default { … }`; not of an anonymous default class or function.
    if (!byQName.has('default'))
      for (const s of members) if (!exportsByName.has(s.name)) exportsByName.set(s.name, s);
    const rows = importsByFile.get(file.id) ?? [];
    const imports = rows.filter((r) => !r.reexport);
    const byLocal = new Map<string, ImportRow>();
    for (const imp of imports) {
      const name = localNameOf(imp, file.language);
      if (name) byLocal.set(name, imp);
    }
    contexts.set(file.id, {
      fileId: file.id,
      filePath: file.path,
      language: file.language,
      byQName,
      exportsByName,
      moduleSymbolId,
      imports,
      reexports: rows.filter((r) => r.reexport),
      byLocal,
    });
  }

  const byPath = new Map<string, FileCtx>();
  for (const ctx of contexts.values()) byPath.set(ctx.filePath, ctx);

  const stats: ResolveStats = {
    edges: 0,
    weakEdges: 0,
    imports: 0,
    calls: 0,
    heritage: 0,
    references: 0,
  };
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
    else if (kind === 'references') stats.references++;
    else stats.heritage++;
  };

  // What a name exported by `ctx` is bound to, following re-export chains (cycle-safe).
  const exportMemo = new Map<string, Binding | null>();
  function exportOf(ctx: FileCtx, name: string, seen = new Set<string>()): Binding | null {
    const key = `${ctx.fileId}\0${name}`;
    const top = seen.size === 0;
    if (top && exportMemo.has(key)) return exportMemo.get(key)!;
    if (seen.has(key)) return null;
    seen.add(key);
    let out = name === 'default' ? null : localOf(ctx, name, seen);
    for (const r of ctx.reexports) {
      if (out) break;
      if ((r.alias ?? r.imported) !== name || (r.imported === '*' && r.alias === null)) continue;
      out = r.module === '' ? localOf(ctx, r.imported!, seen) : bindingOf(ctx, r, seen);
      if (out?.kind === 'symbol' && name === 'default' && !out.home) {
        const home = contexts.get(out.sym.file_id);
        out = { kind: 'symbol', sym: out.sym, ...(home ? { home } : {}) };
      }
    }
    if (!out && name !== 'default') out = viaStars(ctx, name, seen)?.binding ?? null;
    if (top) exportMemo.set(key, out);
    return out;
  }

  // A top-level name of `ctx`. An import that resolves to a symbol wins over the
  // variable it declares (`const x = require('./x')`), then own symbols, then modules.
  function localOf(ctx: FileCtx, name: string, seen: Set<string>): Binding | null {
    const imp = ctx.byLocal.get(name);
    const b = imp ? bindingOf(ctx, imp, seen) : null;
    if (b?.kind === 'symbol') return b;
    const own = ctx.exportsByName.get(name);
    if (own) return { kind: 'symbol', sym: own };
    return b?.kind === 'module' ? b : null;
  }

  // `export *` and Python `from x import *` (only the latter binds locally): the first
  // star target exporting `name`. `unresolved`: some star target is outside the index.
  function viaStars(
    ctx: FileCtx,
    name: string,
    seen: Set<string>,
    bindingOnly = false,
  ): { binding: Binding | null; unresolved: boolean } | null {
    let unresolved = false;
    let any = false;
    for (const r of bindingOnly ? ctx.imports : [...ctx.reexports, ...ctx.imports]) {
      if (r.imported !== '*' || r.alias !== null || r.module === '') continue;
      any = true;
      const target = resolveModule(ctx, r.module, byPath);
      if (!target) {
        unresolved = true;
        continue;
      }
      const b = exportOf(target, name, seen);
      if (b) return { binding: b, unresolved };
    }
    return any ? { binding: null, unresolved } : null;
  }

  // The binding an import (or re-export) row creates. Named imports that cannot be
  // found in an indexed target are `external` with `weak` set by the caller.
  function bindingOf(ctx: FileCtx, imp: ImportRow, seen = new Set<string>()): Binding {
    const target = resolveModule(ctx, imp.module, byPath);
    const name = imp.imported;
    if (name === null || name === '*') return target ? { kind: 'module', ctx: target } : EXTERNAL;
    if (target) {
      const b = exportOf(target, name, seen);
      if (b) return b;
      if (name === 'default') return { kind: 'module', ctx: target };
    }
    const sub = resolveSubmodule(ctx, imp.module, name, byPath);
    return sub ? { kind: 'module', ctx: sub } : EXTERNAL;
  }

  // 1) Imports and re-exports, and the local bindings imports create.
  const bindings = new Map<number, Map<string, Binding>>();
  for (const ctx of contexts.values()) {
    const local = new Map<string, Binding>();
    for (const [name, sym] of ctx.exportsByName) {
      if (!(sym.qualified_name ?? name).includes('.')) local.set(name, { kind: 'symbol', sym });
    }
    for (const imp of [...ctx.imports, ...ctx.reexports]) {
      if (imp.module === '') continue;
      const meta = { module: imp.module, imported: imp.imported, alias: imp.alias };
      const target = resolveModule(ctx, imp.module, byPath);
      const binding = bindingOf(ctx, imp);
      const dst =
        binding.kind === 'symbol'
          ? binding.sym.id
          : binding.kind === 'module'
            ? binding.ctx.moduleSymbolId
            : (target?.moduleSymbolId ?? null);
      emit(ctx.moduleSymbolId, dst, 'imports', meta, binding.kind === 'external' || dst === null);
      // Imported through a barrel: the barrel module is a dependency too.
      const named = imp.imported !== null && imp.imported !== '*';
      if (target && named && binding.kind !== 'external' && exportOf(target, imp.imported!)) {
        const home = binding.kind === 'symbol' ? binding.sym.file_id : binding.ctx.fileId;
        if (home !== target.fileId)
          emit(ctx.moduleSymbolId, target.moduleSymbolId, 'imports', meta);
      }
      if (imp.reexport) continue;
      const name = localNameOf(imp, ctx.language);
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
    if (!b) {
      if (local.has(key.split('.')[0]!)) return null;
      if (ref.receiver !== 'none') return undefined;
      const star = viaStars(ctx, ref.name, new Set(), true);
      if (star?.binding?.kind === 'symbol') return star.binding.sym;
      return star?.unresolved ? null : undefined;
    }
    if (ref.receiver === 'none') {
      if (b.kind === 'symbol') return b.sym;
      const d = b.kind === 'module' ? exportOf(b.ctx, 'default') : null;
      if (d?.kind === 'symbol') return d.sym;
      // Default unknown (e.g. a package): `const x = require('...')` also declares a
      // top-level variable `x`, and the call goes through it.
      const own = ctx.byQName.get(ref.name);
      return own && own.kind !== 'module' ? own : null;
    }
    if (b.kind === 'module') {
      const e = exportOf(b.ctx, ref.name);
      return e?.kind === 'symbol' ? e.sym : null;
    }
    if (b.kind === 'symbol') {
      const hit = member(b.sym, ref.name);
      if (hit || !b.home || (b.sym.kind !== 'function' && b.sym.kind !== 'variable')) return hit;
      const e = exportOf(b.home, ref.name);
      return e?.kind === 'symbol' ? e.sym : null;
    }
    return null;
  };

  // 2) Heritage. Resolved `extends` edges feed method lookup through parents.
  const parents = new Map<number, SymbolRow[]>();
  for (const ctx of contexts.values()) {
    for (const ref of refsByFile.get(ctx.fileId) ?? []) {
      if (ref.kind !== 'extends' && ref.kind !== 'implements') continue;
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

  // 3) Calls and references. A value in a `module.exports = { … }` object counts for the module.
  for (const ctx of contexts.values()) {
    for (const ref of refsByFile.get(ctx.fileId) ?? []) {
      if (ref.kind !== 'calls' && ref.kind !== 'references') continue;
      const src = srcOf(ctx, ref) ?? (ref.kind === 'references' ? ctx.moduleSymbolId : null);
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
      if (ref.kind === 'references') {
        if (dst && dst.id !== srcId && VALUE_KINDS.has(dst.kind))
          emit(srcId, dst.id, 'references', refMeta(ref));
        continue;
      }
      emit(srcId, dst?.id ?? null, 'calls', refMeta(ref));
    }
  }

  insertEdges(db, edges);
  return stats;
}

const EXTERNAL: Binding = { kind: 'external' };
const VALUE_KINDS = new Set(['function', 'method', 'class']);

/** The local name an import binds: alias, the named import, or a Python `import a.b`'s module. */
function localNameOf(imp: ImportRow, language: string): string | null {
  const named = imp.imported !== null && imp.imported !== '*' && imp.imported !== 'default';
  return (
    imp.alias ??
    (named ? imp.imported : null) ??
    (imp.imported === null && language === 'python' ? imp.module : null)
  );
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
