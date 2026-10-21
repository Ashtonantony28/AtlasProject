import type { Command } from 'commander';
import {
  closeDatabase,
  openDatabase,
  counts,
} from '../../core/db/index.js';
import { indexRepo } from '../../core/ingest/index.js';
import { loadConfig, resolvePaths, writeDefaultConfig } from '../../core/config.js';
import { requireRoot } from '../../core/project.js';

interface IndexArgs {
  force?: boolean;
  verbose?: boolean;
  noWalk?: boolean;
}

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Index a repository: walk, parse, and write symbols/imports into the index DB.')
    .argument('[path]', 'Repository root', '.')
    .option('-f, --force', 'Re-parse all files regardless of hash')
    .option('-v, --verbose', 'Log each file as it is processed')
    .action(async (pathArg: string, opts: IndexArgs) => {
      const root = requireRoot(pathArg);
      // Auto-init creates only .atlas/ (config + index) inside the target.
      writeDefaultConfig(root);
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath);
      try {
        const stats = await indexRepo(db, root, {
          force: opts.force ?? false,
          exclude: config.exclude,
          include: config.include,
          languages: config.languages,
          onFile: (e) => {
            if (opts.verbose) {
              process.stdout.write(`  [${e.status}] ${e.path}${e.reason ? ` (${e.reason})` : ''}\n`);
            }
          },
        });
        const final = counts(db);
        const edgesLine =
          stats.filesIndexed > 0
            ? `resolved ${stats.edges} edges (${stats.weakEdges} weak)`
            : `edges: ${final.edges} (graph unchanged)`;
        process.stdout.write(
          [
            `scanned ${stats.filesScanned} files`,
            `indexed ${stats.filesIndexed}, skipped ${stats.filesSkipped}, failed ${stats.filesFailed}`,
            ...(stats.filesWithDiagnostics > 0
              ? [
                  `${stats.filesWithDiagnostics} files with parse diagnostics (use --verbose to list)`,
                ]
              : []),
            `wrote ${stats.symbols} symbols, ${stats.imports} imports in ${stats.durationMs}ms`,
            edgesLine,
            `embedded ${stats.embeddings} new symbols`,
            `totals: files=${final.files} symbols=${final.symbols} imports=${final.imports} edges=${final.edges}`,
          ].join('\n') + '\n',
        );
      } finally {
        closeDatabase(db);
      }
    });
}
