import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  getAllFiles,
  openDatabase,
  upsertDoc,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { detectDrift } from '../../src/core/drift/index.js';

const API = `export function get(key: string): string { return key; }
export function set(v: number): number { return v; }
export function setValue(v: number): number { return v; }
function helper(): number { return 1; }
export class Store { load(): void {} }
export const $dollar = 1;
`;

const PY = `def public_fn():
    return 1


def _private_fn():
    return 2
`;

describe('undocumented symbols', () => {
  let dir: string;
  let root: string;
  let db: DB;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-undoc-'));
    root = join(dir, 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/api.ts'), API);
    writeFileSync(join(root, 'src/lib.py'), PY);
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function docFor(path: string, content: string): void {
    const file = getAllFiles(db).find((f) => f.path === path)!;
    upsertDoc(db, { target_kind: 'file', target_id: file.id, content, source_hash: 'x' });
  }

  it('counts only exported symbols and lists them all when a file has no doc', () => {
    const report = detectDrift(db, { root, skipArchitecture: true });
    const names = report.undocumented.map((u) => u.symbol).sort();
    expect(names).toEqual([
      '$dollar',
      'Store',
      'Store.load',
      'get',
      'public_fn',
      'set',
      'setValue',
    ]);
    expect(report.totals.publicSymbols).toBe(7);
  });

  it('matches names on identifier boundaries, not substrings', () => {
    docFor(
      'src/api.ts',
      'Reads the target via setValue. A Store can load(); $dollar is a constant.',
    );
    docFor('src/lib.py', 'See public_fn_v2 and public_fns.');
    const names = detectDrift(db, { root, skipArchitecture: true })
      .undocumented.map((u) => u.symbol)
      .sort();
    // `get` sits inside "target", `set` inside "setValue", `public_fn` inside longer identifiers.
    expect(names).toEqual(['get', 'public_fn', 'set']);
  });

  it('is case-sensitive and accepts qualified or bare member names', () => {
    docFor('src/api.ts', 'GET, Set and SETVALUE. `Store.load`, `$dollar`.');
    const names = detectDrift(db, { root, skipArchitecture: true })
      .undocumented.filter((u) => u.file === 'src/api.ts')
      .map((u) => u.symbol)
      .sort();
    expect(names).toEqual(['get', 'set', 'setValue']);
  });
});
