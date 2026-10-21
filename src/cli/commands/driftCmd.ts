import type { Command } from 'commander';
import { closeDatabase } from '../../core/db/index.js';
import { formatDriftReport, runDrift } from '../../core/drift/index.js';
import { openProjectIndex } from '../../core/project.js';

interface DriftArgs {
  json?: boolean;
  cwd?: string;
  skipArchitecture?: boolean;
  docsDir?: string;
  strict?: boolean;
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
    .option('--cwd <path>', 'Project root', '.')
    .action((opts: DriftArgs) => {
      const { db, root } = openProjectIndex(opts.cwd ?? '.');
      try {
        let report;
        try {
          report = runDrift(db, {
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
