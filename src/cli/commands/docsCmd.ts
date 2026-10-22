import type { Command } from 'commander';
import { relative } from 'node:path';
import { closeDatabase, nameBusy } from '../../core/db/index.js';
import {
  BudgetExhaustedError,
  createAnthropicClient,
  createOfflineClient,
  exportDocs,
  findDoc,
  importPersistedDocs,
  listDocs,
  synthesizeDocs,
} from '../../core/synth/index.js';
import { budgetSchema, numberArg, parseParams } from '../../core/params.js';
import { openProjectIndex, requireIndexed } from '../../core/project.js';

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
    .option('-b, --budget <tokens>', 'Override the token budget from config (positive integer)')
    .option('--show <path>', 'Print the doc for the given file path (or "architecture"); exits 1 if none')
    .option('--list', 'List all docs (index, then .atlas/docs)')
    .option('-v, --verbose', 'Log progress for each module')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (opts: DocsArgs) => {
      const budget =
        opts.budget === undefined ? undefined : parseParams(budgetSchema, numberArg(opts.budget));
      const { db, root, config, docsDir } = openProjectIndex(opts.cwd ?? '.');
      try {
        // Inspect mode: --show / --list (no synthesis). The index first, then `.atlas/docs`.
        if (opts.list) {
          const docs = listDocs(db, docsDir);
          if (docs.length === 0) {
            process.stdout.write('no docs yet — run `atlas docs` first\n');
            return;
          }
          for (const d of docs) {
            process.stdout.write(
              `[${d.kind}] ${d.target} (${d.content.length} chars, hash=${d.sourceHash.slice(0, 8)}, ${d.source})\n`,
            );
          }
          return;
        }
        if (opts.show) {
          process.stdout.write(findDoc(db, docsDir, opts.show).content + '\n');
          return;
        }

        requireIndexed(db);
        const model = opts.model ?? config.synthModel;
        const llm = opts.offline
          ? createOfflineClient()
          : await createAnthropicClient(model);

        const stats = await (async () => {
          importPersistedDocs(db, docsDir);
          return synthesizeDocs(db, llm, {
            root,
            tokenBudget: budget ?? config.tokenBudget,
            force: opts.force ?? false,
            onProgress: (e) => {
              if (!opts.verbose) return;
              const tag = e.kind === 'module' ? e.path : 'architecture';
              process.stdout.write(`  [${e.status}] ${tag}${e.reason ? ` (${e.reason})` : ''}\n`);
            },
          });
        })().catch((err: unknown) => {
          nameBusy(err, 'docs write');
          // The cap came from --budget, so raising tokenBudget in the config would not help.
          throw budget !== undefined && err instanceof BudgetExhaustedError
            ? new BudgetExhaustedError(err.detail, 'raise --budget')
            : err;
        });
        const exported = exportDocs(db, docsDir);
        process.stdout.write(
          [
            `modules: generated ${stats.modulesGenerated}, cached ${stats.modulesCached}, skipped ${stats.modulesSkipped}, failed ${stats.modulesFailed}`,
            `persisted: ${exported.total} docs in ${relative(root, docsDir)} (${exported.written} written, ${exported.removed} removed)`,
            `architecture: ${stats.architectureGenerated ? 'generated' : stats.architectureFailed ? 'failed' : 'cached/skipped'}`,
            `tokens: ${stats.inputTokens} in, ${stats.outputTokens} out (budget remaining ${stats.budgetRemaining})`,
            `client: ${llm.model}  duration: ${stats.durationMs}ms`,
          ].join('\n') + '\n',
        );
        if (stats.failures.length > 0) {
          for (const f of stats.failures) {
            process.stderr.write(`atlas docs: ${f.target}: not stored (${f.reason})\n`);
          }
          process.exitCode = 1;
        }
      } finally {
        closeDatabase(db);
      }
    });
}
