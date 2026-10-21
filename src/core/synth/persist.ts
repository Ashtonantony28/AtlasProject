// Docs persisted as markdown under `.atlas/docs/` so they can be committed and
// checked for drift from a fresh index (e.g. in CI):
//   files/<path>.md     one per module doc
//   architecture.md     the architecture doc
// Each file starts with front matter carrying the doc's source_hash.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { type DB, getAllDocs, getAllFiles, getDoc, upsertDoc } from '../db/index.js';

export interface PersistedDoc {
  kind: 'file' | 'architecture';
  target: string; // file path, or "architecture"
  sourceHash: string;
  content: string;
}

const ARCHITECTURE_FILE = 'architecture.md';
const FILES_DIR = 'files';

function relPathFor(doc: Pick<PersistedDoc, 'kind' | 'target'>): string {
  return doc.kind === 'architecture' ? ARCHITECTURE_FILE : join(FILES_DIR, `${doc.target}.md`);
}

function render(doc: PersistedDoc): string {
  return `---\nkind: ${doc.kind}\ntarget: ${doc.target}\nsource_hash: ${doc.sourceHash}\n---\n${doc.content}\n`;
}

function parse(text: string): PersistedDoc | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const meta = new Map<string, string>();
  for (const line of (m[1] ?? '').split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) meta.set(line.slice(0, i), line.slice(i + 2));
  }
  const kind = meta.get('kind');
  const target = meta.get('target');
  const sourceHash = meta.get('source_hash');
  if ((kind !== 'file' && kind !== 'architecture') || !target || !sourceHash) return null;
  return { kind, target, sourceHash, content: (m[2] ?? '').replace(/\n$/, '') };
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Every module/architecture doc in the DB, addressed by file path. */
export function docsFromDb(db: DB): PersistedDoc[] {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const out: PersistedDoc[] = [];
  for (const d of getAllDocs(db)) {
    const target = d.target_kind === 'architecture' ? 'architecture' : paths.get(d.target_id);
    if (!target || (d.target_kind !== 'file' && d.target_kind !== 'architecture')) continue;
    out.push({ kind: d.target_kind, target, sourceHash: d.source_hash, content: d.content });
  }
  return out;
}

/** Mirror the DB's docs into `dir`, rewriting only changed files and pruning orphans. */
export function exportDocs(
  db: DB,
  dir: string,
): { written: number; removed: number; total: number } {
  const docs = docsFromDb(db);
  const expected = new Set<string>();
  let written = 0;
  for (const doc of docs) {
    const p = join(dir, relPathFor(doc));
    expected.add(p);
    const text = render(doc);
    if (existsSync(p) && readFileSync(p, 'utf8') === text) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    written++;
  }
  let removed = 0;
  for (const p of walkMarkdown(dir)) {
    if (expected.has(p)) continue;
    unlinkSync(p);
    removed++;
    for (let d = dirname(p); d !== dir && relative(dir, d).split(sep)[0] !== '..'; d = dirname(d)) {
      if (readdirSync(d).length > 0) break;
      rmdirSync(d);
    }
  }
  return { written, removed, total: docs.length };
}

/** Parse every persisted doc under `dir` (missing dir → none), sorted by target. */
export function readPersistedDocs(dir: string): PersistedDoc[] {
  const out: PersistedDoc[] = [];
  for (const p of walkMarkdown(dir)) {
    const doc = parse(readFileSync(p, 'utf8'));
    if (doc && join(dir, relPathFor(doc)) === p) out.push(doc);
  }
  return out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/** Seed the DB with persisted docs it lacks, so unchanged docs are cache hits. */
export function importPersistedDocs(db: DB, dir: string): number {
  const ids = new Map(getAllFiles(db).map((f) => [f.path, f.id]));
  let imported = 0;
  for (const doc of readPersistedDocs(dir)) {
    const id = doc.kind === 'architecture' ? 0 : ids.get(doc.target);
    if (id === undefined || getDoc(db, doc.kind, id)) continue;
    upsertDoc(db, {
      target_kind: doc.kind,
      target_id: id,
      content: doc.content,
      source_hash: doc.sourceHash,
    });
    imported++;
  }
  return imported;
}
