#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerIndexCommand } from './commands/indexCmd.js';
import { registerGraphCommand } from './commands/graphCmd.js';
import { registerSearchCommand } from './commands/searchCmd.js';
import { registerDocsCommand } from './commands/docsCmd.js';
import { registerAskCommand } from './commands/askCmd.js';
import { registerDriftCommand } from './commands/driftCmd.js';

const program = new Command();

program
  .name('atlas')
  .description('Local-first codebase intelligence engine')
  .version('0.1.0');

registerInitCommand(program);
registerIndexCommand(program);
registerGraphCommand(program);
registerSearchCommand(program);
registerDocsCommand(program);
registerAskCommand(program);
registerDriftCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`atlas: ${msg}\n`);
  process.exit(1);
});
