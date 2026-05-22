import type { Command } from 'commander';
import { resolve } from 'node:path';
import { startMcpServer } from '../../mcp/server.js';

interface McpArgs {
  cwd?: string;
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description(
      'Start the Atlas MCP server over stdio. Exposes atlas_index, atlas_search, atlas_symbol, atlas_graph, and atlas_drift to MCP clients (Claude Code, Cursor, etc.).',
    )
    .option('--cwd <path>', 'Project root to analyze', '.')
    .action(async (opts: McpArgs) => {
      const root = resolve(opts.cwd ?? '.');
      await startMcpServer(root);
    });
}
