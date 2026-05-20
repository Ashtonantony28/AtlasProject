import type { Command } from 'commander';
import { resolve } from 'node:path';
import {
  closeDatabase,
  openDatabase,
  getAllDocs,
  getAllFiles,
  getDoc,
} from '../../core/db/index.js';
import {
  createAnthropicClient,
  createOfflineClient,
  synthesizeDocs,
} from '../../core/synth/index.js';
import { loadConfig, resolvePaths } from '../../core/config.js';

interface DocsArgs {
  offline?: boolean;
  force?: boolean;
  model?: string;
  budget?: string;
  show?: string; // file path to print
  list?: boolean;
  verbose?: boolean;
  cwd?: string;
}

export function registerDocsCommand(program: Command): void {
  program
    .command('docs')
    .description('Synthesize module + architecture docs grounded in the index. With no flags, generates any missing/stale docs.')
    .option('--offline', 'Use the offline/mock LLM (no API spend)')
    .option('-f, --force', 'Re-generate even when source_hash is unchanged')
    .option('-m, --model <model>', 'Override the synth model from config')
    .option('-b, --budget <tokens>', 'Override the token budget from config')
    .option('--show <path>', 'Print the doc for the given file path (or "architecture")')
    .option('--list', 'List all stored docs')
    .option('-v, --verbose', 'Log progress for each module')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (opts: DocsArgs) => {
      const root = resolve(opts.cwd ?? '.');
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath, { fileMustExist: true });
      try {
        // Inspect mode: --show / --list (no synthesis).
        if (opts.list) {
          const docs = getAllDocs(db);
          if (docs.length === 0) {
            process.stdout.write('no docs yet — run `atlas docs` first\n');
            return;
          }
          for (const d of docs) {
            const len = d.content.length;
            process.stdout.write(
              `[${d.target_kind}:${d.target_id}] (${len} chars, hash=${d.source_hash.slice(0, 8)}, ${d.generated_at})\n`,
            );
          }
          return;
        }
        if (opts.show) {
          if (opts.show === 'architecture') {
            const d = getDoc(db, 'architecture', 0);
            if (!d) {
              process.stdout.write('no architecture doc — run `atlas docs` first\n');
              return;
            }
            process.stdout.write(d.content + '\n');
            return;
          }
          const file = getAllFiles(db).find((f) => f.path === opts.show);
          if (!file) {
            process.stderr.write(`atlas: file not in index: ${opts.show}\n`);
            process.exit(1);
          }
          const d = getDoc(db, 'file', file.id);
          if (!d) {
            process.stdout.write(`no doc for ${file.path} — run \`atlas docs\` first\n`);
            return;
          }
          process.stdout.write(d.content + '\n');
          return;
        }

        const model = opts.model ?? config.synthModel;
        const budget = opts.budget ? Number.parseInt(opts.budget, 10) : config.tokenBudget;
        const llm = opts.offline
          ? createOfflineClient()
          : await createAnthropicClient(model);

        const stats = await synthesizeDocs(db, llm, {
          root,
          tokenBudget: budget,
          force: opts.force ?? false,
          onProgress: (e) => {
            if (!opts.verbose) return;
            const tag = e.kind === 'module' ? e.path : 'architecture';
            process.stdout.write(`  [${e.status}] ${tag}${e.reason ? ` (${e.reason})` : ''}\n`);
          },
        });
        process.stdout.write(
          [
            `modules: generated ${stats.modulesGenerated}, cached ${stats.modulesCached}, skipped ${stats.modulesSkipped}`,
            `architecture: ${stats.architectureGenerated ? 'generated' : 'cached/skipped'}`,
            `tokens: ${stats.inputTokens} in, ${stats.outputTokens} out (budget remaining ${stats.budgetRemaining})`,
            `client: ${llm.model}  duration: ${stats.durationMs}ms`,
          ].join('\n') + '\n',
        );
      } finally {
        closeDatabase(db);
      }
    });
}
