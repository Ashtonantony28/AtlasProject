import type { Command } from 'commander';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../../core/db/index.js';
import { detectDrift, formatDriftReport } from '../../core/drift/index.js';
import { loadConfig, resolvePaths } from '../../core/config.js';

interface DriftArgs {
  json?: boolean;
  cwd?: string;
  skipArchitecture?: boolean;
}

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description(
      'Report stale docs and undocumented public symbols. Exits non-zero when drift is detected.',
    )
    .option('--json', 'Output the drift report as JSON')
    .option('--skip-architecture', 'Do not check the architecture-level doc')
    .option('--cwd <path>', 'Project root', '.')
    .action((opts: DriftArgs) => {
      const root = resolve(opts.cwd ?? '.');
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath, { fileMustExist: true });
      try {
        const report = detectDrift(db, { skipArchitecture: opts.skipArchitecture ?? false });
        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          process.stdout.write(formatDriftReport(report) + '\n');
        }
        if (report.hasDrift) {
          process.exit(2);
        }
      } finally {
        closeDatabase(db);
      }
    });
}
