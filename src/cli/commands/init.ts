import type { Command } from 'commander';
import { relative } from 'node:path';
import { closeDatabase, openDatabase } from '../../core/db/index.js';
import { writeDefaultConfig } from '../../core/config.js';
import { requireRoot } from '../../core/project.js';

interface InitArgs {
  force?: boolean;
  cwd?: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Atlas in the current directory (writes config + empty index DB).')
    .option('-f, --force', 'Overwrite existing config file')
    .option('--cwd <path>', 'Project root (defaults to process.cwd())')
    .action(async (opts: InitArgs) => {
      const root = requireRoot(opts.cwd ?? process.cwd());
      const result = writeDefaultConfig(root, { force: opts.force });

      // Create + migrate the index DB so callers see a valid empty index.
      const db = openDatabase(result.dbPath);
      closeDatabase(db);

      const rel = (p: string) => relative(root, p) || p;
      const lines: string[] = [];
      if (result.configExisted && !opts.force) {
        lines.push(`config exists, leaving as-is: ${rel(result.configPath)}`);
      } else {
        lines.push(`wrote ${rel(result.configPath)}`);
      }
      lines.push(`initialized index at ${rel(result.dbPath)}`);
      lines.push('atlas: ready. Next: `atlas index <path>` (phase 2).');
      process.stdout.write(lines.join('\n') + '\n');
    });
}
