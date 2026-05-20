import type { Command } from 'commander';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase, type SymbolKind } from '../../core/db/index.js';
import { LocalHashEmbedder, search } from '../../core/vector/index.js';
import { loadConfig, resolvePaths } from '../../core/config.js';

interface SearchArgs {
  kind?: string;
  file?: string;
  limit?: string;
  json?: boolean;
  cwd?: string;
}

const VALID_KINDS: SymbolKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'variable',
  'module',
];

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Hybrid (semantic + structural) search over indexed symbols.')
    .argument('<query>', 'Search query')
    .option('-k, --kind <kind>', 'Filter by symbol kind (comma separated)')
    .option('--file <substring>', 'Filter by file path substring')
    .option('-n, --limit <n>', 'Max hits to return', '10')
    .option('--json', 'Output JSON instead of human-readable text')
    .option('--cwd <path>', 'Project root', '.')
    .action(async (query: string, opts: SearchArgs) => {
      const root = resolve(opts.cwd ?? '.');
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath, { fileMustExist: true });
      try {
        const embedder = new LocalHashEmbedder();
        let kinds: SymbolKind[] | undefined;
        if (opts.kind) {
          const parts = opts.kind
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as SymbolKind[];
          for (const k of parts) {
            if (!VALID_KINDS.includes(k)) {
              process.stderr.write(`atlas: unknown kind '${k}'\n`);
              process.exit(1);
            }
          }
          kinds = parts;
        }
        const limit = Number.parseInt(opts.limit ?? '10', 10);
        const hits = await search(db, embedder, query, {
          ...(kinds ? { kind: kinds } : {}),
          ...(opts.file ? { file: opts.file } : {}),
          limit,
        });
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              hits.map((h) => ({
                name: h.symbol.qualified_name ?? h.symbol.name,
                kind: h.symbol.kind,
                file: h.filePath,
                line: h.symbol.start_line,
                score: h.totalScore,
                semanticScore: h.semanticScore,
                structuralScore: h.structuralScore,
              })),
              null,
              2,
            ) + '\n',
          );
          return;
        }
        if (hits.length === 0) {
          process.stdout.write('no matches\n');
          return;
        }
        for (const h of hits) {
          const label = `${h.symbol.kind.padEnd(9)} ${h.symbol.qualified_name ?? h.symbol.name}`;
          const loc = `${h.filePath}:${h.symbol.start_line}`;
          const score = h.totalScore.toFixed(3);
          process.stdout.write(`${score}  ${label}  (${loc})\n`);
        }
      } finally {
        closeDatabase(db);
      }
    });
}
