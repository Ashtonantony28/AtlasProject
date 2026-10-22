// Module specifier → indexed file. JS/TS: relative paths, tsconfig/jsconfig `paths` and
// `baseUrl` (with local `extends`), then workspace packages. Python: relative imports, the
// repo root, the importer's package root, configured or `src/` roots, then a unique
// discovered package root. Config files are read from disk once (read-only, cached); the
// only directories listed are those holding indexed files and the configs they reference.

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface ModuleFile {
  filePath: string;
  language: string;
}

interface TsConfig {
  dir: string;
  baseUrl: string | null; // repo-relative directory
  paths: { pattern: string; targets: string[]; base: string }[];
  references: string[];
}

interface PathsScope {
  baseUrl: string | null;
  paths: { prefix: string; suffix: string; star: boolean; targets: string[]; base: string }[];
}

interface WorkspacePkg {
  dir: string;
  json: Record<string, unknown>;
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_CANDIDATES = ['', ...TS_EXTS, ...TS_EXTS.map((e) => `/index${e}`)];
const CONDITIONS = ['source', 'types', 'import', 'module', 'default', 'require', 'node'];

export class ModuleResolver<T extends ModuleFile> {
  readonly diagnostics: string[] = [];
  private readonly dirs = new Map<string, Set<string>>();
  private readonly json = new Map<string, Record<string, unknown> | null>();
  private readonly tsconfigs = new Map<string, TsConfig | null>();
  private readonly scopes = new Map<string, PathsScope | null>();
  private knownDirs: Set<string> | null = null;
  private workspaces: Map<string, WorkspacePkg | null> | null = null;
  private python: { roots: string[]; discovered: Map<string, string[]> } | null = null;

  constructor(
    private readonly root: string,
    private readonly byPath: Map<string, T>,
  ) {}

  resolve(from: T, spec: string): T | null {
    if (from.language === 'python') return this.resolvePython(from, spec);
    const dir = posix.dirname(from.filePath);
    if (spec.startsWith('.') || spec.startsWith('/')) return this.file(posix.join(dir, spec));
    if (!spec) return null;
    return this.viaTsconfig(dir, spec) ?? this.viaWorkspace(spec);
  }

  /** `from pkg import util` where `util` is a submodule rather than a name in `pkg/__init__.py`. */
  submodule(from: T, spec: string, name: string): T | null {
    if (from.language !== 'python') return null;
    return this.resolvePython(from, /\.$/.test(spec) ? spec + name : `${spec}.${name}`);
  }

  private file(path: string): T | null {
    const base = path.replace(/(\.d)?\.[cm]?[jt]sx?$/i, '');
    for (const ext of TS_CANDIDATES) {
      const hit = this.byPath.get(normalizePosix(base + ext));
      if (hit) return hit;
    }
    return null;
  }

  // --- tsconfig / jsconfig

  private viaTsconfig(dir: string, spec: string): T | null {
    const scope = this.scopeFor(dir);
    if (!scope) return null;
    let best: PathsScope['paths'][number] | null = null;
    for (const p of scope.paths) {
      const fits = p.star
        ? spec.length >= p.prefix.length + p.suffix.length &&
          spec.startsWith(p.prefix) &&
          spec.endsWith(p.suffix)
        : spec === p.prefix;
      if (!fits) continue;
      if (!p.star) {
        best = p;
        break;
      }
      if (!best || p.prefix.length > best.prefix.length) best = p;
    }
    if (best) {
      const star = best.star
        ? spec.slice(best.prefix.length, spec.length - best.suffix.length)
        : '';
      const base = scope.baseUrl ?? best.base;
      for (const t of best.targets) {
        const hit = this.file(posix.join(base || '.', t.replace('*', star)));
        if (hit) return hit;
      }
    }
    return scope.baseUrl === null ? null : this.file(posix.join(scope.baseUrl || '.', spec));
  }

  /** The `paths`/`baseUrl` of the nearest tsconfig.json or jsconfig.json at or above `dir`. */
  private scopeFor(dir: string): PathsScope | null {
    const key = normalizePosix(dir);
    if (this.scopes.has(key)) return this.scopes.get(key)!;
    const entries = this.list(key);
    const name = entries.has('tsconfig.json')
      ? 'tsconfig.json'
      : entries.has('jsconfig.json')
        ? 'jsconfig.json'
        : null;
    let scope: PathsScope | null;
    if (name) {
      let cfg = this.tsconfig(joinRel(key, name), new Set());
      // Solution-style config (`files: []` + `references`): take the first reference with aliases.
      if (cfg && !cfg.paths.length && cfg.baseUrl === null) {
        for (const ref of cfg.references) {
          const r = this.tsconfig(
            ref.endsWith('.json') ? ref : joinRel(ref, 'tsconfig.json'),
            new Set(),
          );
          if (r && (r.paths.length || r.baseUrl !== null)) {
            cfg = r;
            break;
          }
        }
      }
      scope = cfg && (cfg.paths.length || cfg.baseUrl !== null) ? toScope(cfg) : null;
    } else {
      scope = key ? this.scopeFor(parentOf(key)) : null;
    }
    this.scopes.set(key, scope);
    return scope;
  }

  private tsconfig(path: string, seen: Set<string>): TsConfig | null {
    if (this.tsconfigs.has(path)) return this.tsconfigs.get(path)!;
    if (seen.has(path)) {
      this.diagnostics.push(`${path}: circular "extends"`);
      return null;
    }
    seen.add(path);
    const json = this.readJson(path);
    if (!json) return null;
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const cfg: TsConfig = { dir, baseUrl: null, paths: [], references: [] };
    const ext = json.extends;
    for (const e of typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : []) {
      // Package configs (`@tsconfig/node20`) live in node_modules and are not followed.
      if (typeof e !== 'string' || !e.startsWith('.')) continue;
      let target = joinRel(dir, e);
      if (!target.endsWith('.json'))
        target = this.list(target).has('tsconfig.json')
          ? joinRel(target, 'tsconfig.json')
          : `${target}.json`;
      const parent = this.tsconfig(target, seen);
      if (!parent) continue;
      if (parent.baseUrl !== null) cfg.baseUrl = parent.baseUrl;
      if (parent.paths.length) cfg.paths = parent.paths;
    }
    const opts = json.compilerOptions;
    if (isRecord(opts)) {
      if (typeof opts.baseUrl === 'string') cfg.baseUrl = joinRel(dir, opts.baseUrl);
      if (isRecord(opts.paths)) {
        cfg.paths = [];
        for (const [pattern, targets] of Object.entries(opts.paths)) {
          if (!Array.isArray(targets)) continue;
          const ts = targets.filter((t): t is string => typeof t === 'string');
          cfg.paths.push({ pattern, targets: ts, base: dir });
        }
      }
    }
    if (Array.isArray(json.references)) {
      for (const r of json.references) {
        if (isRecord(r) && typeof r.path === 'string') cfg.references.push(joinRel(dir, r.path));
      }
    }
    this.tsconfigs.set(path, cfg);
    return cfg;
  }

  // --- workspaces

  private viaWorkspace(spec: string): T | null {
    const parts = spec.split('/');
    const n = spec.startsWith('@') ? 2 : 1;
    const pkg = this.workspacePackages().get(parts.slice(0, n).join('/'));
    if (!pkg) return null;
    const sub = parts.slice(n).join('/');
    for (const t of entryTargets(pkg.json, sub)) {
      const path = joinRel(pkg.dir, t);
      const hit =
        this.file(path) ??
        (/^(dist|lib|build|out)\//.test(normalizePosix(t))
          ? this.file(joinRel(pkg.dir, normalizePosix(t).replace(/^[^/]+/, 'src')))
          : null);
      if (hit) return hit;
    }
    return null;
  }

  /** Package name → directory for `workspaces` / `pnpm-workspace.yaml` members holding indexed files. */
  private workspacePackages(): Map<string, WorkspacePkg | null> {
    if (this.workspaces) return this.workspaces;
    const out = new Map<string, WorkspacePkg | null>();
    this.workspaces = out;
    const known = this.dirsOfFiles();
    for (const wsRoot of known) {
      const entries = this.list(wsRoot);
      const patterns: string[] = [];
      if (entries.has('package.json')) {
        const ws = this.readJson(joinRel(wsRoot, 'package.json'))?.workspaces;
        const list = Array.isArray(ws) ? ws : isRecord(ws) ? ws.packages : null;
        if (Array.isArray(list)) patterns.push(...list.filter((p) => typeof p === 'string'));
      }
      if (entries.has('pnpm-workspace.yaml')) {
        patterns.push(...pnpmPackages(this.read(joinRel(wsRoot, 'pnpm-workspace.yaml')) ?? ''));
      }
      if (!patterns.length) continue;
      const include = patterns.filter((p) => !p.startsWith('!')).map(globRegex);
      const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => globRegex(p.slice(1)));
      for (const dir of known) {
        const rel = wsRoot
          ? dir.startsWith(`${wsRoot}/`)
            ? dir.slice(wsRoot.length + 1)
            : null
          : dir;
        if (!rel || !include.some((r) => r.test(rel)) || exclude.some((r) => r.test(rel))) continue;
        if (!this.list(dir).has('package.json')) continue;
        const json = this.readJson(joinRel(dir, 'package.json'));
        if (!json || typeof json.name !== 'string') continue;
        const prev = out.get(json.name);
        if (prev && prev.dir !== dir) {
          this.diagnostics.push(
            `workspace package "${json.name}" is declared in ${prev.dir} and ${dir}`,
          );
          out.set(json.name, null);
        } else if (prev === undefined) out.set(json.name, { dir, json });
      }
    }
    return out;
  }

  // --- python

  private resolvePython(from: T, spec: string): T | null {
    const dots = /^\.*/.exec(spec)![0].length;
    const rel = spec.slice(dots).split('.').filter(Boolean).join('/');
    let roots: string[];
    if (dots > 0) {
      let dir = posix.dirname(from.filePath);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      roots = [dir];
    } else {
      let dir = posix.dirname(from.filePath);
      while (dir !== '.' && this.byPath.has(normalizePosix(`${dir}/__init__.py`)))
        dir = posix.dirname(dir);
      const env = this.pythonRoots();
      const found = env.discovered.get(rel.split('/')[0]!) ?? [];
      roots = ['.', dir, ...env.roots, ...(found.length === 1 ? found : [])];
    }
    for (const root of new Set(roots)) {
      const base = posix.join(root || '.', rel);
      for (const cand of rel
        ? [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]
        : [`${base}/__init__.py`]) {
        const hit = this.byPath.get(normalizePosix(cand));
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Configured roots (`src/` beside the repo root or a pyproject.toml / setup.cfg / setup.py,
   * plus their `where` / `package_dir` / poetry `from` dirs), and top-level package name →
   * the dirs holding it as a package (`<root>/<name>/__init__.py` with no `<root>/__init__.py`).
   */
  private pythonRoots(): { roots: string[]; discovered: Map<string, string[]> } {
    if (this.python) return this.python;
    const roots: string[] = [];
    const add = (d: string): void => {
      if (!roots.includes(d)) roots.push(d);
    };
    for (const dir of this.dirsOfFiles()) {
      const entries = this.list(dir);
      const cfgs = ['pyproject.toml', 'setup.cfg', 'setup.py'].filter((f) => entries.has(f));
      if (!cfgs.length && dir) continue;
      for (const f of cfgs.filter((c) => c !== 'setup.py')) {
        for (const d of pythonPackageDirs(this.read(joinRel(dir, f)) ?? '')) add(joinRel(dir, d));
      }
      if (entries.has('src')) add(joinRel(dir, 'src'));
    }
    const discovered = new Map<string, string[]>();
    for (const path of this.byPath.keys()) {
      if (!path.endsWith('/__init__.py')) continue;
      const pkg = posix.dirname(path);
      const parent = parentOf(pkg);
      if (this.byPath.has(joinRel(parent, '__init__.py'))) continue;
      const name = posix.basename(pkg);
      discovered.set(name, [...(discovered.get(name) ?? []), parent]);
    }
    this.python = { roots, discovered };
    return this.python;
  }

  // --- filesystem (read-only, cached)

  /** Every directory that holds an indexed file, and its ancestors; '' is the root. */
  private dirsOfFiles(): Set<string> {
    if (this.knownDirs) return this.knownDirs;
    const out = new Set<string>(['']);
    for (const path of this.byPath.keys()) {
      for (let d = parentOf(path); d && !out.has(d); d = parentOf(d)) out.add(d);
    }
    this.knownDirs = out;
    return out;
  }

  private list(dir: string): Set<string> {
    let entries = this.dirs.get(dir);
    if (!entries) {
      try {
        entries = dir.startsWith('..') ? new Set() : new Set(readdirSync(join(this.root, dir)));
      } catch {
        entries = new Set();
      }
      this.dirs.set(dir, entries);
    }
    return entries;
  }

  private read(path: string): string | null {
    if (path.startsWith('..') || !this.list(parentOf(path)).has(posix.basename(path))) return null;
    try {
      return readFileSync(join(this.root, path), 'utf8');
    } catch (err) {
      this.diagnostics.push(`${path}: ${(err as Error).message}`);
      return null;
    }
  }

  private readJson(path: string): Record<string, unknown> | null {
    if (this.json.has(path)) return this.json.get(path)!;
    const text = this.read(path);
    let out: Record<string, unknown> | null = null;
    if (text !== null) {
      try {
        const v = parseJsonc(text);
        if (isRecord(v)) out = v;
        else this.diagnostics.push(`${path}: not a JSON object`);
      } catch (err) {
        this.diagnostics.push(`${path}: ${(err as Error).message}`);
      }
    }
    this.json.set(path, out);
    return out;
  }
}

function toScope(cfg: TsConfig): PathsScope {
  return {
    baseUrl: cfg.baseUrl,
    paths: cfg.paths.map((p) => {
      const star = p.pattern.indexOf('*');
      return {
        prefix: star < 0 ? p.pattern : p.pattern.slice(0, star),
        suffix: star < 0 ? '' : p.pattern.slice(star + 1),
        star: star >= 0,
        targets: p.targets,
        base: p.base,
      };
    }),
  };
}

/** Candidate paths (relative to the package dir) for `name` or `name/sub`. */
function entryTargets(pkg: Record<string, unknown>, sub: string): string[] {
  const out: string[] = [];
  const key = sub ? `./${sub}` : '.';
  const exp = pkg.exports;
  if (isRecord(exp) && Object.keys(exp).some((k) => k.startsWith('.'))) {
    if (key in exp) out.push(...conditionTargets(exp[key]));
    else {
      for (const [k, v] of Object.entries(exp)) {
        const star = k.indexOf('*');
        if (star < 0) continue;
        const [pre, post] = [k.slice(0, star), k.slice(star + 1)];
        if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
          const s = key.slice(pre.length, key.length - post.length);
          out.push(...conditionTargets(v).map((t) => t.replaceAll('*', s)));
        }
      }
    }
  } else if (!sub && exp !== undefined) out.push(...conditionTargets(exp));
  if (sub) out.push(sub, `src/${sub}`);
  else {
    for (const f of ['source', 'module', 'main', 'types', 'typings']) {
      if (typeof pkg[f] === 'string') out.push(pkg[f] as string);
    }
    out.push('src/index', 'index');
  }
  return out;
}

function conditionTargets(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(conditionTargets);
  if (!isRecord(v)) return [];
  const keys = Object.keys(v).sort((a, b) => rank(a) - rank(b));
  return keys.flatMap((k) => conditionTargets(v[k]));
}

const rank = (c: string): number => {
  const i = CONDITIONS.indexOf(c);
  return i < 0 ? CONDITIONS.length : i;
};

function pnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line);
    const m = inPackages ? /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line) : null;
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Package dirs named by setuptools `where` / `package_dir` or poetry `from` (best effort). */
function pythonPackageDirs(text: string): string[] {
  const out: string[] = [];
  const re =
    /^\s*(?:where\s*=\s*\[?\s*["']?([^"'\]\s,]+)|""\s*=\s*["']([^"']+)|package_dir\s*=\s*(?:\n\s*)?=\s*(\S+))|\bfrom\s*=\s*["']([^"']+)/gm;
  for (const m of text.matchAll(re)) {
    const d = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (d && !d.startsWith('/') && d !== '.') out.push(d);
  }
  return out;
}

function globRegex(glob: string): RegExp {
  const body = normalizePosix(glob)
    .split('/')
    .map((seg) =>
      seg === '**'
        ? '.*'
        : seg
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
    )
    .join('/');
  return new RegExp(`^${body}$`);
}

/** JSON with comments and trailing commas (tsconfig/jsconfig); throws on anything else. */
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  const trivia = (i: number): number => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
      } else return i;
    }
  };
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = trivia(i);
      out.push(' ');
    } else if (c === ',' && '}]'.includes(text[trivia(i + 1)] ?? '')) {
      i++;
    } else {
      out.push(c);
      i++;
    }
  }
  return JSON.parse(out.join(''));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parentOf(p: string): string {
  const d = posix.dirname(p);
  return d === '.' || d === '/' ? '' : d;
}

function joinRel(dir: string, p: string): string {
  return normalizePosix(posix.join(dir || '.', p));
}

export function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const s of p.split(/[\\/]/)) {
    if (!s || s === '.') continue;
    if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}
