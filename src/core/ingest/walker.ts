import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';
import { detectLanguage, type LanguageId } from './language.js';

export interface WalkOptions {
  // Extra exclude globs (added to .gitignore rules).
  exclude?: string[];
  // Hard maximum file size in bytes (skipped if larger). Default 1 MiB.
  maxBytes?: number;
}

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  language: LanguageId;
  sizeBytes: number;
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
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ig = loadGitignore(root);
  if (opts.exclude && opts.exclude.length > 0) {
    ig.add(opts.exclude);
  }
  const out: WalkedFile[] = [];

  const visit = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (!rel) continue;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        if (ig.ignores(rel + '/')) continue;
        visit(abs);
      } else if (e.isFile()) {
        if (ig.ignores(rel)) continue;
        const lang = detectLanguage(e.name);
        if (!lang) continue;
        let st;
        try {
          st = statSync(abs);
        } catch {
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
  return out;
}
