// SG27 (A10-02): symbols, imports, refs and edges go in with multi-row INSERTs. They must give
// exactly the rows (and ids) that one INSERT per row gave, at every chunk boundary.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  openDatabase,
  upsertFile,
  insertSymbol,
  insertSymbols,
  insertImport,
  insertImports,
  insertRefs,
  insertEdges,
  getAllSymbols,
  getAllImports,
  getAllRefs,
  getAllEdges,
  type DB,
  type InsertSymbolInput,
  type InsertImportInput,
  type InsertRefInput,
} from '../../src/core/db/index.js';

describe('batched inserts (SG27)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-batch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const symbols = (fileId: number, n: number): InsertSymbolInput[] =>
    Array.from({ length: n }, (_, i) => ({
      file_id: fileId,
      kind: i % 2 ? 'function' : 'class',
      name: `s${i}`,
      signature: i % 3 ? `s${i}()` : null,
      start_line: i + 1,
      end_line: i + 2,
      docstring: i % 5 ? null : `doc ${i}`,
      qualified_name: `q.s${i}`,
      exported: i % 2 === 0,
    }));
  const imports = (fileId: number, n: number): InsertImportInput[] =>
    Array.from({ length: n }, (_, i) => ({
      file_id: fileId,
      module: `./m${i}`,
      imported: i % 2 ? `x${i}` : null,
      alias: i % 3 ? null : `a${i}`,
      start_line: i,
      reexport: i % 4 === 0,
    }));

  const open = (name: string): { db: DB; fid: number } => {
    const db = openDatabase(join(dir, name));
    const fid = upsertFile(db, { path: 'a.ts', language: 'typescript', content_hash: 'h', loc: 1 });
    return { db, fid };
  };

  for (const n of [0, 1, 3, 4, 63, 64, 65, 85, 150]) {
    it(`gives the same rows as row-by-row inserts for ${n} rows`, () => {
      const one = open(`one${n}.db`);
      const many = open(`many${n}.db`);
      one.db.transaction(() => {
        for (const s of symbols(one.fid, n)) insertSymbol(one.db, s);
        for (const i of imports(one.fid, n)) insertImport(one.db, i);
      })();
      many.db.transaction(() => {
        insertSymbols(many.db, symbols(many.fid, n));
        insertImports(many.db, imports(many.fid, n));
      })();
      expect(getAllSymbols(many.db)).toEqual(getAllSymbols(one.db));
      expect(getAllImports(many.db)).toEqual(getAllImports(one.db));
      const fts = (db: DB): unknown[] =>
        db.prepare('SELECT rowid, * FROM symbols_fts ORDER BY rowid').all();
      expect(fts(many.db)).toEqual(fts(one.db));

      const refs: InsertRefInput[] = Array.from({ length: n }, (_, i) => ({
        src_qualified_name: i % 2 ? `q.s${i}` : null,
        name: `n${i}`,
        receiver: i % 3 ? 'none' : 'this',
        object: i % 3 ? null : 'this',
        kind: i % 2 ? 'calls' : 'references',
        line: i,
      }));
      insertRefs(many.db, many.fid, refs);
      const rows = getAllRefs(many.db);
      expect(rows.map((r) => r.id)).toEqual(refs.map((_, i) => i + 1));
      expect(rows.map(({ id: _id, file_id: _f, ...r }) => r)).toEqual(refs);

      const ids = getAllSymbols(many.db).map((s) => s.id);
      const edges = ids.map((id, i) => ({
        src_symbol: id,
        dst_symbol: i % 4 ? ids[(i + 1) % ids.length]! : null,
        kind: 'calls' as const,
        weak: i % 4 === 0,
        meta: i % 2 ? `{"line":${i}}` : null,
      }));
      insertEdges(many.db, edges);
      expect(
        getAllEdges(many.db).map((e) => [e.src_symbol, e.dst_symbol, e.kind, e.weak, e.meta]),
      ).toEqual(edges.map((e) => [e.src_symbol, e.dst_symbol, e.kind, e.weak ? 1 : 0, e.meta]));
      closeDatabase(one.db);
      closeDatabase(many.db);
    });
  }
});
