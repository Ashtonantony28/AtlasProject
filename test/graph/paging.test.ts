// SG22: graph pages own the edges whose `src` they hold, so paging yields every
// edge in scope once; `truncated` is true whenever a response is not the whole
// scope (A7-02). An empty index is an error on the CLI and MCP alike (A7-05).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { buildGraphJson, type GraphJson, type GraphQuery } from '../../src/core/graph/index.js';
import { startServer, type ServeHandle } from '../../src/web/server.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleAskTool,
  handleDriftTool,
  handleGraphTool,
  handleSearchTool,
  handleSymbolTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-sg22-'));
  dirs.push(d);
  const root = join(d, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  return root;
}

async function cli(args: string[]): Promise<{ out: string; error?: string; code: number }> {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
  try {
    await runCli(args);
    return { out: out.join(''), code: typeof process.exitCode === 'number' ? process.exitCode : 0 };
  } catch (err) {
    return { out: out.join(''), error: (err as Error).message, code: 1 };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
}

const key = (e: GraphJson['edges'][number]) => JSON.stringify(e);

/** Every page of `q` at `limit` nodes per page, fetched with `get`. */
async function pages(
  get: (q: GraphQuery & { limit: number; offset: number }) => GraphJson | Promise<GraphJson>,
  limit: number,
  q: GraphQuery = {},
): Promise<GraphJson[]> {
  const out: GraphJson[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await get({ ...q, limit, offset });
    out.push(page);
    if (offset + page.nodes.length >= page.totals.nodes) return out;
  }
}

function expectComplete(all: GraphJson, paged: GraphJson[]): void {
  const edges = paged
    .flatMap((p) => p.edges)
    .map(key)
    .sort();
  expect(edges).toEqual(all.edges.map(key).sort());
  expect(paged.flatMap((p) => p.nodes)).toEqual(all.nodes);
  for (const p of paged) {
    expect(p.totals).toEqual(all.totals);
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const e of p.edges) expect(ids.has(e.src ?? e.dst!)).toBe(true);
  }
  expect(paged.map((p) => p.truncated)).toEqual(paged.map(() => paged.length > 1));
}

describe('graph paging keeps cross-page edges (A7-02)', () => {
  let root: string;
  let db: DB;
  let ctx: McpContext;
  let handle: ServeHandle;
  let all: GraphJson;

  beforeAll(async () => {
    root = sampleCopy();
    await cli(['index', root]);
    db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    ctx = createMcpContext({ root, offline: true });
    handle = await startServer(db, root, { port: 0 });
    all = buildGraphJson(db);
  });
  afterAll(async () => {
    await handle.close();
    closeDatabase(db);
    closeDatabase(ctx.db);
  });

  it('the sample has edges that cross every small page', () => {
    expect(all.totals.edges).toBeGreaterThan(10);
    expect(all.edges).toHaveLength(all.totals.edges);
    expect(all.truncated).toBe(false);
    const first = buildGraphJson(db, { limit: 8 });
    const ids = new Set(first.nodes.map((n) => n.id));
    expect(first.edges.some((e) => e.dst !== null && !ids.has(e.dst))).toBe(true);
  });

  it.each([1, 3, 8, 23, 24, 100])('core pages of %i nodes return every edge once', async (n) => {
    expectComplete(all, await pages((q) => buildGraphJson(db, q), n));
  });

  it('scoped pages return every edge in the scope once', async () => {
    for (const q of [{ file: 'src/' }, { file: 'shapes' }, { symbol: 'area', depth: 2 }]) {
      const scope = buildGraphJson(db, q);
      expect(scope.totals.edges, JSON.stringify(q)).toBe(scope.edges.length);
      for (const n of [1, 2, 5])
        expectComplete(scope, await pages((p) => buildGraphJson(db, p), n, q));
    }
  });

  it('edgeLimit cuts a page and says so; the last page is truncated too', () => {
    const page = buildGraphJson(db, { limit: 24, edgeLimit: 2 });
    expect(page.nodes).toHaveLength(24);
    expect(page.edges).toEqual(all.edges.slice(0, 2));
    expect(page.truncated).toBe(true);
    const last = buildGraphJson(db, { limit: 8, offset: 16 });
    expect(last.nodes).toEqual(all.nodes.slice(16));
    expect(last.truncated).toBe(true);
    const past = buildGraphJson(db, { limit: 8, offset: 100 });
    expect(past).toMatchObject({ nodes: [], edges: [], truncated: true });
  });

  it('CLI, MCP and /api/graph return the same pages', async () => {
    const viaCli = await pages(
      async (q) =>
        JSON.parse(
          (await cli(['graph', '--cwd', root, '--limit', `${q.limit}`, '--offset', `${q.offset}`]))
            .out,
        ) as GraphJson,
      8,
    );
    const viaMcp = await pages((q) => handleGraphTool(ctx, q) as GraphJson, 8);
    const viaHttp = await pages(
      async (q) =>
        (await (
          await fetch(`${handle.url}api/graph?limit=${q.limit}&offset=${q.offset}`)
        ).json()) as GraphJson,
      8,
    );
    const plain = JSON.parse(JSON.stringify(await pages((q) => buildGraphJson(db, q), 8)));
    expect(viaCli).toEqual(plain);
    expect(viaMcp).toEqual(viaCli);
    expect(viaHttp).toEqual(viaCli);
    expectComplete(all, viaCli as GraphJson[]);
    expect(viaCli.at(-1)!.truncated).toBe(true);
  });

  it('whole-graph `truncated` flips exactly at the node and edge totals on every surface (A8-03)', async () => {
    const N = all.totals.nodes;
    const E = all.totals.edges;
    const surfaces: Record<string, (limit: number, edgeLimit: number) => Promise<GraphJson>> = {
      core: async (limit, edgeLimit) => buildGraphJson(db, { limit, edgeLimit }),
      cli: async (limit, edgeLimit) =>
        JSON.parse(
          (
            await cli([
              'graph',
              '--cwd',
              root,
              '--limit',
              `${limit}`,
              '--edge-limit',
              `${edgeLimit}`,
            ])
          ).out,
        ) as GraphJson,
      mcp: async (limit, edgeLimit) => handleGraphTool(ctx, { limit, edgeLimit }) as GraphJson,
      http: async (limit, edgeLimit) =>
        (await (
          await fetch(`${handle.url}api/graph?limit=${limit}&edgeLimit=${edgeLimit}`)
        ).json()) as GraphJson,
    };
    for (const [name, get] of Object.entries(surfaces)) {
      const exact = await get(N, E);
      expect([name, exact.nodes.length, exact.edges.length, exact.truncated]).toEqual([
        name,
        N,
        E,
        false,
      ]);
      const oneEdgeShort = await get(N, E - 1);
      expect([name, oneEdgeShort.nodes.length, oneEdgeShort.edges.length]).toEqual([
        name,
        N,
        E - 1,
      ]);
      expect([name, oneEdgeShort.truncated]).toEqual([name, true]);
      const oneNodeShort = await get(N - 1, E);
      expect([name, oneNodeShort.nodes.length, oneNodeShort.truncated]).toEqual([
        name,
        N - 1,
        true,
      ]);
    }
    // The defaults (1000 nodes) cover the sample, so only edgeLimit decides.
    expect(handleGraphTool(ctx, { edgeLimit: E })).toMatchObject({ truncated: false });
    expect(handleGraphTool(ctx, { edgeLimit: E - 1 })).toMatchObject({ truncated: true });
    for (const [edgeLimit, truncated] of [
      [E, false],
      [E - 1, true],
    ] as const) {
      const viaHttp = (await (
        await fetch(`${handle.url}api/graph?edgeLimit=${edgeLimit}`)
      ).json()) as GraphJson;
      expect([edgeLimit, viaHttp.edges.length, viaHttp.truncated]).toEqual([
        edgeLimit,
        edgeLimit,
        truncated,
      ]);
      const viaCli = JSON.parse(
        (await cli(['graph', '--cwd', root, '--edge-limit', `${edgeLimit}`])).out,
      ) as GraphJson;
      expect([edgeLimit, viaCli.edges.length, viaCli.truncated]).toEqual([
        edgeLimit,
        edgeLimit,
        truncated,
      ]);
    }
  });

  it('the protocol and DOT output report truncation on the last page', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'sg22', version: '0.0.0' });
    await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
    try {
      const res = await client.callTool({
        name: 'atlas_graph',
        arguments: { limit: 8, offset: 16 },
      });
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toMatchObject({ truncated: true, totals: all.totals });
    } finally {
      await client.close();
    }
    expect(handleGraphTool(ctx, { limit: 8, offset: 16, format: 'dot' })).toMatch(
      /\/\/ truncated: 8 of 24 nodes/,
    );
    const dot = await cli([
      'graph',
      '--cwd',
      root,
      '--format',
      'dot',
      '--limit',
      '8',
      '--offset',
      '16',
    ]);
    expect(dot.out).toMatch(/\/\/ truncated: 8 of 24 nodes/);
  });

  it('a scoped page reads no more edge rows than the edges touching its page and scope (A6-01)', () => {
    let rows = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (!/\bFROM edges\b/.test(sql)) return stmt;
      const run = stmt.all.bind(stmt);
      stmt.all = ((...a: unknown[]) => {
        const out = run(...(a as []));
        rows += Array.isArray(out) ? out.length : 0;
        return out;
      }) as typeof stmt.all;
      return stmt;
    }) as typeof db.prepare;
    let page: GraphJson;
    try {
      page = buildGraphJson(db, { file: 'src/', limit: 2, offset: 2 });
    } finally {
      db.prepare = prepare;
    }
    const scope = buildGraphJson(db, { file: 'src/' }).nodes.map((n) => n.id);
    const touching = (ids: number[]) =>
      db
        .prepare(
          'SELECT COUNT(*) FROM edges WHERE src_symbol IN (SELECT value FROM json_each(?)) OR dst_symbol IN (SELECT value FROM json_each(?))',
        )
        .pluck()
        .get(JSON.stringify(ids), JSON.stringify(ids)) as number;
    expect(page.nodes).toHaveLength(2);
    expect(rows).toBeLessThanOrEqual(touching(page.nodes.map((n) => n.id)) + touching(scope));
  });
});

describe('an empty index is an error on the CLI and MCP alike (A7-05)', () => {
  let root: string;
  let ctx: McpContext;
  const CLI_EMPTY = 'index is empty: run `atlas index` first';
  const MCP_EMPTY = 'index is empty: call atlas_index first';

  beforeAll(async () => {
    root = sampleCopy();
    await cli(['init', '--cwd', root]);
    ctx = createMcpContext({ root, offline: true });
  });
  afterAll(() => closeDatabase(ctx.db));

  it.each([
    ['search', ['search', 'area']],
    ['graph', ['graph']],
    ['graph --format dot', ['graph', '--format', 'dot']],
    ['drift', ['drift']],
    ['drift --docs-dir', ['drift', '--docs-dir', '.atlas/docs', '--json']],
    ['ask', ['ask', '--offline', 'what is area']],
  ])('`%s` exits 1 with the empty-index message and prints nothing', async (_, args) => {
    const run = await cli([...args, '--cwd', root]);
    expect(run).toEqual({ out: '', error: CLI_EMPTY, code: 1 });
  });

  it('every MCP read tool fails with the same message shape', async () => {
    const calls: Array<() => unknown> = [
      () => handleSearchTool(ctx, { query: 'area' }),
      () => handleSymbolTool(ctx, { name: 'area' }),
      () => handleGraphTool(ctx, {}),
      () => handleDriftTool(ctx, {}),
      () => handleAskTool(ctx, { question: 'what is area' }),
    ];
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toThrow(MCP_EMPTY);
    }
    expect(CLI_EMPTY.split(':')[0]).toBe(MCP_EMPTY.split(':')[0]);
  });

  it('the CLI agrees with MCP once the index has files', async () => {
    await cli(['index', root]);
    expect((await cli(['graph', '--cwd', root, '--limit', '1'])).code).toBe(0);
    expect((await cli(['search', 'area', '--cwd', root])).code).toBe(0);
    expect(handleGraphTool(ctx, { limit: 1 })).toMatchObject({ truncated: true });
  });

  it('an index whose include filter matches nothing is empty too', async () => {
    const empty = sampleCopy();
    await cli(['init', '--cwd', empty]);
    const configPath = join(empty, '.atlas', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, include: ['nothing/**'] }));
    expect((await cli(['index', empty])).code).toBe(0);
    expect(await cli(['drift', '--cwd', empty])).toEqual({ out: '', error: CLI_EMPTY, code: 1 });
  });
});
