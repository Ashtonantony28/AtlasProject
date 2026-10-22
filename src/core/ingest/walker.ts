import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';
import { detectLanguage, type LanguageId } from './language.js';

export interface WalkOptions {
  // Extra exclude globs (added to .gitignore rules).
  exclude?: string[];
  // Gitignore-style globs; when non-empty only matching files are walked.
  include?: string[];
  // Languages to keep; omitted = all supported.
  languages?: LanguageId[];
  // Hard maximum file size in bytes (skipped if larger). Default 1 MiB.
  maxBytes?: number;
}

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  language: LanguageId;
  sizeBytes: number;
}

// A directory (path ends in `/`; the root is `''`) or file the walk could not read.
export interface UnreadableEntry {
  path: string;
  reason: string;
}

// A supported source file left out because it exceeds `maxBytes`.
export interface OversizedEntry {
  path: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  unreadable: UnreadableEntry[];
  tooLarge: OversizedEntry[];
}

export const DEFAULT_MAX_BYTES = 1024 * 1024;

// Directory names that never hold project source, skipped at any depth. Everything else
// (`dist`, `build`, `coverage`, …) is left to `.gitignore` and the config `exclude`.
const ALWAYS_SKIP = new Set(['.git', '.atlas', 'node_modules', '__pycache__']);

type Ignore = ReturnType<typeof ignore>;

// A set of gitignore rules and the directory (relative POSIX, `''` = root) they apply to.
interface Rules {
  base: string;
  ig: Ignore;
}

function readGitignore(dir: string): Ignore | null {
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) return null;
  try {
    return ignore().add(readFileSync(gi, 'utf8'));
  } catch {
    return null;
  }
}

// Gitignore precedence: deeper files override shallower ones; the config `exclude` comes last.
function isIgnored(rules: Rules[], rel: string): boolean {
  let ignored = false;
  for (const { base, ig } of rules) {
    const r = ig.test(base ? rel.slice(base.length + 1) : rel);
    if (r.ignored) ignored = true;
    else if (r.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Walk `root` for supported source files, honoring every `.gitignore` in the tree, the
 * `exclude` globs, ALWAYS_SKIP and virtualenvs (directories holding `pyvenv.cfg`).
 * Returns relative POSIX paths (with `/` separators) for portability.
 */
export function walkRepo(root: string, opts: WalkOptions = {}): WalkedFile[] {
  return walkRepoReport(root, opts).files;
}

/** Like `walkRepo`, but also reports what could not be read, so callers never mistake it for a deletion. */
export function walkRepoReport(root: string, opts: WalkOptions = {}): WalkResult {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const exclude: Rules[] =
    opts.exclude && opts.exclude.length > 0 ? [{ base: '', ig: ignore().add(opts.exclude) }] : [];
  const inc = opts.include && opts.include.length > 0 ? ignore().add(opts.include) : null;
  const langs = opts.languages ? new Set(opts.languages) : null;
  const out: WalkedFile[] = [];
  const unreadable: UnreadableEntry[] = [];
  const tooLarge: OversizedEntry[] = [];
  const toRel = (abs: string): string => relative(root, abs).split(sep).join('/');

  const visit = (dir: string, inherited: Rules[]): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const rel = toRel(dir);
      unreadable.push({ path: rel ? `${rel}/` : '', reason: (err as Error).message });
      return;
    }
    const own = readGitignore(dir);
    const parents = own ? [...inherited, { base: toRel(dir), ig: own }] : inherited;
    const rules = [...parents, ...exclude];
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toRel(abs);
      if (!rel) continue;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        if (isIgnored(rules, rel + '/')) continue;
        if (existsSync(join(abs, 'pyvenv.cfg'))) continue;
        visit(abs, parents);
      } else if (e.isFile()) {
        if (isIgnored(rules, rel)) continue;
        if (inc && !inc.ignores(rel)) continue;
        const lang = detectLanguage(e.name);
        if (!lang || (langs && !langs.has(lang))) continue;
        let st;
        try {
          st = statSync(abs);
        } catch (err) {
          unreadable.push({ path: rel, reason: (err as Error).message });
          continue;
        }
        if (st.size > max) {
          tooLarge.push({ path: rel, sizeBytes: st.size });
          continue;
        }
        out.push({
          absolutePath: abs,
          relativePath: rel,
          language: lang,
          sizeBytes: st.size,
        });
      }
    }
  };

  visit(root, []);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  tooLarge.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, unreadable, tooLarge };
}
