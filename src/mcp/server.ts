import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import {
  openDatabase,
  closeDatabase,
  getAllSymbols,
  getAllFiles,
  type DB,
} from '../core/db/index.js';
import { indexRepo } from '../core/ingest/index.js';
import { buildGraphJson, buildGraphDot } from '../core/graph/export.js';
import { LocalHashEmbedder, search, readFileFromRoot } from '../core/vector/index.js';
import { detectDrift, formatDriftReport } from '../core/drift/index.js';
import { loadConfig, resolvePaths } from '../core/config.js';

// ---------------------------------------------------------------------------
// Exported handler functions (also used in tests)
// ---------------------------------------------------------------------------

export async function handleIndexTool(
  db: DB,
  root: string,
  args: { force?: boolean },
): Promise<string> {
  const stats = await indexRepo(db, root, { force: args.force ?? false });
  return JSON.stringify(stats, null, 2);
}

export async function handleSearchTool(
  db: DB,
  args: { query: string; kind?: string; file?: string; limit?: number },
): Promise<string> {
  const query = (args.query ?? '').trim();
  if (!query) return '[]';
  const embedder = new LocalHashEmbedder();
  const hits = await search(db, embedder, query, {
    ...(args.kind ? { kind: args.kind as import('../core/db/types.js').SymbolKind } : {}),
    ...(args.file ? { file: args.file } : {}),
    limit: args.limit ?? 10,
  });
  const result = hits.map((h) => ({
    name: h.symbol.qualified_name ?? h.symbol.name,
    kind: h.symbol.kind,
    file: h.filePath,
    startLine: h.symbol.start_line,
    endLine: h.symbol.end_line,
    signature: h.symbol.signature,
    docstring: h.symbol.docstring,
    score: Math.round(h.totalScore * 1000) / 1000,
  }));
  return JSON.stringify(result, null, 2);
}

export async function handleSymbolTool(
  db: DB,
  root: string,
  args: { name: string },
): Promise<string> {
  const name = (args.name ?? '').trim();
  if (!name) return '[]';
  const nameLower = name.toLowerCase();
  const allSymbols = getAllSymbols(db);
  const matches = allSymbols.filter(
    (s) =>
      s.name.toLowerCase() === nameLower ||
      s.name.toLowerCase().includes(nameLower) ||
      (s.qualified_name ?? '').toLowerCase().includes(nameLower),
  );
  const files = new Map(getAllFiles(db).map((f) => [f.id, f]));
  const result = matches.slice(0, 20).map((sym) => {
    const file = files.get(sym.file_id);
    let excerpt: string | null = null;
    if (file) {
      const source = readFileFromRoot(root, db, file.id);
      if (source) {
        const lines = source.split('\n');
        const start = Math.max(0, sym.start_line - 1);
        const end = Math.min(lines.length, sym.end_line);
        excerpt = lines.slice(start, end).join('\n');
      }
    }
    return {
      id: sym.id,
      name: sym.name,
      qualifiedName: sym.qualified_name,
      kind: sym.kind,
      file: file?.path ?? null,
      startLine: sym.start_line,
      endLine: sym.end_line,
      signature: sym.signature,
      docstring: sym.docstring,
      excerpt,
    };
  });
  return JSON.stringify(result, null, 2);
}

export function handleGraphTool(db: DB, args: { format?: string }): string {
  const fmt = args.format ?? 'json';
  if (fmt === 'dot') return buildGraphDot(db);
  return JSON.stringify(buildGraphJson(db), null, 2);
}

export function handleDriftTool(db: DB): string {
  const report = detectDrift(db);
  return JSON.stringify(
    {
      hasDrift: report.hasDrift,
      stale: report.stale,
      undocumented: report.undocumented,
      totals: report.totals,
      formatted: formatDriftReport(report),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface AtlasMcpOptions {
  root: string;
}

export function createAtlasMcpServer(opts: AtlasMcpOptions): { server: McpServer; db: DB } {
  const root = resolve(opts.root);
  const config = loadConfig(root);
  const paths = resolvePaths(root, config);
  const db = openDatabase(paths.dbPath);

  const server = new McpServer(
    { name: 'atlas', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'atlas_index',
    {
      description:
        'Index a repository: walk files, extract symbols, build the dependency graph, and compute embeddings. Run this before using other tools.',
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe('Force re-index even for unchanged files (default: false).'),
      },
    },
    async ({ force }) => {
      try {
        const text = await handleIndexTool(db, root, { force });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'atlas_search',
    {
      description:
        'Hybrid semantic + structural symbol search over the indexed codebase. Returns ranked symbols with file locations.',
      inputSchema: {
        query: z.string().describe('Natural-language or identifier search query.'),
        kind: z
          .enum(['function', 'method', 'class', 'interface', 'type', 'variable', 'module'])
          .optional()
          .describe('Filter by symbol kind.'),
        file: z
          .string()
          .optional()
          .describe('Filter to symbols in files whose path contains this string.'),
        limit: z.number().optional().describe('Maximum number of results (default: 10).'),
      },
    },
    async ({ query, kind, file, limit }) => {
      try {
        const text = await handleSearchTool(db, { query, kind, file, limit });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'atlas_symbol',
    {
      description:
        'Look up symbols by name. Returns details including file, line range, signature, docstring, and a source excerpt.',
      inputSchema: {
        name: z.string().describe('Symbol name (exact or partial match, case-insensitive).'),
      },
    },
    async ({ name }) => {
      try {
        const text = await handleSymbolTool(db, root, { name });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'atlas_graph',
    {
      description:
        'Export the symbol dependency graph (nodes + typed edges: calls, imports, extends, implements).',
      inputSchema: {
        format: z
          .enum(['json', 'dot'])
          .optional()
          .describe(
            'Output format. "json" returns a structured object; "dot" returns Graphviz DOT source (default: json).',
          ),
      },
    },
    async ({ format }) => {
      try {
        const text = handleGraphTool(db, { format });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'atlas_drift',
    {
      description:
        'Detect documentation drift: stale docs (source changed since doc was generated) and undocumented public symbols.',
      inputSchema: {},
    },
    async () => {
      try {
        const text = handleDriftTool(db);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return { server, db };
}

export async function startMcpServer(root: string): Promise<void> {
  const { server, db } = createAtlasMcpServer({ root });
  process.on('exit', () => {
    try {
      closeDatabase(db);
    } catch {
      // ignore
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
