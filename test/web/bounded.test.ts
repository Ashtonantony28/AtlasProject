// SG15 (A2-09): /api/graph is bounded like atlas_graph, and /api/stats counts
// without materialising tables.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { buildGraphJson, type GraphJson } from '../../src/core/graph/index.js';
import { listDocs } from '../../src/core/synth/index.js';
import { startServer, type ServeHandle } from '../../src/web/server.js';
import { FILES, FNS, indexBigRepo } from '../helpers/bigRepo.js';

describe('bounded dashboard API on an index larger than the limits', () => {
  let dir: string;
  let db: DB;
  let handle: ServeHandle;
  const get = async (path: string) => fetch(`${handle.url}${path}`);
  const graphAt = async (qs: string) => (await (await get(`api/graph${qs}`)).json()) as GraphJson;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-web-bounded-'));
    await indexBigRepo(dir);
    db = openDatabase(join(dir, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    handle = await startServer(db, dir, { port: 0 });
  }, 120_000);
  afterAll(async () => {
    await handle.close();
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('/api/stats matches the index counts and the docs list', async () => {
    const stats = await (await get('api/stats')).json();
    const c = counts(db);
    expect(stats).toEqual({
      files: FILES,
      symbols: c.symbols,
      edges: c.edges,
      docs: listDocs(db, join(dir, '.atlas', 'docs')).length,
    });
    expect(stats.symbols).toBe(FILES * (FNS + 1));
    expect(stats.docs).toBe(FILES + 1);
  });

  it('/api/stats counts persisted docs the index lacks', async () => {
    const rw = openDatabase(join(dir, '.atlas', 'index.db'));
    const saved = rw.prepare('SELECT * FROM docs').all();
    try {
      rw.prepare("DELETE FROM docs WHERE target_kind = 'architecture' OR target_id % 2 = 0").run();
      const stats = await (await get('api/stats')).json();
      expect(stats.docs).toBe(listDocs(db, join(dir, '.atlas', 'docs')).length);
      expect(stats.docs).toBe(FILES + 1);
    } finally {
      rw.prepare('DELETE FROM docs').run();
      const ins = rw.prepare(
        'INSERT INTO docs (id, target_kind, target_id, content, source_hash, generated_at) VALUES (@id, @target_kind, @target_id, @content, @source_hash, @generated_at)',
      );
      for (const row of saved) ins.run(row);
      closeDatabase(rw);
    }
  });

  it('/api/graph defaults to 1000 nodes with totals, and agrees with atlas_graph params', async () => {
    const graph = await graphAt('');
    expect(graph.nodes).toHaveLength(1000);
    expect(graph.edges.length).toBeLessThanOrEqual(2000);
    expect(graph.totals).toEqual({ nodes: FILES * (FNS + 1), edges: counts(db).edges });
    expect(graph.truncated).toBe(true);
    expect(graph).toEqual(
      JSON.parse(JSON.stringify(buildGraphJson(db, { limit: 1000, edgeLimit: 2000 }))),
    );
    const scoped = await graphAt('?file=src/m3.ts&limit=4&offset=2');
    expect(scoped.nodes).toHaveLength(4);
    expect(scoped.totals.nodes).toBe(FNS + 1);
    const near = await graphAt('?symbol=f9_5&depth=2');
    expect(near.nodes.map((n) => n.name).sort()).toEqual(['f9_3', 'f9_4', 'f9_5', 'f9_6', 'f9_7']);
  });

  it('/api/graph rejects bad params with 400', async () => {
    for (const qs of ['limit=0', 'limit=5001', 'edgeLimit=x', 'depth=4', 'offset=-1', 'symbol=']) {
      const r = await get(`api/graph?${qs}`);
      expect(r.status, qs).toBe(400);
    }
  });
});
