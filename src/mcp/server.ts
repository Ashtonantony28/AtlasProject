// MCP server: exposes the index (index, search, symbol, graph, drift, docs, ask)
// as tools over stdio. Additive to the CLI; writes only inside `.atlas/`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  closeDatabase,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../core/db/index.js';
import { closeOnSignal, nameCorrupt } from '../core/db/database.js';
import { indexRepo } from '../core/ingest/index.js';
import { buildGraphDot, buildGraphJson } from '../core/graph/index.js';
import { createEmbedder, readIndexedSource, search } from '../core/vector/index.js';
import {
  formatDriftReport,
  pageDriftReport,
  runDrift,
  type DriftReport,
} from '../core/drift/index.js';
import {
  affordableMaxTokens,
  BudgetExhaustedError,
  budgeted,
  createAnthropicClient,
  createOfflineClient,
  estimateInputTokens,
  findDoc,
  listDocs,
  TokenBudget,
  type LLMClient,
} from '../core/synth/index.js';
import { ask, DEFAULT_EXCERPT_LINES } from '../core/qa/index.js';
import { loadConfig, resolvePaths, writeDefaultConfig, type AtlasConfig } from '../core/config.js';
import { loadProject, requireIndexed } from '../core/project.js';
import {
  askParams,
  AskParamsSchema,
  driftParams,
  DriftParamsSchema,
  graphParams,
  GraphParamsSchema,
  parseParams,
  searchParams,
  SearchParamsSchema,
} from '../core/params.js';

export { budgeted };

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
  // A missing root is an error (never created); an existing one gets `.atlas/index.db`.
  const { root, config, paths, docsDir } = loadProject(opts.root);
  const db = openDatabase(paths.dbPath);
  let client: { model: string; inner: Promise<LLMClient> } | undefined;
  const make = (model: string): Promise<LLMClient> =>
    opts.llm
      ? Promise.resolve(opts.llm)
      : opts.offline
        ? Promise.resolve(createOfflineClient())
        : createAnthropicClient(model);
  // Each call reserves its most (prompt estimate + max_tokens) against `ctx.budget` as it is when
  // the call is made, so parallel calls cannot overspend (A17-02); it settles to the actual usage,
  // charged to `ctx.budget` as it is when the call returns.
  let reserved = 0;
  const metered = (inner: LLMClient): LLMClient => ({
    model: inner.model,
    async complete(params) {
      const input = estimateInputTokens(params);
      const left = new TokenBudget(ctx.budget.cap);
      left.record(ctx.budget.total().spent + reserved, 0);
      let maxTokens: number;
      try {
        maxTokens = affordableMaxTokens(left, input, params.maxTokens);
      } catch (err) {
        if (!reserved || !(err instanceof BudgetExhaustedError)) throw err;
        affordableMaxTokens(ctx.budget, input, params.maxTokens); // throws if no retry can pay it
        throw new BudgetExhaustedError(
          `${err.detail}, ${reserved} tokens reserved by calls in progress`,
          'retry when they finish',
        );
      }
      const hold = input + maxTokens;
      reserved += hold;
      try {
        const res = await inner.complete({ ...params, maxTokens });
        ctx.budget.record(res.inputTokens, res.outputTokens);
        return res;
      } finally {
        reserved -= hold;
      }
    },
  });
  const ctx: McpContext = {
    db,
    root,
    config,
    docsDir,
    budget: new TokenBudget(config.tokenBudget),
    llm: () => {
      const model = ctx.config.synthModel;
      if (client?.model !== model) {
        const entry = (client = { model, inner: make(model) });
        entry.inner.catch(() => client === entry && (client = undefined));
      }
      return client.inner.then(metered);
    },
  };
  return ctx;
}

/**
 * Re-reads `.atlas/config.json` into `ctx`, like the CLI does per command. A new `tokenBudget`
 * keeps the tokens spent so far; a new `synthModel` gets a new client on the next `ctx.llm()`.
 * The open DB is not switched: a changed `indexPath` is an error until the server restarts.
 */
function reloadConfig(ctx: McpContext): AtlasConfig {
  const config = loadConfig(ctx.root);
  const { dbPath } = resolvePaths(ctx.root, config);
  if (dbPath !== ctx.db.name) {
    throw new Error(
      `indexPath changed to '${config.indexPath}' after atlas mcp started; restart the server to use it (still serving ${ctx.db.name})`,
    );
  }
  if (config.tokenBudget !== ctx.budget.cap) {
    const { input, output } = ctx.budget.total();
    ctx.budget = new TokenBudget(config.tokenBudget);
    ctx.budget.record(input, output);
  }
  return (ctx.config = config);
}

function requireIndex(ctx: McpContext): void {
  requireIndexed(ctx.db, 'call atlas_index first');
}

// Like `atlas index`: writes a missing config and reads the current one on every call.
// Concurrent calls queue in `indexRepo` (one run per DB at a time); a call with the same
// options as a queued run that has not started shares that run.
export async function handleIndexTool(ctx: McpContext, args: { force?: boolean }) {
  writeDefaultConfig(ctx.root);
  const config = reloadConfig(ctx);
  return indexRepo(ctx.db, ctx.root, {
    force: args.force ?? false,
    exclude: config.exclude,
    include: config.include,
    languages: config.languages,
    ...(config.maxFileBytes !== undefined ? { maxBytes: config.maxFileBytes } : {}),
  });
}

export async function handleSearchTool(
  ctx: McpContext,
  args: { query: string; kind?: string[]; file?: string; limit?: number },
) {
  const { query, kind, file, limit } = parseParams(SearchParamsSchema, args);
  requireIndex(ctx);
  const hits = await search(ctx.db, createEmbedder(ctx.config), query, {
    ...(kind?.length ? { kind } : {}),
    ...(file ? { file } : {}),
    limit,
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
    const file = files.get(s.file_id);
    if (!sources.has(s.file_id)) {
      sources.set(
        s.file_id,
        file ? (readIndexedSource(ctx.root, file).source?.split('\n') ?? null) : null,
      );
    }
    const lines = sources.get(s.file_id);
    const end = Math.min(s.end_line, s.start_line + DEFAULT_EXCERPT_LINES - 1);
    return {
      id: s.id,
      name: s.name,
      qualifiedName: s.qualified_name,
      kind: s.kind,
      exported: s.exported === 1,
      file: file?.path ?? null,
      startLine: s.start_line,
      endLine: s.end_line,
      signature: s.signature,
      docstring: s.docstring,
      excerpt: lines ? lines.slice(s.start_line - 1, end).join('\n') : null,
      truncated: end < s.end_line,
    };
  });
}

export function handleGraphTool(
  ctx: McpContext,
  args: {
    format?: 'json' | 'dot';
    file?: string;
    symbol?: string;
    depth?: number;
    limit?: number;
    edgeLimit?: number;
    offset?: number;
  },
) {
  const { format, ...raw } = args;
  const query = parseParams(GraphParamsSchema, raw);
  requireIndex(ctx);
  return format === 'dot' ? buildGraphDot(ctx.db, query) : buildGraphJson(ctx.db, query);
}

export function handleDriftTool(
  ctx: McpContext,
  args: {
    persisted?: boolean;
    skipArchitecture?: boolean;
    strict?: boolean;
    limit?: number;
    offset?: number;
    formatted?: boolean;
  },
): DriftReport & { formatted?: string } {
  const page = parseParams(DriftParamsSchema, { limit: args.limit, offset: args.offset });
  requireIndex(ctx);
  const report = pageDriftReport(
    runDrift(ctx.db, {
      root: ctx.root,
      skipArchitecture: args.skipArchitecture ?? false,
      strict: args.strict ?? false,
      ...(args.persisted ? { docsDir: ctx.docsDir } : {}),
    }),
    page,
  );
  return args.formatted ? { ...report, formatted: formatDriftReport(report) } : report;
}

export function handleDocsTool(ctx: McpContext, args: { target?: string }) {
  if (args.target) return findDoc(ctx.db, ctx.docsDir, args.target);
  return listDocs(ctx.db, ctx.docsDir).map((d) => ({
    kind: d.kind,
    target: d.target,
    source: d.source,
    sourceHash: d.sourceHash,
    chars: d.content.length,
  }));
}

export async function handleAskTool(
  ctx: McpContext,
  args: { question: string; k?: number; expand?: number },
) {
  const { question, k, expand } = parseParams(AskParamsSchema, args);
  reloadConfig(ctx);
  requireIndex(ctx);
  const llm = await ctx.llm();
  const result = await ask(ctx.db, llm, ctx.root, question, {
    seedLimit: k,
    expansionLimit: expand,
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
  // Compact: tool results can be large and the SDK's stdio transport caps a message at 10 MiB.
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }] };
}

/** `asText` of `run()`; a corrupt index's error names the file, its WAL and the remedy (A31-01). */
async function answer(
  ctx: McpContext,
  run: () => unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    return asText(await run());
  } catch (err) {
    nameCorrupt(err, ctx.db.name);
    throw err;
  }
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
    async (args) => answer(ctx, () => handleIndexTool(ctx, args)),
  );

  server.registerTool(
    'atlas_search',
    {
      description:
        'Hybrid semantic + lexical symbol search. Returns ranked symbols with locations.',
      inputSchema: {
        query: searchParams.query.describe('Natural-language or identifier query.'),
        kind: searchParams.kind.describe('Only these symbol kinds.'),
        file: searchParams.file.describe('Only files whose path contains this substring.'),
        limit: searchParams.limit.describe('Max hits (default 10).'),
      },
    },
    async (args) => answer(ctx, () => handleSearchTool(ctx, args)),
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
    async (args) => answer(ctx, () => handleSymbolTool(ctx, args)),
  );

  server.registerTool(
    'atlas_graph',
    {
      description:
        'Export the symbol graph (nodes + calls/imports/extends/implements edges), bounded: nodes ordered by id, edges among them, with `totals` and `truncated`. Scope it with `file` or `symbol`.',
      inputSchema: {
        format: z.enum(['json', 'dot']).optional().describe('json (default) or Graphviz dot.'),
        file: graphParams.file.describe(
          'Only symbols in files whose path contains this substring.',
        ),
        symbol: graphParams.symbol.describe(
          'Only the neighbourhood of symbols with this name or qualified name.',
        ),
        depth: graphParams.depth.describe('Neighbourhood hops for `symbol` (default 1).'),
        limit: graphParams.limit.describe('Max nodes (default 1000).'),
        edgeLimit: graphParams.edgeLimit.describe('Max edges (default 2000).'),
        offset: graphParams.offset.describe('Skip this many nodes (paging).'),
      },
    },
    async (args) => answer(ctx, () => handleGraphTool(ctx, args)),
  );

  server.registerTool(
    'atlas_drift',
    {
      description:
        'Report stale docs (grounding context changed since generation) and undocumented exported symbols. `failing` matches `atlas drift` exiting 2; errors when there are no docs to check. Lists are paged (`truncated`, `totals`).',
      inputSchema: {
        persisted: z
          .boolean()
          .optional()
          .describe('Check the docs persisted in .atlas/docs instead of the index.'),
        skipArchitecture: z.boolean().optional().describe('Skip the architecture doc.'),
        strict: z
          .boolean()
          .optional()
          .describe(
            'Undocumented exported symbols also set `failing` (like `atlas drift --strict`).',
          ),
        limit: driftParams.limit.describe(
          'Max stale and max undocumented entries (default 100); `totals` counts all.',
        ),
        offset: driftParams.offset.describe('Skip this many entries of each list (paging).'),
        formatted: z.boolean().optional().describe('Also return the text report (`atlas drift`).'),
      },
    },
    async (args) => answer(ctx, () => handleDriftTool(ctx, args)),
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
    async (args) => answer(ctx, () => handleDocsTool(ctx, args)),
  );

  server.registerTool(
    'atlas_ask',
    {
      description:
        'Answer a question grounded in retrieved snippets, with citations and checks flagging citations outside them. Spends LLM tokens within the configured budget.',
      inputSchema: {
        question: askParams.question.describe('The question.'),
        k: askParams.k.describe('Seed snippets (default 5).'),
        expand: askParams.expand.describe('Graph-expanded snippets (default 5).'),
      },
    },
    async (args) => answer(ctx, () => handleAskTool(ctx, args)),
  );

  return server;
}

/**
 * Serve over stdio. Stdout carries only protocol messages. When stdin ends the
 * process exits once in-flight calls finish; the DB is closed on exit, SIGINT or SIGTERM.
 */
export async function startMcpServer(opts: McpContextOptions): Promise<void> {
  const ctx = createMcpContext(opts);
  process.once('exit', () => ctx.db.open && closeDatabase(ctx.db));
  closeOnSignal(ctx.db);
  await createAtlasMcpServer(ctx).connect(new StdioServerTransport());
}
