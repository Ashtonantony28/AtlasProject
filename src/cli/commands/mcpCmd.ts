import type { Command } from 'commander';
import { resolve } from 'node:path';
import { startMcpServer } from '../../mcp/server.js';

interface McpArgs {
  offline?: boolean;
  cwd?: string;
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description(
      'Serve the index to MCP clients over stdio (tools: atlas_index, atlas_search, atlas_symbol, atlas_graph, atlas_drift, atlas_docs, atlas_ask).',
    )
    .option('--offline', 'Answer atlas_ask with the offline/mock LLM (no API spend)')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (opts: McpArgs) => {
      await startMcpServer({ root: resolve(opts.cwd ?? '.'), offline: opts.offline ?? false });
    });
}
