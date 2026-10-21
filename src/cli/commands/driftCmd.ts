import type { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDatabase, counts, openDatabase } from '../../core/db/index.js';
import { detectDrift, formatDriftReport } from '../../core/drift/index.js';
import { type PersistedDoc, readPersistedDocs } from '../../core/synth/index.js';
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
      'Report stale docs and undocumented exported symbols. Exits 2 when a doc is stale (or, with --strict, when a symbol is undocumented); 1 when --docs-dir is missing or holds no docs.',
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
        let docs: PersistedDoc[] | undefined;
        if (opts.docsDir) {
          const dir = resolve(root, opts.docsDir);
          if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            process.stderr.write(`atlas drift: docs directory not found: ${dir}\n`);
            process.exitCode = 1;
            return;
          }
          docs = readPersistedDocs(dir);
          if (docs.length === 0 && counts(db).files > 0) {
            process.stderr.write(
              `atlas drift: no docs found in ${dir} (run \`atlas docs\` and commit them)\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        const report = detectDrift(db, {
          root,
          skipArchitecture: opts.skipArchitecture ?? false,
          ...(docs ? { docs } : {}),
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
