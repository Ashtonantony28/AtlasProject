import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type EdgeRow,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'graph');

interface Expected {
  src: string;
  dst: string;
  kind: string;
}

const expected = JSON.parse(
  readFileSync(join(FIXTURE, 'expected-edges.json'), 'utf8'),
) as Expected[];
const keyOf = (e: Expected): string => `${e.src} -${e.kind}-> ${e.dst}`;

describe('resolver golden fixture (fixtures/graph)', () => {
  let dir: string;
  let edges: EdgeRow[];
  let label: Map<number, string>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-golden-'));
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE, { skipEmbeddings: true });
    const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
    label = new Map(
      getAllSymbols(db).map((s) => [
        s.id,
        `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`,
      ]),
    );
    edges = getAllEdges(db);
    closeDatabase(db);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const strong = (): Set<string> =>
    new Set(
      edges
        .filter((e) => e.weak === 0 && e.src_symbol !== null && e.dst_symbol !== null)
        .map((e) =>
          keyOf({ src: label.get(e.src_symbol!)!, dst: label.get(e.dst_symbol!)!, kind: e.kind }),
        ),
    );

  it('has every expected edge, resolved (no false negatives)', () => {
    const got = strong();
    expect(expected.map(keyOf).filter((k) => !got.has(k))).toEqual([]);
  });

  it('has no resolved edge outside the golden file (no false positives)', () => {
    const want = new Set(expected.map(keyOf));
    expect([...strong()].filter((k) => !want.has(k))).toEqual([]);
  });

  it('emits no edges from calls inside comments or strings', () => {
    const decoys = new Set([
      'web/decoys.ts::decoy',
      'web/decoys.ts::banner',
      'py/pkg/sub/service.py::decoy',
    ]);
    const fromDecoys = edges.filter(
      (e) =>
        e.src_symbol !== null &&
        (decoys.has(label.get(e.src_symbol)!) ||
          (label.get(e.src_symbol) === 'web/decoys.ts::<module>' && e.kind !== 'imports')),
    );
    expect(fromDecoys).toEqual([]);
  });

  it('does not extract locals of a top-level arrow function as symbols', () => {
    expect([...label.values()]).not.toContain('web/widget.ts::inner');
  });
});
