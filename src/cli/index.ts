#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerIndexCommand } from './commands/indexCmd.js';

const program = new Command();

program
  .name('atlas')
  .description('Local-first codebase intelligence engine')
  .version('0.1.0');

registerInitCommand(program);
registerIndexCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`atlas: ${msg}\n`);
  process.exit(1);
});
