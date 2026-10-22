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
type Match = ReturnType<Ignore['test']>;

// A set of gitignore rules and the directory (relative POSIX, `''` = root) they apply to.
// `local` sets hold only patterns with no `/` except a trailing one (and no `**`): git matches
// those against the last path segment at any depth, so the entry name is enough to test them.
interface Rules {
  base: string;
  ig: Ignore;
  local: boolean;
}

function readGitignore(dir: string): { ig: Ignore; local: boolean } | null {
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) return null;
  try {
    const text = readFileSync(gi, 'utf8');
    return { ig: ignore().add(text), local: segmentLocal(text) };
  } catch {
    return null;
  }
}

/** True when every pattern in `text` matches a single path segment (see `Rules.local`). */
export function segmentLocal(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const pat = line.replace(/^!/, '').replace(/\/+$/, '');
    if (!pat || pat.includes('/') || pat.includes('**') || pat.includes('\\')) return false;
  }
  return true;
}

// `ignore`'s `test()` also ignores a path when the same set ignores one of its parent directories.
// Git applies that rule across all sets instead (a deeper set can re-include the directory), which
// the walk does by not descending into ignored directories, so each set is asked about the path's
// own match only.
function ownMatch(ig: Ignore, path: string): Match {
  return (ig as Ignore & { _testOne(path: string, checkUnignored: boolean): Match })._testOne(
    path,
    true,
  );
}

/**
 * Append a directory's .gitignore set to its ancestors' (shallowest first), merging a run of
 * consecutive segment-local sets into one matcher. Within one `ignore` instance the last
 * matching rule decides, and across sets the deepest non-neutral set decides, so concatenating
 * the rules of consecutive sets gives the same verdict. Entries are then tested against a handful
 * of groups, whatever the number of ancestor `.gitignore` files (A10-04).
 */
function extendGroups(groups: Rules[], own: Rules): Rules[] {
  const last = groups[groups.length - 1];
  if (!own.local || !last?.local) return [...groups, own];
  return [...groups.slice(0, -1), { base: '', ig: ignore().add(last.ig).add(own.ig), local: true }];
}

// Git's verdict on an entry of a walked directory: the config `exclude` first, then the deepest
// .gitignore set with a matching rule.
function isIgnored(
  groups: Rules[],
  exclude: Rules[],
  rel: string,
  name: string,
  isDir: boolean,
): boolean {
  for (const sets of [exclude, groups]) {
    for (let i = sets.length - 1; i >= 0; i--) {
      const { base, ig, local } = sets[i]!;
      const path = local ? name : base ? rel.slice(base.length + 1) : rel;
      const r = ownMatch(ig, isDir ? `${path}/` : path);
      if (r.ignored) return true;
      if (r.unignored) return false;
    }
  }
  return false;
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
    opts.exclude && opts.exclude.length > 0
      ? [{ base: '', ig: ignore().add(opts.exclude), local: false }]
      : [];
  const inc = opts.include && opts.include.length > 0 ? ignore().add(opts.include) : null;
  const langs = opts.languages ? new Set(opts.languages) : null;
  const out: WalkedFile[] = [];
  const unreadable: UnreadableEntry[] = [];
  const tooLarge: OversizedEntry[] = [];
  const toRel = (abs: string): string => relative(root, abs).split(sep).join('/');

  // `inherited`: the ancestors' .gitignore groups (see `extendGroups`).
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
    const groups = own ? extendGroups(inherited, { base: toRel(dir), ...own }) : inherited;
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toRel(abs);
      if (!rel) continue;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        // An ignored directory is not walked, so nothing inside it can be re-included.
        if (isIgnored(groups, exclude, rel, e.name, true)) continue;
        if (existsSync(join(abs, 'pyvenv.cfg'))) continue;
        visit(abs, groups);
      } else if (e.isFile()) {
        if (isIgnored(groups, exclude, rel, e.name, false)) continue;
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
