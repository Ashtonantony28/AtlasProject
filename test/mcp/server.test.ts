import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase } from '../../src/core/db/index.js';
import {
  createOfflineClient,
  exportDocs,
  synthesizeDocs,
  type LLMClient,
} from '../../src/core/synth/index.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleAskTool,
  handleDocsTool,
  handleDriftTool,
  handleGraphTool,
  handleIndexTool,
  handleSearchTool,
  handleSymbolTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { gitStatus, makeGitRepo, SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli/index.ts');

const TOOLS = [
  'atlas_ask',
  'atlas_docs',
  'atlas_drift',
  'atlas_graph',
  'atlas_index',
  'atlas_search',
  'atlas_symbol',
];

function fixedAnswer(text: string): LLMClient {
  return {
    model: 'fixed',
    complete: async () => ({ content: text, inputTokens: 1, outputTokens: 1 }),
  };
}

function textOf(res: unknown): string {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join('');
}

describe('MCP tool handlers', () => {
  let dir: string;
  let root: string;
  let ctx: McpContext;
  const open = (opts: { llm?: LLMClient } = {}): McpContext =>
    createMcpContext({ root, offline: true, ...opts });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-'));
    root = join(dir, 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    ctx = open();
  });
  afterEach(() => {
    if (ctx.db.open) closeDatabase(ctx.db);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function synthesize(): Promise<void> {
    await synthesizeDocs(ctx.db, createOfflineClient(), { root, tokenBudget: 200_000 });
    exportDocs(ctx.db, ctx.docsDir);
  }

  it('creates the index under .atlas/ only', () => {
    expect(ctx.root).toBe(root);
    expect(existsSync(join(root, '.atlas', 'index.db'))).toBe(true);
    expect(existsSync(join(root, 'atlas.config.json'))).toBe(false);
  });

  it('atlas_index indexes, then skips unchanged files', async () => {
    const first = await handleIndexTool(ctx, {});
    expect(first.filesIndexed).toBeGreaterThan(0);
    expect(first.symbols).toBeGreaterThan(0);
    const second = await handleIndexTool(ctx, {});
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(first.filesIndexed);
    const forced = await handleIndexTool(ctx, { force: true });
    expect(forced.filesIndexed).toBe(first.filesIndexed);
  });

  it('read tools fail with a clear error on an empty index', async () => {
    await expect(handleSearchTool(ctx, { query: 'circle' })).rejects.toThrow(/atlas_index/);
    await expect(handleAskTool(ctx, { question: 'what?' })).rejects.toThrow(/atlas_index/);
    expect(() => handleSymbolTool(ctx, { name: 'Circle' })).toThrow(/atlas_index/);
    expect(() => handleGraphTool(ctx, {})).toThrow(/atlas_index/);
    expect(() => handleDriftTool(ctx, {})).toThrow(/atlas_index/);
  });

  describe('on an indexed copy of fixtures/sample', () => {
    beforeEach(async () => {
      await handleIndexTool(ctx, {});
    });

    it('atlas_search ranks the shapes symbols for a semantic query', async () => {
      const hits = await handleSearchTool(ctx, { query: 'circle area calculation' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.file === 'src/shapes.ts')).toBe(true);
      for (const h of hits) expect(h.startLine).toBeLessThanOrEqual(h.endLine);
    });

    it('atlas_search applies kind, file and limit filters', async () => {
      const classes = await handleSearchTool(ctx, { query: 'shape', kind: ['class'] });
      expect(classes.length).toBeGreaterThan(0);
      for (const h of classes) expect(h.kind).toBe('class');
      const inMath = await handleSearchTool(ctx, { query: 'number', file: 'math' });
      expect(inMath.length).toBeGreaterThan(0);
      for (const h of inMath) expect(h.file).toBe('src/math.ts');
      expect(await handleSearchTool(ctx, { query: 'add', limit: 1 })).toHaveLength(1);
    });

    it('atlas_search rejects a blank query', async () => {
      await expect(handleSearchTool(ctx, { query: '   ' })).rejects.toThrow(/query/);
    });

    it('atlas_symbol returns exact matches first with an excerpt', () => {
      const [circle] = handleSymbolTool(ctx, { name: 'circle' });
      expect(circle).toMatchObject({ name: 'Circle', kind: 'class', file: 'src/shapes.ts' });
      expect(circle?.excerpt).toMatch(/class Circle/);
      expect(circle?.truncated).toBe(false);
    });

    it('atlas_symbol matches partial names and honours limit', () => {
      const adds = handleSymbolTool(ctx, { name: 'ad' });
      expect(adds.some((s) => s.name === 'add')).toBe(true);
      expect(handleSymbolTool(ctx, { name: 'a', limit: 2 })).toHaveLength(2);
      expect(handleSymbolTool(ctx, { name: 'definitelyNotASymbol' })).toEqual([]);
      expect(() => handleSymbolTool(ctx, { name: ' ' })).toThrow(/name/);
    });

    it('atlas_graph exports json and dot', () => {
      const graph = handleGraphTool(ctx, {}) as { nodes: unknown[]; edges: unknown[] };
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.length).toBeGreaterThan(0);
      expect(handleGraphTool(ctx, { format: 'dot' })).toMatch(/^digraph Atlas \{/);
    });

    it('atlas_drift errors when there are no docs to check, like `atlas drift`', () => {
      expect(() => handleDriftTool(ctx, {})).toThrow(/no docs found in the index/);
      expect(() => handleDriftTool(ctx, { persisted: true })).toThrow(/docs directory not found/);
    });

    it('atlas_drift reports undocumented exports as non-failing unless strict', async () => {
      await synthesize();
      ctx.db
        .prepare(
          "UPDATE docs SET content = '# math' WHERE target_kind = 'file' AND target_id = (SELECT id FROM files WHERE path = 'src/math.ts')",
        )
        .run();
      const report = handleDriftTool(ctx, {});
      expect(report.stale).toEqual([]);
      expect(report.undocumented.length).toBeGreaterThan(0);
      expect(report).toMatchObject({ hasDrift: true, failing: false, strict: false });
      expect(report.formatted).toMatch(/Undocumented/);
      expect(handleDriftTool(ctx, { strict: true })).toMatchObject({ failing: true, strict: true });
    });

    it('atlas_drift reports exactly the mutated file as stale', async () => {
      await synthesize();
      expect(handleDriftTool(ctx, {}).stale).toEqual([]);
      const p = join(root, 'src/math.ts');
      writeFileSync(p, readFileSync(p, 'utf8').replace('return a * b;', 'return b * a;'));
      await handleIndexTool(ctx, {});
      const report = handleDriftTool(ctx, {});
      expect(report.stale.map((s) => `${s.kind}:${s.targetPath}`)).toEqual(['file:src/math.ts']);
      expect(report.hasDrift).toBe(true);
      const persisted = handleDriftTool(ctx, { persisted: true });
      expect(persisted.stale.map((s) => s.targetPath)).toEqual(['src/math.ts']);
    });

    it('atlas_drift checks persisted docs from a fresh index', async () => {
      await synthesize();
      closeDatabase(ctx.db);
      rmSync(join(root, '.atlas', 'index.db'), { force: true });
      ctx = open();
      await handleIndexTool(ctx, {});
      expect(() => handleDriftTool(ctx, {})).toThrow(/no docs found/);
      const report = handleDriftTool(ctx, { persisted: true });
      expect(report.totals.docs).toBeGreaterThan(0);
      expect(report.stale).toEqual([]);
    });

    it('atlas_docs lists and reads docs, and errors on unknown targets', async () => {
      expect(handleDocsTool(ctx, {})).toEqual([]);
      expect(() => handleDocsTool(ctx, { target: 'src/math.ts' })).toThrow(/atlas docs/);
      await synthesize();
      const list = handleDocsTool(ctx, {}) as Array<{ target: string; source: string }>;
      expect(list.map((d) => d.target)).toContain('architecture');
      expect(list.map((d) => d.target)).toContain('src/math.ts');
      for (const d of list) expect(d.source).toBe('index');
      const doc = handleDocsTool(ctx, { target: 'src/math.ts' }) as { content: string };
      expect(doc.content).toMatch(/multiply/);
      expect(handleDocsTool(ctx, { target: 'architecture' })).toMatchObject({
        kind: 'architecture',
      });
      expect(() => handleDocsTool(ctx, { target: 'src/nope.ts' })).toThrow(/src\/nope\.ts/);
    });

    it('atlas_docs falls back to .atlas/docs when the index has none', async () => {
      await synthesize();
      ctx.db.prepare('DELETE FROM docs').run();
      const doc = handleDocsTool(ctx, { target: 'src/math.ts' }) as { source: string };
      expect(doc.source).toBe('persisted');
    });

    it('atlas_ask answers offline with verified citation checks', async () => {
      const res = await handleAskTool(ctx, { question: 'how is circle area computed?', k: 3 });
      expect(res.model).toBe('offline-mock-v1');
      expect(res.citations.length).toBeGreaterThan(0);
      expect(res.checks.length).toBeGreaterThan(0);
      for (const c of res.checks) expect(c.valid).toBe(true);
      expect(res.flagged).toEqual([]);
      expect(res.budgetRemaining).toBeLessThan(ctx.config.tokenBudget);
    });

    it('atlas_ask flags citations outside the retrieved snippets', async () => {
      closeDatabase(ctx.db);
      ctx = open({ llm: fixedAnswer('See [1], [9] and src/nope.ts:3.') });
      const res = await handleAskTool(ctx, { question: 'circle area', k: 3, expand: 2 });
      expect(res.checks.map((c) => c.raw)).toEqual(['[1]', '[9]', 'src/nope.ts:3']);
      expect(res.flagged.map((f) => [f.raw, f.reason])).toEqual([
        ['[9]', 'unknown-snippet'],
        ['src/nope.ts:3', 'unknown-file'],
      ]);
    });

    it('atlas_ask rejects blank questions', async () => {
      await expect(handleAskTool(ctx, { question: '  ' })).rejects.toThrow(/question/);
    });

    it('atlas_ask refuses calls beyond the token budget', async () => {
      closeDatabase(ctx.db);
      mkdirSync(join(root, '.atlas'), { recursive: true });
      writeFileSync(
        join(root, '.atlas', 'config.json'),
        JSON.stringify({ version: 1, tokenBudget: 500 }),
      );
      ctx = open();
      await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(
        /token budget exhausted/,
      );
      expect(ctx.budget.remaining()).toBe(500);
    });

    it('atlas_ask without a key or --offline fails without leaking anything', async () => {
      closeDatabase(ctx.db);
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      ctx = createMcpContext({ root });
      await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(
        /ANTHROPIC_API_KEY is not set/,
      );
    });
  });
});

describe('MCP server over an in-memory transport', () => {
  let dir: string;
  let ctx: McpContext;
  let client: Client;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-mem-'));
    cpSync(SAMPLE, dir, { recursive: true });
    ctx = createMcpContext({ root: dir, offline: true });
    const server = createAtlasMcpServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    closeDatabase(ctx.db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every tool with an input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const search = tools.find((t) => t.name === 'atlas_search');
    expect(search?.inputSchema.required).toEqual(['query']);
  });

  it('returns JSON text results', async () => {
    await client.callTool({ name: 'atlas_index', arguments: {} });
    const res = await client.callTool({ name: 'atlas_symbol', arguments: { name: 'Circle' } });
    expect(res.isError).toBeFalsy();
    const [first] = JSON.parse(textOf(res)) as Array<{ name: string }>;
    expect(first?.name).toBe('Circle');
  });

  it('turns bad input and handler failures into tool errors', async () => {
    const bad = [
      { name: 'atlas_search', arguments: { query: '' } },
      { name: 'atlas_search', arguments: { query: 'x', kind: ['bogus'] } },
      { name: 'atlas_search', arguments: { query: 'x', limit: 0 } },
      { name: 'atlas_ask', arguments: {} },
      { name: 'atlas_graph', arguments: { format: 'svg' } },
      { name: 'atlas_symbol', arguments: { name: 'Circle' } }, // index is empty
      { name: 'atlas_nope', arguments: {} },
    ];
    for (const call of bad) {
      const res = await client.callTool(call);
      expect(res.isError, JSON.stringify(call)).toBe(true);
      expect(textOf(res).length).toBeGreaterThan(0);
    }
    await client.callTool({ name: 'atlas_index', arguments: {} });
    const missing = await client.callTool({ name: 'atlas_docs', arguments: { target: 'x.ts' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/no doc for 'x\.ts'/);
    // The server keeps serving after errors.
    const ok = await client.callTool({ name: 'atlas_graph', arguments: { format: 'dot' } });
    expect(textOf(ok)).toMatch(/^digraph/);
  });
});

describe('atlas mcp over stdio', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeGitRepo('atlas-mcp-stdio-');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tools, indexes and answers, writing only under .atlas/', async () => {
    const transport = new StdioClientTransport({
      command: TSX,
      args: [CLI, 'mcp', '--offline', '--cwd', dir],
      env: { ...(process.env as Record<string, string>), ANTHROPIC_API_KEY: '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      const indexed = await client.callTool({ name: 'atlas_index', arguments: {} });
      expect(JSON.parse(textOf(indexed))).toMatchObject({ filesFailed: 0 });
      const res = await client.callTool({
        name: 'atlas_ask',
        arguments: { question: 'how do I add two numbers?', k: 3 },
      });
      expect(res.isError).toBeFalsy();
      const answer = JSON.parse(textOf(res)) as {
        checks: Array<{ valid: boolean }>;
        flagged: unknown[];
      };
      expect(answer.checks.length).toBeGreaterThan(0);
      expect(answer.flagged).toEqual([]);
    } finally {
      await client.close();
    }
    const status = gitStatus(dir);
    expect(status.length).toBeGreaterThan(0);
    for (const line of status) expect(line.slice(3)).toMatch(/^\.atlas\//);
  }, 60_000);
});
