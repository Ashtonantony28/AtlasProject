import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { synthesizeDocs, createOfflineClient } from '../../src/core/synth/index.js';
import { startServer } from '../../src/web/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

async function fetchJSON(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} at ${url}`);
  return r.json();
}

describe('dashboard HTTP API', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-serve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots, serves the index page, and answers /api/* queries', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    await synthesizeDocs(db, createOfflineClient(), { root: FIXTURE, tokenBudget: 200_000 });

    // Port 0 = OS-assigned ephemeral. We'll use 0; server will pick. But our
    // server takes a fixed port; instead, pick a high-numbered port for tests.
    const port = 41327 + Math.floor(Math.random() * 1000);
    const handle = await startServer(db, FIXTURE, { port });
    try {
      // Static index.html
      const root = await fetch(handle.url);
      expect(root.status).toBe(200);
      const html = await root.text();
      expect(html).toMatch(/<title>Atlas<\/title>/);

      // Health
      const health = (await fetchJSON(`${handle.url}api/health`)) as { ok: boolean };
      expect(health.ok).toBe(true);

      // Stats
      const stats = (await fetchJSON(`${handle.url}api/stats`)) as {
        files: number;
        symbols: number;
      };
      expect(stats.files).toBe(4);
      expect(stats.symbols).toBeGreaterThan(0);

      // Files
      const files = (await fetchJSON(`${handle.url}api/files`)) as Array<{ path: string }>;
      expect(files.some((f) => f.path === 'src/shapes.ts')).toBe(true);

      // Search
      const hits = (await fetchJSON(`${handle.url}api/search?q=circle+area&limit=3`)) as Array<{
        name: string;
      }>;
      expect(hits.length).toBeGreaterThan(0);
      const names = hits.map((h) => h.name);
      // Circle.area or area should be the top.
      expect(['Circle.area', 'area']).toContain(names[0]);

      // Graph
      const graph = (await fetchJSON(`${handle.url}api/graph`)) as {
        nodes: unknown[];
        edges: unknown[];
      };
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.length).toBeGreaterThan(0);

      // Architecture doc
      const arch = (await fetchJSON(`${handle.url}api/doc/architecture`)) as { content: string };
      expect(arch.content).toMatch(/architecture/i);
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });

  it('returns 404 for unknown doc ids', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const port = 41327 + Math.floor(Math.random() * 1000);
    const handle = await startServer(db, FIXTURE, { port });
    try {
      const r = await fetch(`${handle.url}api/doc/file/999999`);
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });
});
