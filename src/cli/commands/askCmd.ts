import type { Command } from 'commander';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../../core/db/index.js';
import { createAnthropicClient, createOfflineClient } from '../../core/synth/index.js';
import { ask } from '../../core/qa/index.js';
import { loadConfig, resolvePaths } from '../../core/config.js';

interface AskArgs {
  offline?: boolean;
  model?: string;
  k?: string;
  expand?: string;
  json?: boolean;
  cwd?: string;
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask')
    .description('Ask a grounded natural-language question about the indexed repo.')
    .argument('<question...>', 'The question to ask (quotes optional)')
    .option('--offline', 'Use the offline/mock LLM (no API spend)')
    .option('-m, --model <model>', 'Override the synth model from config')
    .option('-k, --k <n>', 'Number of seed snippets to retrieve', '5')
    .option('--expand <n>', 'Number of additional graph-expanded snippets', '5')
    .option('--json', 'Output JSON (answer + citations)')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (questionParts: string[], opts: AskArgs) => {
      const question = questionParts.join(' ').trim();
      if (!question) {
        process.stderr.write('atlas: empty question\n');
        process.exit(1);
      }
      const root = resolve(opts.cwd ?? '.');
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath, { fileMustExist: true });
      try {
        const model = opts.model ?? config.synthModel;
        const llm = opts.offline ? createOfflineClient() : await createAnthropicClient(model);
        const result = await ask(db, llm, root, question, {
          seedLimit: Number.parseInt(opts.k ?? '5', 10),
          expansionLimit: Number.parseInt(opts.expand ?? '5', 10),
        });
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                question,
                answer: result.answer,
                citations: result.citations,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                model: llm.model,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }
        process.stdout.write(result.answer + '\n');
        if (result.citations.length > 0) {
          process.stdout.write('\nSources:\n');
          for (const c of result.citations) {
            process.stdout.write(
              `  [${c.index}] ${c.kind} ${c.symbol} (${c.file}:${c.startLine}-${c.endLine})\n`,
            );
          }
        }
        process.stdout.write(
          `\n_tokens: ${result.inputTokens} in / ${result.outputTokens} out  model: ${llm.model}_\n`,
        );
      } finally {
        closeDatabase(db);
      }
    });
}
