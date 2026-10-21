import type { Command } from 'commander';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../../core/db/index.js';
import { detectDrift, formatDriftReport } from '../../core/drift/index.js';
import { readPersistedDocs } from '../../core/synth/index.js';
import { loadConfig, resolvePaths } from '../../core/config.js';

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
      'Report stale docs and undocumented exported symbols. Exits 2 when a doc is stale (or, with --strict, when a symbol is undocumented).',
    )
    .option('--json', 'Output the drift report as JSON')
    .option('--skip-architecture', 'Do not check the architecture-level doc')
    .option('--docs-dir <path>', 'Check persisted docs in this directory (e.g. .atlas/docs) instead of the index')
    .option('--strict', 'Also exit 2 when exported symbols are undocumented')
    .option('--cwd <path>', 'Project root', '.')
    .action((opts: DriftArgs) => {
      const root = resolve(opts.cwd ?? '.');
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath, { fileMustExist: true });
      try {
        const report = detectDrift(db, {
          root,
          skipArchitecture: opts.skipArchitecture ?? false,
          ...(opts.docsDir ? { docs: readPersistedDocs(resolve(root, opts.docsDir)) } : {}),
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          process.stdout.write(formatDriftReport(report) + '\n');
        }
        if (report.stale.length > 0 || (opts.strict && report.undocumented.length > 0)) {
          process.exitCode = 2;
        }
      } finally {
        closeDatabase(db);
      }
    });
}
