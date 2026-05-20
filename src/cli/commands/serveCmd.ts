import type { Command } from 'commander';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../../core/db/index.js';
import { loadConfig, resolvePaths } from '../../core/config.js';
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
      const root = resolve(opts.cwd ?? '.');
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath, { readonly: true, fileMustExist: true });
      const handle = await startServer(db, root, {
        port: Number.parseInt(opts.port ?? '4321', 10),
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
