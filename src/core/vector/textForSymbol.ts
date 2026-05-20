// Build the text we hand to the embedder for each symbol. Combining the name,
// qualified name, kind, signature, docstring, and source slice gives much
// better recall than name alone.

import type { DB, SymbolRow } from '../db/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SLICE_MAX_LINES = 30;

interface FileLike {
  path: string;
}

export function buildSymbolText(
  sym: SymbolRow,
  file: FileLike,
  source: string | null,
): string {
  const parts: string[] = [];
  parts.push(`${sym.kind}: ${sym.qualified_name ?? sym.name}`);
  if (sym.signature) parts.push(sym.signature);
  if (sym.docstring) parts.push(stripDocComment(sym.docstring));
  parts.push(`file: ${file.path}`);
  if (source) {
    const slice = sliceLines(source, sym.start_line, Math.min(sym.end_line, sym.start_line + SLICE_MAX_LINES));
    parts.push(slice);
  }
  return parts.join('\n');
}

function sliceLines(src: string, start1: number, end1: number): string {
  const lines = src.split('\n');
  const s = Math.max(0, start1 - 1);
  const e = Math.min(lines.length, end1);
  return lines.slice(s, e).join('\n');
}

function stripDocComment(doc: string): string {
  return doc
    .replace(/^\/\*\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

/** Read a file once and cache its source by file id. */
export function makeSourceLoader(root: string) {
  const cache = new Map<number, string | null>();
  return function loadSource(fileId: number, filePath: string): string | null {
    if (cache.has(fileId)) return cache.get(fileId) ?? null;
    try {
      const txt = readFileSync(join(root, filePath), 'utf8');
      cache.set(fileId, txt);
      return txt;
    } catch {
      cache.set(fileId, null);
      return null;
    }
  };
}

/** Pulled out so callers (search/synth/Q&A) can read raw source consistently. */
export function readFileFromRoot(root: string, db: DB, fileId: number): string | null {
  const row = db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as
    | { path: string }
    | undefined;
  if (!row) return null;
  try {
    return readFileSync(join(root, row.path), 'utf8');
  } catch {
    return null;
  }
}
