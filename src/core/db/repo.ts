// Typed query helpers around the SQLite index. Thin wrappers over prepared
// statements; keep query logic centralized so subsystems don't drift on schema.

import { immediate, prepareCached, type DB } from './database.js';
import type {
  FileRow,
  SymbolRow,
  EdgeRow,
  ImportRow,
  RefRow,
  DocRow,
  RunRow,
  SymbolKind,
  EdgeKind,
} from './types.js';

export interface UpsertFileInput {
  path: string;
  language: string;
  content_hash: string;
  loc: number;
}

export function upsertFile(db: DB, input: UpsertFileInput): number {
  const now = new Date().toISOString();
  const existing = prepareCached(db, 'SELECT id, content_hash FROM files WHERE path = ?').get(
    input.path,
  ) as { id: number; content_hash: string } | undefined;

  if (existing) {
    prepareCached(
      db,
      `UPDATE files
       SET language = ?, content_hash = ?, loc = ?, indexed_at = ?
       WHERE id = ?`,
    ).run(input.language, input.content_hash, input.loc, now, existing.id);
    return existing.id;
  }

  const info = prepareCached(
    db,
    `INSERT INTO files (path, language, content_hash, loc, indexed_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(input.path, input.language, input.content_hash, input.loc, now);
  return Number(info.lastInsertRowid);
}

export function getFileByPath(db: DB, path: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
}

export function getAllFiles(db: DB): FileRow[] {
  return db.prepare('SELECT * FROM files ORDER BY path').all() as FileRow[];
}

export function deleteSymbolsForFile(db: DB, fileId: number): void {
  prepareCached(db, 'DELETE FROM symbols WHERE file_id = ?').run(fileId);
}

export function deleteImportsForFile(db: DB, fileId: number): void {
  prepareCached(db, 'DELETE FROM imports WHERE file_id = ?').run(fileId);
}

export interface InsertSymbolInput {
  file_id: number;
  kind: SymbolKind;
  name: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  docstring: string | null;
  qualified_name: string | null;
  exported: boolean;
}

export function insertSymbol(db: DB, input: InsertSymbolInput): number {
  const info = prepareCached(
    db,
    `INSERT INTO symbols (file_id, kind, name, signature, start_line, end_line, docstring, qualified_name, exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.file_id,
    input.kind,
    input.name,
    input.signature,
    input.start_line,
    input.end_line,
    input.docstring,
    input.qualified_name,
    input.exported ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

/** Row-for-row the same as calling `insertSymbol` for each input, in order (A10-02). */
export function insertSymbols(db: DB, inputs: readonly InsertSymbolInput[]): void {
  insertBatched(
    db,
    'INSERT INTO symbols (file_id, kind, name, signature, start_line, end_line, docstring, qualified_name, exported)',
    9,
    inputs,
    (s, out) =>
      out.push(
        s.file_id,
        s.kind,
        s.name,
        s.signature,
        s.start_line,
        s.end_line,
        s.docstring,
        s.qualified_name,
        s.exported ? 1 : 0,
      ),
  );
}

export function getSymbolsForFile(db: DB, fileId: number): SymbolRow[] {
  return db
    .prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line')
    .all(fileId) as SymbolRow[];
}

export function getAllSymbols(db: DB): SymbolRow[] {
  return db.prepare('SELECT * FROM symbols ORDER BY id').all() as SymbolRow[];
}

export function findSymbolByName(db: DB, name: string): SymbolRow[] {
  return db.prepare('SELECT * FROM symbols WHERE name = ?').all(name) as SymbolRow[];
}

export function findSymbolsByKind(db: DB, kind: SymbolKind): SymbolRow[] {
  return db.prepare('SELECT * FROM symbols WHERE kind = ?').all(kind) as SymbolRow[];
}

export interface InsertEdgeInput {
  src_symbol: number | null;
  dst_symbol: number | null;
  kind: EdgeKind;
  weak: boolean;
  meta?: string | null;
}

export function insertEdge(db: DB, input: InsertEdgeInput): number {
  const info = db
    .prepare(
      `INSERT INTO edges (src_symbol, dst_symbol, kind, weak, meta)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.src_symbol, input.dst_symbol, input.kind, input.weak ? 1 : 0, input.meta ?? null);
  return Number(info.lastInsertRowid);
}

export function insertEdges(db: DB, edges: InsertEdgeInput[]): void {
  insertBatched(
    db,
    'INSERT INTO edges (src_symbol, dst_symbol, kind, weak, meta)',
    5,
    edges,
    (e, out) => out.push(e.src_symbol, e.dst_symbol, e.kind, e.weak ? 1 : 0, e.meta ?? null),
  );
}

// Multi-row INSERT chunk sizes, largest first. 64 rows × 9 columns stays far below SQLite's
// bound-parameter limit; each size is one cached statement per table.
const BATCH_SIZES = [64, 16, 4, 1];
const batchSql = new Map<string, Map<number, string>>();

/**
 * Insert `rows` with multi-row `VALUES` statements (A10-02): one statement step per chunk
 * instead of per row. Rows keep their order, so ids are assigned exactly as row-by-row inserts
 * would assign them. Callers wrap this in a transaction as before.
 */
function insertBatched<T>(
  db: DB,
  head: string,
  columns: number,
  rows: readonly T[],
  values: (row: T, out: unknown[]) => void,
): void {
  let sqls = batchSql.get(head);
  if (!sqls) batchSql.set(head, (sqls = new Map()));
  let i = 0;
  while (i < rows.length) {
    const n = BATCH_SIZES.find((size) => size <= rows.length - i)!;
    let sql = sqls.get(n);
    if (!sql) {
      const tuple = `(${new Array<string>(columns).fill('?').join(', ')})`;
      sqls.set(n, (sql = `${head} VALUES ${new Array<string>(n).fill(tuple).join(', ')}`));
    }
    const stmt = prepareCached(db, sql);
    const params: unknown[] = [];
    for (let k = i; k < i + n; k++) values(rows[k]!, params);
    stmt.run(params);
    i += n;
  }
}

export function getAllEdges(db: DB): EdgeRow[] {
  return db.prepare('SELECT * FROM edges ORDER BY id').all() as EdgeRow[];
}

export function clearEdges(db: DB): void {
  db.exec('DELETE FROM edges');
}

export interface InsertImportInput {
  file_id: number;
  module: string;
  imported: string | null;
  alias: string | null;
  start_line: number;
  reexport?: boolean;
}

export function insertImport(db: DB, input: InsertImportInput): number {
  const info = prepareCached(
    db,
    `INSERT INTO imports (file_id, module, imported, alias, start_line, reexport)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.file_id,
    input.module,
    input.imported,
    input.alias,
    input.start_line,
    input.reexport ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

/** Row-for-row the same as calling `insertImport` for each input, in order (A10-02). */
export function insertImports(db: DB, inputs: readonly InsertImportInput[]): void {
  insertBatched(
    db,
    'INSERT INTO imports (file_id, module, imported, alias, start_line, reexport)',
    6,
    inputs,
    (i, out) =>
      out.push(i.file_id, i.module, i.imported, i.alias, i.start_line, i.reexport ? 1 : 0),
  );
}

export function getImportsForFile(db: DB, fileId: number): ImportRow[] {
  return db
    .prepare('SELECT * FROM imports WHERE file_id = ? ORDER BY start_line')
    .all(fileId) as ImportRow[];
}

export function getAllImports(db: DB): ImportRow[] {
  return db.prepare('SELECT * FROM imports ORDER BY id').all() as ImportRow[];
}

export type InsertRefInput = Omit<RefRow, 'id' | 'file_id'>;

export function insertRefs(db: DB, fileId: number, refs: InsertRefInput[]): void {
  insertBatched(
    db,
    'INSERT INTO refs (file_id, src_qualified_name, name, receiver, object, kind, line)',
    7,
    refs,
    (r, out) =>
      out.push(fileId, r.src_qualified_name, r.name, r.receiver, r.object, r.kind, r.line),
  );
}

export function getAllRefs(db: DB): RefRow[] {
  return db.prepare('SELECT * FROM refs ORDER BY id').all() as RefRow[];
}

export function deleteRefsForFile(db: DB, fileId: number): void {
  prepareCached(db, 'DELETE FROM refs WHERE file_id = ?').run(fileId);
}

export interface UpsertDocInput {
  target_kind: string;
  target_id: number;
  content: string;
  source_hash: string;
}

// Reads, then writes: takes the write lock up front so another writer is waited out (SG80).
export function upsertDoc(db: DB, input: UpsertDocInput): number {
  const now = new Date().toISOString();
  return immediate(db, () => {
    const existing = db
      .prepare('SELECT id FROM docs WHERE target_kind = ? AND target_id = ?')
      .get(input.target_kind, input.target_id) as { id: number } | undefined;

    if (existing) {
      db.prepare('UPDATE docs SET content = ?, source_hash = ?, generated_at = ? WHERE id = ?').run(
        input.content,
        input.source_hash,
        now,
        existing.id,
      );
      return existing.id;
    }

    const info = db
      .prepare(
        `INSERT INTO docs (target_kind, target_id, content, source_hash, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.target_kind, input.target_id, input.content, input.source_hash, now);
    return Number(info.lastInsertRowid);
  });
}

export function getDoc(db: DB, targetKind: string, targetId: number): DocRow | undefined {
  return db
    .prepare('SELECT * FROM docs WHERE target_kind = ? AND target_id = ?')
    .get(targetKind, targetId) as DocRow | undefined;
}

// A pruned file's doc is kept as a tombstone row (target_id = the old file id,
// content = JSON {path, content}) so DB-mode drift can still report it until
// docs are regenerated.
const TOMBSTONE_KIND = 'deleted_file';

export function getAllDocs(db: DB): DocRow[] {
  return db
    .prepare(`SELECT * FROM docs WHERE target_kind != '${TOMBSTONE_KIND}' ORDER BY id`)
    .all() as DocRow[];
}

export interface DocTombstone {
  path: string;
  content: string;
  source_hash: string;
}

export function getDocTombstones(db: DB): DocTombstone[] {
  const rows = db
    .prepare(
      `SELECT content, source_hash FROM docs WHERE target_kind = '${TOMBSTONE_KIND}' ORDER BY id`,
    )
    .all() as Array<{ content: string; source_hash: string }>;
  return rows.map((r) => {
    const { path, content } = JSON.parse(r.content) as { path: string; content: string };
    return { path, content, source_hash: r.source_hash };
  });
}

export function clearDocTombstones(db: DB): void {
  db.prepare(`DELETE FROM docs WHERE target_kind = '${TOMBSTONE_KIND}'`).run();
}

export function startRun(db: DB, commitSha: string | null): number {
  const info = db
    .prepare('INSERT INTO runs (commit_sha, started_at) VALUES (?, ?)')
    .run(commitSha, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishRun(db: DB, runId: number, stats: Record<string, unknown>): void {
  db.prepare('UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?').run(
    new Date().toISOString(),
    JSON.stringify(stats),
    runId,
  );
}

/** `stats_json` of the most recent finished run, parsed; `{}` when none or unreadable. */
export function getLastRunStats(db: DB): Record<string, unknown> {
  const row = db
    .prepare(
      'SELECT stats_json FROM runs WHERE finished_at IS NOT NULL AND stats_json IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get() as { stats_json: string } | undefined;
  if (!row) return {};
  try {
    const v = JSON.parse(row.stats_json) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getLastRun(db: DB): RunRow | undefined {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as RunRow | undefined;
}

export function counts(db: DB): {
  files: number;
  symbols: number;
  edges: number;
  docs: number;
  imports: number;
} {
  const q = (sql: string) => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  return {
    files: q('SELECT COUNT(*) AS c FROM files'),
    symbols: q('SELECT COUNT(*) AS c FROM symbols'),
    edges: q('SELECT COUNT(*) AS c FROM edges'),
    docs: q(`SELECT COUNT(*) AS c FROM docs WHERE target_kind != '${TOMBSTONE_KIND}'`),
    imports: q('SELECT COUNT(*) AS c FROM imports'),
  };
}

// Removes a file and its file-level doc (leaving a tombstone); symbols, imports
// and edges cascade. vec0 embeddings do not cascade: call deleteEmbeddingsForFile first.
export function deleteFile(db: DB, fileId: number): void {
  immediate(db, () => {
    db.prepare(
      `UPDATE docs SET target_kind = '${TOMBSTONE_KIND}',
         content = json_object('path', (SELECT path FROM files WHERE id = ?), 'content', content)
       WHERE target_kind = 'file' AND target_id = ?`,
    ).run(fileId, fileId);
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  });
}
