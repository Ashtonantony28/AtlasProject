import type { Command } from 'commander';
import { closeDatabase } from '../../core/db/index.js';
import { formatDriftReport, pageDriftReport, runDrift } from '../../core/drift/index.js';
import { DriftParamsSchema, numberArg, parseParams } from '../../core/params.js';
import { openProjectIndex } from '../../core/project.js';

interface DriftArgs {
  json?: boolean;
  cwd?: string;
  skipArchitecture?: boolean;
  docsDir?: string;
  strict?: boolean;
  limit?: string;
  offset?: string;
}

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description(
      'Report stale docs and undocumented exported symbols. Exits 2 when a doc is stale (or, with --strict, when a symbol is undocumented), matching `failing` in --json; 1 when there are no docs to check (--docs-dir missing or empty, or none in the index).',
    )
    .option('--json', 'Output the drift report as JSON')
    .option('--skip-architecture', 'Do not check the architecture-level doc')
    .option('--docs-dir <path>', 'Check persisted docs in this directory (e.g. .atlas/docs) instead of the index')
    .option('--strict', 'Also exit 2 when exported symbols are undocumented')
    .option('-n, --limit <n>', 'Show at most this many stale and undocumented entries each (1-1000); counts stay complete')
    .option('--offset <n>', 'Skip this many entries of each list', '0')
    .option('--cwd <path>', 'Project root', '.')
    .action((opts: DriftArgs) => {
      const page = parseParams(DriftParamsSchema, {
        limit: numberArg(opts.limit),
        offset: numberArg(opts.offset),
      });
      const { db, root } = openProjectIndex(opts.cwd ?? '.');
      try {
        let full;
        try {
          full = runDrift(db, {
            root,
            skipArchitecture: opts.skipArchitecture ?? false,
            strict: opts.strict ?? false,
            ...(opts.docsDir !== undefined ? { docsDir: opts.docsDir } : {}),
          });
        } catch (err) {
          process.stderr.write(`atlas drift: ${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
        const report = pageDriftReport(full, {
          offset: page.offset,
          limit: opts.limit === undefined ? Number.MAX_SAFE_INTEGER : page.limit,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          process.stdout.write(formatDriftReport(report) + '\n');
        }
        if (report.failing) process.exitCode = 2;
      } finally {
        closeDatabase(db);
      }
    });
}
