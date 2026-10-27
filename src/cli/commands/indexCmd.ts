import type { Command } from 'commander';
import {
  closeDatabase,
  openDatabase,
  counts,
} from '../../core/db/index.js';
import { closeOnSignal } from '../../core/db/database.js';
import { DEFAULT_MAX_BYTES, indexRepo, type IndexStats } from '../../core/ingest/index.js';
import { loadConfig, resolvePaths, writeDefaultConfig } from '../../core/config.js';
import { requireRoot } from '../../core/project.js';

interface IndexArgs {
  force?: boolean;
  verbose?: boolean;
  noWalk?: boolean;
}

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Index a repository: walk, parse, and write symbols/imports into the index DB.')
    .argument('[path]', 'Repository root', '.')
    .option('-f, --force', 'Re-parse all files regardless of hash')
    .option('-v, --verbose', 'Log each file as it is processed')
    .action(async (pathArg: string, opts: IndexArgs) => {
      const root = requireRoot(pathArg);
      // Auto-init creates only .atlas/ (config + index) inside the target.
      writeDefaultConfig(root);
      const config = loadConfig(root);
      const paths = resolvePaths(root, config);
      const db = openDatabase(paths.dbPath);
      const unhook = closeOnSignal(db);
      try {
        const stats = await indexRepo(db, root, {
          force: opts.force ?? false,
          exclude: config.exclude,
          include: config.include,
          languages: config.languages,
          ...(config.maxFileBytes !== undefined ? { maxBytes: config.maxFileBytes } : {}),
          onFile: (e) => {
            if (opts.verbose) {
              process.stdout.write(`  [${e.status}] ${e.path}${e.reason ? ` (${e.reason})` : ''}\n`);
            }
          },
        });
        const final = counts(db);
        const edgesLine =
          stats.resolveReason !== null
            ? `resolved ${stats.edges} edges (${stats.weakEdges} weak)` +
              (stats.resolveReason === 'resolver config changed'
                ? ' after a resolver config change'
                : stats.resolveReason === 'previous run interrupted'
                  ? ' after an interrupted run'
                  : '')
            : `edges: ${final.edges} (graph unchanged)`;
        process.stdout.write(
          [
            ...upgradeLines(stats),
            `scanned ${stats.filesScanned} files`,
            `indexed ${stats.filesIndexed}, skipped ${stats.filesSkipped}, failed ${stats.filesFailed}`,
            ...tooLargeLines(stats, config.maxFileBytes ?? DEFAULT_MAX_BYTES),
            ...(stats.filesWithDiagnostics > 0
              ? [
                  `${stats.filesWithDiagnostics} files with parse diagnostics (use --verbose to list)`,
                ]
              : []),
            `wrote ${stats.symbols} symbols, ${stats.imports} imports in ${stats.durationMs}ms`,
            edgesLine,
            ...diagnosticLines(stats),
            `embedded ${stats.embeddings} new symbols`,
            `totals: files=${final.files} symbols=${final.symbols} imports=${final.imports} edges=${final.edges}`,
          ].join('\n') + '\n',
        );
      } finally {
        unhook();
        closeDatabase(db);
      }
    });
}

function upgradeLines({ extractorUpgrade: up }: IndexStats): string[] {
  if (!up) return [];
  const from = up.from === null ? 'an older Atlas' : `extractor v${up.from}`;
  return [`index was written by ${from}; re-parsed every file with extractor v${up.to}`];
}

function tooLargeLines({ filesTooLarge: n }: IndexStats, cap: number): string[] {
  if (n === 0) return [];
  return [
    `${n} file${n === 1 ? '' : 's'} over the ${cap}-byte cap not indexed ` +
      '(use --verbose to list; raise maxFileBytes in .atlas/config.json)',
  ];
}

const SHOWN_DIAGNOSTICS = 10;

function diagnosticLines(stats: IndexStats): string[] {
  const n = stats.resolverDiagnosticCount;
  if (n === 0) return [];
  const shown = stats.resolverDiagnostics.slice(0, SHOWN_DIAGNOSTICS);
  return [
    `resolver diagnostics (${n}):`,
    ...shown.map((d) => `  - ${d}`),
    ...(n > shown.length ? [`  … ${n - shown.length} more`] : []),
  ];
}
