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
import {
  type DB,
  getAllDocs,
  getAllFiles,
  getDoc,
  getDocTombstones,
  upsertDoc,
} from '../db/index.js';

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

function parse(raw: string): PersistedDoc | null {
  const text = raw.replace(/\r\n/g, '\n');
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

/** Docs of files pruned since the last `atlas docs` run, by their old path (newest wins). */
export function deletedDocsFromDb(db: DB): PersistedDoc[] {
  const byPath = new Map<string, PersistedDoc>();
  for (const t of getDocTombstones(db)) {
    byPath.set(t.path, {
      kind: 'file',
      target: t.path,
      sourceHash: t.source_hash,
      content: t.content,
    });
  }
  return [...byPath.values()];
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

export type DocEntry = PersistedDoc & { source: 'index' | 'persisted' };

/** Docs from the index, with `dir` (`.atlas/docs`) filling targets the index lacks. Read-only. */
export function listDocs(db: DB, dir: string): DocEntry[] {
  const out = new Map<string, DocEntry>();
  for (const d of readPersistedDocs(dir)) out.set(d.target, { ...d, source: 'persisted' });
  for (const d of docsFromDb(db)) out.set(d.target, { ...d, source: 'index' });
  return [...out.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/** `listDocs(db, dir).length` without reading any doc content (persisted docs counted by file name). */
export function countDocs(db: DB, dir: string): number {
  const targets = new Set(
    db
      .prepare(
        `SELECT f.path FROM docs d JOIN files f ON f.id = d.target_id WHERE d.target_kind = 'file'
         UNION SELECT 'architecture' FROM docs WHERE target_kind = 'architecture'`,
      )
      .pluck()
      .all() as string[],
  );
  const filesDir = join(dir, FILES_DIR);
  for (const p of walkMarkdown(dir)) {
    if (p === join(dir, ARCHITECTURE_FILE)) targets.add('architecture');
    else if (p.startsWith(filesDir + sep)) {
      targets.add(relative(filesDir, p).slice(0, -'.md'.length).split(sep).join('/'));
    }
  }
  return targets.size;
}

/** The doc for a file path or "architecture"; throws when there is none. */
export function findDoc(db: DB, dir: string, target: string): DocEntry {
  const doc = listDocs(db, dir).find((d) => d.target === target);
  if (!doc) throw new Error(`no doc for '${target}': run \`atlas docs\` to generate docs`);
  return doc;
}
