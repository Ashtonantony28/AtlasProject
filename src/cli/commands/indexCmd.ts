import type { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  closeDatabase,
  openDatabase,
  counts,
} from '../../core/db/index.js';
import { indexRepo } from '../../core/ingest/index.js';
import { loadConfig, resolvePaths, writeDefaultConfig } from '../../core/config.js';

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
      const root = resolve(pathArg);
      if (!existsSync(root)) {
        process.stderr.write(`atlas: path does not exist: ${root}\n`);
        process.exit(1);
      }
      // Auto-init if missing — phase 1 already supports it.
      writeDefaultConfig(root);
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath);
      try {
        const stats = await indexRepo(db, root, {
          force: opts.force ?? false,
          exclude: config.exclude,
          onFile: (e) => {
            if (opts.verbose) {
              process.stdout.write(`  [${e.status}] ${e.path}${e.reason ? ` (${e.reason})` : ''}\n`);
            }
          },
        });
        const final = counts(db);
        process.stdout.write(
          [
            `scanned ${stats.filesScanned} files`,
            `indexed ${stats.filesIndexed}, skipped ${stats.filesSkipped}, failed ${stats.filesFailed}`,
            `wrote ${stats.symbols} symbols, ${stats.imports} imports in ${stats.durationMs}ms`,
            `resolved ${stats.edges} edges (${stats.weakEdges} weak)`,
            `embedded ${stats.embeddings} new symbols`,
            `totals: files=${final.files} symbols=${final.symbols} imports=${final.imports} edges=${final.edges}`,
          ].join('\n') + '\n',
        );
      } finally {
        closeDatabase(db);
      }
    });
}
