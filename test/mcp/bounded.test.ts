// SG15 (A2-04): MCP graph and drift responses stay bounded on an index larger
// than their default limits, and report totals and truncation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase } from '../../src/core/db/index.js';
import type { DriftReport } from '../../src/core/drift/index.js';
import type { GraphJson } from '../../src/core/graph/index.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleDriftTool,
  handleGraphTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { FILES, FNS, indexBigRepo } from '../helpers/bigRepo.js';

const SYMBOLS = FILES * (FNS + 1); // + one module symbol per file

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content.map((c) => c.text).join('');
}

describe('bounded MCP responses on an index larger than the limits', () => {
  let dir: string;
  let ctx: McpContext;
  let client: Client;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-bounded-'));
    await indexBigRepo(dir);
    ctx = createMcpContext({ root: dir, offline: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  }, 120_000);
  afterAll(async () => {
    await client.close();
    closeDatabase(ctx.db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('atlas_drift returns the first 100 entries of each list with full totals', () => {
    const report = handleDriftTool(ctx, { skipArchitecture: true });
    expect(report.stale).toHaveLength(100);
    expect(report.undocumented).toHaveLength(100);
    expect(report.totals).toMatchObject({ stale: FILES, undocumented: FILES * FNS });
    expect(report).toMatchObject({ truncated: true, hasDrift: true, failing: true });
    expect(report).not.toHaveProperty('formatted');
  });

  it('atlas_drift pages with offset/limit and formats on request', () => {
    const all = handleDriftTool(ctx, { skipArchitecture: true, limit: 1000 });
    expect(all.stale).toHaveLength(FILES);
    expect(all.undocumented).toHaveLength(1000);
    const page = handleDriftTool(ctx, { skipArchitecture: true, offset: 110, limit: 5 });
    expect(page.stale).toEqual(all.stale.slice(110, 115));
    expect(page.undocumented).toEqual(all.undocumented.slice(110, 115));
    expect(page.truncated).toBe(true);
    const text = handleDriftTool(ctx, { skipArchitecture: true, limit: 2, formatted: true });
    expect(text.formatted).toMatch(/showing 2 of 120 stale, 2 of 1200 undocumented/);
    expect(text.formatted).toMatch(/summary: 120 stale, 1200 undocumented/);
    expect(() => handleDriftTool(ctx, { limit: 0 })).toThrow(/limit/);
    expect(() => handleDriftTool(ctx, { limit: 1001 })).toThrow(/limit/);
    expect(() => handleDriftTool(ctx, { offset: -1 })).toThrow(/offset/);
  });

  it('atlas_graph returns at most 1000 nodes and 2000 edges with totals', () => {
    const graph = handleGraphTool(ctx, {}) as GraphJson;
    expect(graph.nodes).toHaveLength(1000);
    expect(graph.edges.length).toBeLessThanOrEqual(2000);
    expect(graph.totals.nodes).toBe(SYMBOLS);
    expect(graph.totals.edges).toBeGreaterThan(graph.edges.length);
    expect(graph.truncated).toBe(true);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) expect(ids.has(e.src!)).toBe(true);
    const rest = handleGraphTool(ctx, { offset: 1000 }) as GraphJson;
    expect(rest.nodes).toHaveLength(SYMBOLS - 1000);
    expect(rest.truncated).toBe(true);
    expect(rest.nodes[0]!.id).toBeGreaterThan(graph.nodes.at(-1)!.id);
    const capped = handleGraphTool(ctx, { limit: 50, edgeLimit: 3 }) as GraphJson;
    expect(capped.nodes).toHaveLength(50);
    expect(capped.edges).toHaveLength(3);
    expect(handleGraphTool(ctx, { limit: 5, format: 'dot' })).toMatch(/\/\/ truncated: 5 of/);
    expect(() => handleGraphTool(ctx, { limit: 5001 })).toThrow(/limit/);
    expect(() => handleGraphTool(ctx, { edgeLimit: 0 })).toThrow(/edgeLimit/);
  });

  it('atlas_graph scopes by file and by symbol neighbourhood', () => {
    const file = handleGraphTool(ctx, { file: 'src/m7.ts' }) as GraphJson;
    expect(file.nodes).toHaveLength(FNS + 1);
    for (const n of file.nodes) expect(n.file).toBe('src/m7.ts');
    expect(file.truncated).toBe(false);
    expect(file.totals).toEqual({ nodes: FNS + 1, edges: file.edges.length });
    expect(file.edges.some((e) => e.kind === 'calls')).toBe(true);

    const names = (g: GraphJson) => g.nodes.map((n) => n.name).sort();
    const near = handleGraphTool(ctx, { symbol: 'f5_3' }) as GraphJson;
    expect(names(near)).toEqual(expect.arrayContaining(['f5_2', 'f5_3', 'f5_4']));
    expect(names(near)).not.toContain('f5_6');
    const far = handleGraphTool(ctx, { symbol: 'f5_3', depth: 3 }) as GraphJson;
    expect(names(far)).toEqual(expect.arrayContaining(['f5_0', 'f5_6']));
    for (const n of far.nodes) expect(n.file).toBe('src/m5.ts');
    expect(handleGraphTool(ctx, { symbol: 'nope' })).toMatchObject({
      nodes: [],
      edges: [],
      totals: { nodes: 0, edges: 0 },
      truncated: false,
    });
  });

  it('default tool results over the protocol are compact and small', async () => {
    for (const [name, args] of [
      ['atlas_drift', { skipArchitecture: true }],
      ['atlas_graph', {}],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
      const text = textOf(res);
      expect(text).not.toMatch(/\n {2}"/);
      expect(text.length, name).toBeLessThan(512 * 1024);
      expect((JSON.parse(text) as DriftReport | GraphJson).truncated).toBe(true);
    }
    const bad = await client.callTool({ name: 'atlas_graph', arguments: { limit: 0 } });
    expect(bad.isError).toBe(true);
  });
});
