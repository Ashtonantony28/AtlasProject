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

/**
 * Per rule set, whether the directory being visited is ignored by that set alone. `ignore`'s
 * own `test(path)` re-derives this from every parent segment on each call, which made the walk
 * cubic in the depth of nested `.gitignore` files (A10-04); here it is carried down instead.
 */
type DirState = boolean[];

// Gitignore precedence: deeper files override shallower ones; the config `exclude` comes last.
// Same verdict as testing `rel` with each set's `ig.test()` in order (last non-neutral wins).
function verdict(
  rules: Rules[],
  state: DirState,
  rel: string,
  name: string,
  isDir: boolean,
): { ignored: boolean; perSet: DirState } {
  let ignored = false;
  const perSet: DirState = isDir ? new Array<boolean>(rules.length) : [];
  for (let i = 0; i < rules.length; i++) {
    const { base, ig, local } = rules[i]!;
    let r: { ignored: boolean; unignored: boolean };
    if (state[i]) r = { ignored: true, unignored: false };
    else {
      const path = local && !/^\.+$/.test(name) ? name : base ? rel.slice(base.length + 1) : rel;
      r = ig.test(isDir ? `${path}/` : path);
    }
    if (r.ignored) ignored = true;
    else if (r.unignored) ignored = false;
    if (isDir) perSet[i] = r.ignored;
  }
  return { ignored, perSet };
}

/**
 * The .gitignore sets after the last one that already ignores the directory (`from`), with
 * each run of consecutive segment-local sets merged into one matcher. Within one `ignore`
 * instance the last matching rule decides, and across sets the last non-neutral set decides,
 * so concatenating the rules of consecutive sets gives the same verdict. Files are then tested
 * against a handful of groups, whatever the number of ancestor `.gitignore` files. A child
 * directory extends its parent's groups instead of rebuilding them.
 */
interface Groups {
  from: number;
  count: number;
  groups: Rules[];
}

function gitGroups(sets: Rules[], state: DirState, prev: Groups | null): Groups {
  let from = sets.length;
  while (from > 0 && !state[from - 1]) from--;
  const extend = prev !== null && prev.from === from;
  const groups = extend ? prev.groups.slice() : [];
  for (let i = extend ? prev.count : from; i < sets.length; i++) {
    const r = sets[i]!;
    const last = groups[groups.length - 1];
    if (r.local && last?.local) {
      groups[groups.length - 1] = { base: '', ig: ignore().add(last.ig).add(r.ig), local: true };
    } else groups.push(r);
  }
  return { from, count: sets.length, groups };
}

/** Same verdict as `verdict(rules, state, rel, name, false)` when no `exclude` set is forced. */
function fileIgnored(g: Groups, exclude: Rules[], rel: string, name: string): boolean {
  for (const groups of [exclude, g.groups]) {
    for (let i = groups.length - 1; i >= 0; i--) {
      const { base, ig, local } = groups[i]!;
      const r = ig.test(local ? name : base ? rel.slice(base.length + 1) : rel);
      if (r.ignored) return true;
      if (r.unignored) return false;
    }
  }
  return g.from > 0;
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

  // `inherited`: the ancestors' .gitignore sets. `state`: per set of `[...inherited, ...exclude]`,
  // whether `dir` is ignored by that set.
  const visit = (
    dir: string,
    inherited: Rules[],
    state: DirState,
    inheritedGroups: Groups | null,
  ): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const rel = toRel(dir);
      unreadable.push({ path: rel ? `${rel}/` : '', reason: (err as Error).message });
      return;
    }
    const own = readGitignore(dir);
    const parents = own ? [...inherited, { base: toRel(dir), ...own }] : inherited;
    const rules = [...parents, ...exclude];
    const ruleState = own
      ? [...state.slice(0, inherited.length), false, ...state.slice(inherited.length)]
      : state;
    // An `exclude` set never ignores a visited directory (it is the last set, so the directory
    // would have been skipped); the per-set path covers that case anyway.
    const fast = !ruleState.slice(parents.length).some(Boolean);
    const groups = gitGroups(parents, ruleState, inheritedGroups);
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toRel(abs);
      if (!rel) continue;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        const v = verdict(rules, ruleState, rel, e.name, true);
        if (v.ignored) continue;
        if (existsSync(join(abs, 'pyvenv.cfg'))) continue;
        visit(abs, parents, v.perSet, groups);
      } else if (e.isFile()) {
        if (fast && !/^\.+$/.test(e.name)) {
          if (fileIgnored(groups, exclude, rel, e.name)) continue;
        } else if (verdict(rules, ruleState, rel, e.name, false).ignored) continue;
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

  visit(
    root,
    [],
    exclude.map(() => false),
    null,
  );
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  tooLarge.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, unreadable, tooLarge };
}
