import type { Command } from 'commander';
import { closeDatabase } from '../../core/db/index.js';
import {
  budgeted,
  createAnthropicClient,
  createOfflineClient,
  TokenBudget,
} from '../../core/synth/index.js';
import { ask } from '../../core/qa/index.js';
import { AskParamsSchema, numberArg, parseParams } from '../../core/params.js';
import { openProjectIndex } from '../../core/project.js';

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
    .option('-k, --k <n>', 'Number of seed snippets to retrieve (1-20)', '5')
    .option('--expand <n>', 'Number of additional graph-expanded snippets (0-20)', '5')
    .option('--json', 'Output JSON (answer, citations, citation checks)')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (questionParts: string[], opts: AskArgs) => {
      const { question, k, expand } = parseParams(AskParamsSchema, {
        question: questionParts.join(' '),
        k: numberArg(opts.k),
        expand: numberArg(opts.expand),
      });
      const { db, root, config } = openProjectIndex(opts.cwd ?? '.');
      try {
        const model = opts.model ?? config.synthModel;
        const inner = opts.offline ? createOfflineClient() : await createAnthropicClient(model);
        const llm = budgeted(inner, new TokenBudget(config.tokenBudget));
        const result = await ask(db, llm, root, question, {
          seedLimit: k,
          expansionLimit: expand,
        });
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                question,
                answer: result.answer,
                citations: result.citations,
                checks: result.checks,
                flagged: result.flagged,
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
        if (result.flagged.length > 0) {
          process.stdout.write('\nUnverified citations:\n');
          for (const f of result.flagged) process.stdout.write(`  ${f.raw} ${f.reason}\n`);
        }
        process.stdout.write(
          `\n_tokens: ${result.inputTokens} in / ${result.outputTokens} out  model: ${llm.model}_\n`,
        );
      } finally {
        closeDatabase(db);
      }
    });
}
