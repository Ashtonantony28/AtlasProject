import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  getAllEdges,
  getAllSymbols,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { buildGraphJson, buildGraphDot } from '../../src/core/graph/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

interface Edge {
  src_symbol: number | null;
  dst_symbol: number | null;
  kind: string;
}

function hasEdge(edges: Edge[], srcQName: string, dstQName: string, kind: string,
                 byId: Map<number, { qualified_name: string | null; name: string }>): boolean {
  for (const e of edges) {
    if (e.kind !== kind) continue;
    if (e.src_symbol === null || e.dst_symbol === null) continue;
    const s = byId.get(e.src_symbol);
    const d = byId.get(e.dst_symbol);
    const sName = s?.qualified_name ?? s?.name ?? '';
    const dName = d?.qualified_name ?? d?.name ?? '';
    if (sName === srcQName && dName === dstQName) return true;
  }
  return false;
}

describe('graph resolver on fixture', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-graph-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves imports, extends, implements, and calls', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const edges = getAllEdges(db);
    const byId = new Map(
      getAllSymbols(db).map((s) => [s.id, { qualified_name: s.qualified_name, name: s.name }]),
    );

    // Class hierarchy
    expect(hasEdge(edges, 'Circle', 'Shape', 'extends', byId)).toBe(true);
    expect(hasEdge(edges, 'Square', 'Shape', 'extends', byId)).toBe(true);
    expect(hasEdge(edges, 'Circle', 'Drawable', 'implements', byId)).toBe(true);
    expect(hasEdge(edges, 'Square', 'Drawable', 'implements', byId)).toBe(true);

    // Cross-file calls
    expect(hasEdge(edges, 'totalArea', 'add', 'calls', byId)).toBe(true);
    expect(hasEdge(edges, 'totalArea', 'Circle', 'calls', byId)).toBe(true);
    expect(hasEdge(edges, 'main', 'totalArea', 'calls', byId)).toBe(true);

    // Method-level calls inside a class
    expect(hasEdge(edges, 'Circle.area', 'multiply', 'calls', byId)).toBe(true);

    // Imports point at actual symbols when resolvable
    const importEdges = edges.filter((e) => e.kind === 'imports');
    expect(importEdges.length).toBeGreaterThanOrEqual(5);
    // None of the fixture imports should be weak
    const weak = importEdges.filter((e) => e.weak === 1);
    expect(weak.length).toBe(0);

    closeDatabase(db);
  });

  it('clears and rebuilds edges across runs (idempotent)', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const e1 = getAllEdges(db).length;
    await indexRepo(db, FIXTURE, { force: true });
    const e2 = getAllEdges(db).length;
    expect(e2).toBe(e1);
    closeDatabase(db);
  });

  it('exports JSON and DOT formats', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const json = buildGraphJson(db);
    expect(json.nodes.length).toBeGreaterThan(0);
    expect(json.edges.length).toBeGreaterThan(0);

    const dot = buildGraphDot(db);
    expect(dot).toMatch(/^digraph Atlas/);
    expect(dot).toMatch(/extends/);
    closeDatabase(db);
  });
});
