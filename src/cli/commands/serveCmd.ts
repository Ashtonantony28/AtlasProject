import type { Command } from 'commander';
import { closeDatabase } from '../../core/db/index.js';
import { numberArg, parseParams, portSchema } from '../../core/params.js';
import { openProjectIndex } from '../../core/project.js';
import { startServer } from '../../web/server.js';

interface ServeArgs {
  port?: string;
  host?: string;
  cwd?: string;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the Atlas dashboard (HTTP API + static UI).')
    .option('-p, --port <port>', 'Port to listen on', '4321')
    .option('-H, --host <host>', 'Host to bind', '127.0.0.1')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (opts: ServeArgs) => {
      const port = parseParams(portSchema, numberArg(opts.port ?? '4321'));
      const { db, root } = openProjectIndex(opts.cwd ?? '.', { readonly: true });
      const handle = await startServer(db, root, {
        port,
        host: opts.host ?? '127.0.0.1',
      });
      process.stdout.write(`atlas: serving ${root} at ${handle.url}\n`);
      process.stdout.write(`atlas: press Ctrl+C to stop\n`);
      const shutdown = async () => {
        process.stdout.write('\natlas: shutting down…\n');
        await handle.close();
        closeDatabase(db);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
