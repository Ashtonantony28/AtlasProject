// MCP server: exposes the index (index, search, symbol, graph, drift, docs, ask)
// as tools over stdio. Additive to the CLI; writes only inside `.atlas/`.

import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  closeDatabase,
  counts,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
  type SymbolKind,
} from '../core/db/index.js';
import { indexRepo } from '../core/ingest/index.js';
import { buildGraphDot, buildGraphJson } from '../core/graph/index.js';
import { createEmbedder, readFileFromRoot, search } from '../core/vector/index.js';
import { detectDrift, formatDriftReport } from '../core/drift/index.js';
import {
  createAnthropicClient,
  createOfflineClient,
  docsFromDb,
  readPersistedDocs,
  TokenBudget,
  type LLMClient,
  type PersistedDoc,
} from '../core/synth/index.js';
import { ask, DEFAULT_EXCERPT_LINES } from '../core/qa/index.js';
import { loadConfig, resolvePaths, type AtlasConfig } from '../core/config.js';

const KINDS = ['function', 'method', 'class', 'interface', 'type', 'variable', 'module'] as const;

export interface McpContext {
  db: DB;
  root: string;
  config: AtlasConfig;
  docsDir: string;
  budget: TokenBudget;
  llm: () => Promise<LLMClient>;
}

export interface McpContextOptions {
  root: string;
  // Use the offline mock LLM for `atlas_ask` (no API key, no spend).
  offline?: boolean;
  // Inject an LLM client (tests); takes precedence over `offline`.
  llm?: LLMClient;
}

export function createMcpContext(opts: McpContextOptions): McpContext {
  const root = resolve(opts.root);
  const config = loadConfig(root);
  const paths = resolvePaths(root, config);
  const db = openDatabase(paths.dbPath);
  const budget = new TokenBudget(config.tokenBudget);
  let client: Promise<LLMClient> | undefined;
  const make = (): Promise<LLMClient> =>
    opts.llm
      ? Promise.resolve(opts.llm)
      : opts.offline
        ? Promise.resolve(createOfflineClient())
        : createAnthropicClient(config.synthModel);
  return {
    db,
    root,
    config,
    docsDir: join(paths.atlasDir, 'docs'),
    budget,
    llm: () => {
      client ??= make().then((c) => budgeted(c, budget));
      client.catch(() => (client = undefined));
      return client;
    },
  };
}

/** Refuses any call whose input (~3 chars/token) + max output would exceed the budget. */
export function budgeted(inner: LLMClient, budget: TokenBudget): LLMClient {
  return {
    model: inner.model,
    async complete(params) {
      const chars =
        (params.system?.length ?? 0) + params.messages.reduce((n, m) => n + m.content.length, 0);
      const reserve = Math.ceil(chars / 3) + params.maxTokens;
      if (reserve > budget.remaining()) {
        throw new Error(
          `token budget exhausted: call needs ~${reserve} tokens, ${budget.remaining()} of ${budget.cap} left`,
        );
      }
      const res = await inner.complete(params);
      budget.record(res.inputTokens, res.outputTokens);
      return res;
    },
  };
}

function requireIndex(ctx: McpContext): void {
  if (counts(ctx.db).files === 0) throw new Error('index is empty: call atlas_index first');
}

export async function handleIndexTool(ctx: McpContext, args: { force?: boolean }) {
  return indexRepo(ctx.db, ctx.root, {
    force: args.force ?? false,
    exclude: ctx.config.exclude,
    include: ctx.config.include,
    languages: ctx.config.languages,
  });
}

export async function handleSearchTool(
  ctx: McpContext,
  args: { query: string; kind?: SymbolKind[]; file?: string; limit?: number },
) {
  const query = args.query.trim();
  if (!query) throw new Error('query must not be empty');
  requireIndex(ctx);
  const hits = await search(ctx.db, createEmbedder(ctx.config), query, {
    ...(args.kind?.length ? { kind: args.kind } : {}),
    ...(args.file ? { file: args.file } : {}),
    limit: args.limit ?? 10,
  });
  return hits.map((h) => ({
    name: h.symbol.qualified_name ?? h.symbol.name,
    kind: h.symbol.kind,
    file: h.filePath,
    startLine: h.symbol.start_line,
    endLine: h.symbol.end_line,
    signature: h.symbol.signature,
    docstring: h.symbol.docstring,
    score: Math.round(h.totalScore * 1000) / 1000,
  }));
}

export function handleSymbolTool(ctx: McpContext, args: { name: string; limit?: number }) {
  const needle = args.name.trim().toLowerCase();
  if (!needle) throw new Error('name must not be empty');
  requireIndex(ctx);
  const rank = (name: string, qualified: string): number =>
    name === needle || qualified === needle
      ? 0
      : name.startsWith(needle) || qualified.endsWith(`.${needle}`)
        ? 1
        : name.includes(needle) || qualified.includes(needle)
          ? 2
          : -1;
  const files = new Map(getAllFiles(ctx.db).map((f) => [f.id, f]));
  const matches = getAllSymbols(ctx.db)
    .map((s) => ({ s, r: rank(s.name.toLowerCase(), (s.qualified_name ?? '').toLowerCase()) }))
    .filter((m) => m.r >= 0)
    .sort((a, b) => a.r - b.r || a.s.id - b.s.id)
    .slice(0, args.limit ?? 20);
  const sources = new Map<number, string[] | null>();
  return matches.map(({ s }) => {
    if (!sources.has(s.file_id)) {
      sources.set(s.file_id, readFileFromRoot(ctx.root, ctx.db, s.file_id)?.split('\n') ?? null);
    }
    const lines = sources.get(s.file_id);
    const end = Math.min(s.end_line, s.start_line + DEFAULT_EXCERPT_LINES - 1);
    return {
      id: s.id,
      name: s.name,
      qualifiedName: s.qualified_name,
      kind: s.kind,
      exported: s.exported === 1,
      file: files.get(s.file_id)?.path ?? null,
      startLine: s.start_line,
      endLine: s.end_line,
      signature: s.signature,
      docstring: s.docstring,
      excerpt: lines ? lines.slice(s.start_line - 1, end).join('\n') : null,
      truncated: end < s.end_line,
    };
  });
}

export function handleGraphTool(ctx: McpContext, args: { format?: 'json' | 'dot' }) {
  requireIndex(ctx);
  return args.format === 'dot' ? buildGraphDot(ctx.db) : buildGraphJson(ctx.db);
}

export function handleDriftTool(
  ctx: McpContext,
  args: { persisted?: boolean; skipArchitecture?: boolean },
) {
  requireIndex(ctx);
  const report = detectDrift(ctx.db, {
    root: ctx.root,
    skipArchitecture: args.skipArchitecture ?? false,
    ...(args.persisted ? { docs: readPersistedDocs(ctx.docsDir) } : {}),
  });
  return { ...report, formatted: formatDriftReport(report) };
}

/** Docs from the index, with `.atlas/docs` filling targets the index lacks. */
function allDocs(ctx: McpContext): Array<PersistedDoc & { source: 'index' | 'persisted' }> {
  const out = new Map<string, PersistedDoc & { source: 'index' | 'persisted' }>();
  for (const d of readPersistedDocs(ctx.docsDir)) out.set(d.target, { ...d, source: 'persisted' });
  for (const d of docsFromDb(ctx.db)) out.set(d.target, { ...d, source: 'index' });
  return [...out.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

export function handleDocsTool(ctx: McpContext, args: { target?: string }) {
  const docs = allDocs(ctx);
  if (!args.target) {
    return docs.map((d) => ({
      kind: d.kind,
      target: d.target,
      source: d.source,
      sourceHash: d.sourceHash,
      chars: d.content.length,
    }));
  }
  const doc = docs.find((d) => d.target === args.target);
  if (!doc) {
    throw new Error(`no doc for '${args.target}': run \`atlas docs\` to generate docs`);
  }
  return doc;
}

export async function handleAskTool(
  ctx: McpContext,
  args: { question: string; k?: number; expand?: number },
) {
  const question = args.question.trim();
  if (!question) throw new Error('question must not be empty');
  requireIndex(ctx);
  const llm = await ctx.llm();
  const result = await ask(ctx.db, llm, ctx.root, question, {
    seedLimit: args.k ?? 5,
    expansionLimit: args.expand ?? 5,
  });
  return {
    question,
    answer: result.answer,
    citations: result.citations,
    checks: result.checks,
    flagged: result.flagged,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: llm.model,
    budgetRemaining: ctx.budget.remaining(),
  };
}

function asText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function createAtlasMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'atlas', version: '0.1.0' });

  server.registerTool(
    'atlas_index',
    {
      description:
        'Index the project: walk files, extract symbols, build the graph and embeddings. Unchanged files are skipped. Run before other tools.',
      inputSchema: { force: z.boolean().optional().describe('Re-parse unchanged files too.') },
    },
    async (args) => asText(await handleIndexTool(ctx, args)),
  );

  server.registerTool(
    'atlas_search',
    {
      description:
        'Hybrid semantic + lexical symbol search. Returns ranked symbols with locations.',
      inputSchema: {
        query: z.string().min(1).describe('Natural-language or identifier query.'),
        kind: z.array(z.enum(KINDS)).optional().describe('Only these symbol kinds.'),
        file: z.string().optional().describe('Only files whose path contains this substring.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max hits (default 10).'),
      },
    },
    async (args) => asText(await handleSearchTool(ctx, args)),
  );

  server.registerTool(
    'atlas_symbol',
    {
      description:
        'Look up symbols by name (case-insensitive; exact, then prefix, then substring). Returns location, signature, docstring and source excerpt.',
      inputSchema: {
        name: z.string().min(1).describe('Symbol name or qualified name.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max matches (default 20).'),
      },
    },
    async (args) => asText(handleSymbolTool(ctx, args)),
  );

  server.registerTool(
    'atlas_graph',
    {
      description: 'Export the symbol graph (nodes + calls/imports/extends/implements edges).',
      inputSchema: {
        format: z.enum(['json', 'dot']).optional().describe('json (default) or Graphviz dot.'),
      },
    },
    async (args) => asText(handleGraphTool(ctx, args)),
  );

  server.registerTool(
    'atlas_drift',
    {
      description:
        'Report stale docs (grounding context changed since generation) and undocumented exported symbols.',
      inputSchema: {
        persisted: z
          .boolean()
          .optional()
          .describe('Check the docs persisted in .atlas/docs instead of the index.'),
        skipArchitecture: z.boolean().optional().describe('Skip the architecture doc.'),
      },
    },
    async (args) => asText(handleDriftTool(ctx, args)),
  );

  server.registerTool(
    'atlas_docs',
    {
      description:
        'Read generated docs. Without a target, lists them; with a file path or "architecture", returns that doc. Generate docs with `atlas docs`.',
      inputSchema: {
        target: z.string().min(1).optional().describe('File path or "architecture".'),
      },
    },
    async (args) => asText(handleDocsTool(ctx, args)),
  );

  server.registerTool(
    'atlas_ask',
    {
      description:
        'Answer a question grounded in retrieved snippets, with citations and checks flagging citations outside them. Spends LLM tokens within the configured budget.',
      inputSchema: {
        question: z.string().min(1).describe('The question.'),
        k: z.number().int().min(1).max(20).optional().describe('Seed snippets (default 5).'),
        expand: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe('Graph-expanded snippets (default 5).'),
      },
    },
    async (args) => asText(await handleAskTool(ctx, args)),
  );

  return server;
}

/**
 * Serve over stdio. Stdout carries only protocol messages. When stdin ends the
 * process exits once in-flight calls finish; the DB is closed on exit.
 */
export async function startMcpServer(opts: McpContextOptions): Promise<void> {
  const ctx = createMcpContext(opts);
  process.once('exit', () => closeDatabase(ctx.db));
  await createAtlasMcpServer(ctx).connect(new StdioServerTransport());
}
