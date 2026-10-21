import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { closeDatabase, counts } from '../../core/db/index.js';
import { buildGraphJson, buildGraphDot, type GraphFormat } from '../../core/graph/index.js';
import { openProjectIndex } from '../../core/project.js';

interface GraphArgs {
  format?: GraphFormat;
  out?: string;
  cwd?: string;
}

export function registerGraphCommand(program: Command): void {
  program
    .command('graph')
    .description('Export the symbol/edge graph from the index.')
    .option('-f, --format <format>', 'Output format: json|dot', 'json')
    .option('-o, --out <path>', 'Write to a file instead of stdout')
    .option('--cwd <path>', 'Project root', '.')
    .action((opts: GraphArgs) => {
      const { db } = openProjectIndex(opts.cwd ?? '.');
      try {
        const fmt = (opts.format ?? 'json') as GraphFormat;
        let body: string;
        if (fmt === 'json') {
          body = JSON.stringify(buildGraphJson(db), null, 2) + '\n';
        } else if (fmt === 'dot') {
          body = buildGraphDot(db);
        } else {
          process.stderr.write(`atlas: unknown format: ${fmt}\n`);
          process.exitCode = 1;
          return;
        }
        if (opts.out) {
          writeFileSync(opts.out, body, 'utf8');
          const c = counts(db);
          process.stdout.write(`wrote ${opts.out} (${c.symbols} nodes, ${c.edges} edges)\n`);
        } else {
          process.stdout.write(body);
        }
      } finally {
        closeDatabase(db);
      }
    });
}
