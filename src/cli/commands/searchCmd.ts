import type { Command } from 'commander';
import { closeDatabase } from '../../core/db/index.js';
import { createEmbedder, search } from '../../core/vector/index.js';
import { listArg, numberArg, parseParams, SearchParamsSchema } from '../../core/params.js';
import { openProjectIndex } from '../../core/project.js';

interface SearchArgs {
  kind?: string;
  file?: string;
  limit?: string;
  json?: boolean;
  cwd?: string;
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Hybrid (semantic + structural) search over indexed symbols.')
    .argument('<query>', 'Search query')
    .option('-k, --kind <kind>', 'Filter by symbol kind (comma separated)')
    .option('--file <substring>', 'Filter by file path substring')
    .option('-n, --limit <n>', 'Max hits to return (1-100)', '10')
    .option('--json', 'Output JSON instead of human-readable text')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (rawQuery: string, opts: SearchArgs) => {
      const { query, kind, file, limit } = parseParams(SearchParamsSchema, {
        query: rawQuery,
        kind: listArg(opts.kind),
        file: opts.file,
        limit: numberArg(opts.limit),
      });
      const { db, config } = openProjectIndex(opts.cwd ?? '.', { indexed: true });
      try {
        const embedder = createEmbedder(config);
        const hits = await search(db, embedder, query, {
          ...(kind?.length ? { kind } : {}),
          ...(file ? { file } : {}),
          limit,
        });
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              hits.map((h) => ({
                name: h.symbol.qualified_name ?? h.symbol.name,
                kind: h.symbol.kind,
                file: h.filePath,
                line: h.symbol.start_line,
                score: h.totalScore,
                semanticScore: h.semanticScore,
                structuralScore: h.structuralScore,
              })),
              null,
              2,
            ) + '\n',
          );
          return;
        }
        if (hits.length === 0) {
          process.stdout.write('no matches\n');
          return;
        }
        for (const h of hits) {
          const label = `${h.symbol.kind.padEnd(9)} ${h.symbol.qualified_name ?? h.symbol.name}`;
          const loc = `${h.filePath}:${h.symbol.start_line}`;
          const score = h.totalScore.toFixed(3);
          process.stdout.write(`${score}  ${label}  (${loc})\n`);
        }
      } finally {
        closeDatabase(db);
      }
    });
}
