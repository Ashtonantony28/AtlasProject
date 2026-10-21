import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerIndexCommand } from './commands/indexCmd.js';
import { registerGraphCommand } from './commands/graphCmd.js';
import { registerSearchCommand } from './commands/searchCmd.js';
import { registerDocsCommand } from './commands/docsCmd.js';
import { registerAskCommand } from './commands/askCmd.js';
import { registerDriftCommand } from './commands/driftCmd.js';
import { registerServeCommand } from './commands/serveCmd.js';
import { registerCiCommentCommand } from './commands/ciCommentCmd.js';
import { registerMcpCommand } from './commands/mcpCmd.js';

export function buildProgram(): Command {
  const program = new Command();
  program.name('atlas').description('Local-first codebase intelligence engine').version('0.1.0');
  registerInitCommand(program);
  registerIndexCommand(program);
  registerGraphCommand(program);
  registerSearchCommand(program);
  registerDocsCommand(program);
  registerAskCommand(program);
  registerDriftCommand(program);
  registerServeCommand(program);
  registerCiCommentCommand(program);
  registerMcpCommand(program);
  return program;
}
