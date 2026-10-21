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

export interface WalkResult {
  files: WalkedFile[];
  unreadable: UnreadableEntry[];
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

// Common always-skip directories. Lightweight defensive defaults.
const ALWAYS_SKIP = new Set([
  '.git',
  '.atlas',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
]);

function loadGitignore(root: string): ReturnType<typeof ignore> {
  const ig = ignore();
  const gi = join(root, '.gitignore');
  if (existsSync(gi)) {
    try {
      ig.add(readFileSync(gi, 'utf8'));
    } catch {
      // ignore parse failures; treat as no .gitignore
    }
  }
  return ig;
}

/**
 * Walk `root` for supported source files, honoring .gitignore and ALWAYS_SKIP.
 * Returns relative POSIX paths (with `/` separators) for portability.
 */
export function walkRepo(root: string, opts: WalkOptions = {}): WalkedFile[] {
  return walkRepoReport(root, opts).files;
}

/** Like `walkRepo`, but also reports what could not be read, so callers never mistake it for a deletion. */
export function walkRepoReport(root: string, opts: WalkOptions = {}): WalkResult {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ig = loadGitignore(root);
  if (opts.exclude && opts.exclude.length > 0) {
    ig.add(opts.exclude);
  }
  const inc = opts.include && opts.include.length > 0 ? ignore().add(opts.include) : null;
  const langs = opts.languages ? new Set(opts.languages) : null;
  const out: WalkedFile[] = [];
  const unreadable: UnreadableEntry[] = [];
  const toRel = (abs: string): string => relative(root, abs).split(sep).join('/');

  const visit = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const rel = toRel(dir);
      unreadable.push({ path: rel ? `${rel}/` : '', reason: (err as Error).message });
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toRel(abs);
      if (!rel) continue;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        if (ig.ignores(rel + '/')) continue;
        visit(abs);
      } else if (e.isFile()) {
        if (ig.ignores(rel)) continue;
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
        if (st.size > max) continue;
        out.push({
          absolutePath: abs,
          relativePath: rel,
          language: lang,
          sizeBytes: st.size,
        });
      }
    }
  };

  visit(root);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files: out, unreadable };
}
