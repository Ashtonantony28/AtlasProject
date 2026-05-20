import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  openDatabase,
  upsertFile,
  insertSymbol,
  insertEdge,
  getAllSymbols,
  getAllEdges,
  counts,
  upsertDoc,
  getDoc,
} from '../../src/core/db/index.js';

describe('repo helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-repo-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts files by path', () => {
    const db = openDatabase(join(dir, 'a.db'));
    const id1 = upsertFile(db, { path: 'a.ts', language: 'typescript', content_hash: 'h1', loc: 1 });
    const id2 = upsertFile(db, { path: 'a.ts', language: 'typescript', content_hash: 'h2', loc: 2 });
    expect(id1).toBe(id2);
    expect(counts(db).files).toBe(1);
    closeDatabase(db);
  });

  it('inserts symbols and edges, queries them back', () => {
    const db = openDatabase(join(dir, 'a.db'));
    const fid = upsertFile(db, { path: 'a.ts', language: 'typescript', content_hash: 'h', loc: 1 });
    const sid1 = insertSymbol(db, {
      file_id: fid,
      kind: 'function',
      name: 'foo',
      signature: 'foo(): void',
      start_line: 1,
      end_line: 3,
      docstring: 'does foo',
      qualified_name: 'a.foo',
    });
    const sid2 = insertSymbol(db, {
      file_id: fid,
      kind: 'function',
      name: 'bar',
      signature: 'bar(): number',
      start_line: 5,
      end_line: 7,
      docstring: null,
      qualified_name: 'a.bar',
    });
    insertEdge(db, { src_symbol: sid1, dst_symbol: sid2, kind: 'calls', weak: false });

    expect(getAllSymbols(db)).toHaveLength(2);
    expect(getAllEdges(db)).toHaveLength(1);
    closeDatabase(db);
  });

  it('upserts docs', () => {
    const db = openDatabase(join(dir, 'a.db'));
    const fid = upsertFile(db, { path: 'a.ts', language: 'typescript', content_hash: 'h', loc: 1 });
    const sid = insertSymbol(db, {
      file_id: fid,
      kind: 'function',
      name: 'foo',
      signature: null,
      start_line: 1,
      end_line: 1,
      docstring: null,
      qualified_name: null,
    });
    upsertDoc(db, { target_kind: 'symbol', target_id: sid, content: 'v1', source_hash: 'h1' });
    upsertDoc(db, { target_kind: 'symbol', target_id: sid, content: 'v2', source_hash: 'h2' });
    const d = getDoc(db, 'symbol', sid);
    expect(d?.content).toBe('v2');
    expect(d?.source_hash).toBe('h2');
    closeDatabase(db);
  });
});
