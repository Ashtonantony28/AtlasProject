import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  handleIndexTool,
  handleSearchTool,
  handleSymbolTool,
  handleGraphTool,
  handleDriftTool,
} from '../../src/mcp/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('MCP tool handlers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('handleIndexTool indexes the fixture and returns stats', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    const text = await handleIndexTool(db, FIXTURE, {});
    const stats = JSON.parse(text) as Record<string, unknown>;
    expect(typeof stats['filesIndexed']).toBe('number');
    expect((stats['filesIndexed'] as number)).toBeGreaterThan(0);
    closeDatabase(db);
  });

  it('handleSearchTool returns ranked hits for a semantic query', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = await handleSearchTool(db, { query: 'circle area calculation' });
    const hits = JSON.parse(text) as Array<{ name: string; file: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    const hasShapes = hits.some((h) => h.file === 'src/shapes.ts');
    expect(hasShapes).toBe(true);
    closeDatabase(db);
  });

  it('handleSearchTool returns empty array for empty query', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = await handleSearchTool(db, { query: '' });
    expect(JSON.parse(text)).toEqual([]);
    closeDatabase(db);
  });

  it('handleSymbolTool returns symbol details with source excerpt', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = await handleSymbolTool(db, FIXTURE, { name: 'Circle' });
    const symbols = JSON.parse(text) as Array<{
      name: string;
      kind: string;
      file: string | null;
      excerpt: string | null;
    }>;
    expect(symbols.length).toBeGreaterThan(0);
    const circle = symbols.find((s) => s.name === 'Circle');
    expect(circle).toBeDefined();
    expect(circle?.kind).toBe('class');
    expect(circle?.file).toBe('src/shapes.ts');
    expect(circle?.excerpt).toBeTruthy();
    closeDatabase(db);
  });

  it('handleSymbolTool does case-insensitive partial matching', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = await handleSymbolTool(db, FIXTURE, { name: 'add' });
    const symbols = JSON.parse(text) as Array<{ name: string }>;
    expect(symbols.some((s) => s.name === 'add')).toBe(true);
    closeDatabase(db);
  });

  it('handleGraphTool returns JSON with nodes and edges', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = handleGraphTool(db, {});
    const graph = JSON.parse(text) as { nodes: unknown[]; edges: unknown[] };
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(graph.edges)).toBe(true);
    closeDatabase(db);
  });

  it('handleGraphTool returns DOT format when requested', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = handleGraphTool(db, { format: 'dot' });
    expect(text).toMatch(/^digraph Atlas \{/);
    closeDatabase(db);
  });

  it('handleDriftTool reports undocumented symbols on a fresh index', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
    const text = handleDriftTool(db);
    const report = JSON.parse(text) as { hasDrift: boolean; undocumented: unknown[] };
    expect(report.hasDrift).toBe(true);
    expect(report.undocumented.length).toBeGreaterThan(0);
    closeDatabase(db);
  });
});
