import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { closeDatabase } from '../../core/db/index.js';
import { buildGraphJson, graphToDot, type GraphFormat } from '../../core/graph/index.js';
import { GraphParamsSchema, numberArg, parseParams } from '../../core/params.js';
import { openProjectIndex } from '../../core/project.js';

interface GraphArgs {
  format?: GraphFormat;
  out?: string;
  cwd?: string;
  file?: string;
  symbol?: string;
  depth?: string;
  limit?: string;
  edgeLimit?: string;
  offset?: string;
}

export function registerGraphCommand(program: Command): void {
  program
    .command('graph')
    .description('Export the symbol/edge graph from the index (all of it unless --limit is given).')
    .option('-f, --format <format>', 'Output format: json|dot', 'json')
    .option('-o, --out <path>', 'Write to a file instead of stdout')
    .option('--file <substring>', 'Only symbols in files whose path contains this substring')
    .option('--symbol <name>', 'Only the neighbourhood of symbols with this name or qualified name')
    .option('--depth <n>', 'Neighbourhood hops for --symbol (1-3)', '1')
    .option('-n, --limit <n>', 'Max nodes (1-5000)')
    .option('--edge-limit <n>', 'Max edges (1-10000)')
    .option('--offset <n>', 'Skip this many nodes', '0')
    .option('--cwd <path>', 'Project root', '.')
    .action((opts: GraphArgs) => {
      const query = parseParams(GraphParamsSchema, {
        file: opts.file,
        symbol: opts.symbol,
        depth: numberArg(opts.depth),
        limit: numberArg(opts.limit),
        edgeLimit: numberArg(opts.edgeLimit),
        offset: numberArg(opts.offset),
      });
      const fmt = (opts.format ?? 'json') as GraphFormat;
      if (fmt !== 'json' && fmt !== 'dot') {
        process.stderr.write(`atlas: unknown format: ${fmt}\n`);
        process.exitCode = 1;
        return;
      }
      const { db } = openProjectIndex(opts.cwd ?? '.', { indexed: true });
      try {
        const q = {
          ...query,
          limit: opts.limit === undefined ? undefined : query.limit,
          edgeLimit: opts.edgeLimit === undefined ? undefined : query.edgeLimit,
        };
        const graph = buildGraphJson(db, q);
        const body =
          fmt === 'json' ? JSON.stringify(graph, null, 2) + '\n' : graphToDot(graph);
        if (opts.out) {
          writeFileSync(opts.out, body, 'utf8');
          process.stdout.write(
            `wrote ${opts.out} (${graph.nodes.length} nodes, ${graph.edges.length} edges)\n`,
          );
        } else {
          process.stdout.write(body);
        }
      } finally {
        closeDatabase(db);
      }
    });
}
