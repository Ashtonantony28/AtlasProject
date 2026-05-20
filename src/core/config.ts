import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const CONFIG_FILE = 'atlas.config.json';
export const ATLAS_DIR = '.atlas';
export const DB_FILE = 'index.db';

export const ConfigSchema = z.object({
  version: z.literal(1),
  // Where the SQLite index lives, relative to project root.
  indexPath: z.string().default(`${ATLAS_DIR}/${DB_FILE}`),
  // Languages we attempt to parse. Phase 2 supports ts, js, py.
  languages: z.array(z.enum(['typescript', 'javascript', 'python'])).default([
    'typescript',
    'javascript',
    'python',
  ]),
  // Glob-ish includes/excludes. We honor .gitignore plus these.
  include: z.array(z.string()).default(['src/**', 'lib/**']),
  exclude: z
    .array(z.string())
    .default(['node_modules/**', 'dist/**', 'build/**', '.atlas/**', 'coverage/**']),
  // Per-run cost guardrail (Phase 5+). Inputs+outputs combined, approximate.
  tokenBudget: z.number().int().positive().default(200_000),
  // Embeddings model name (resolved by provider; Phase 4).
  embeddingModel: z.string().default('local-hash-v1'),
  // Anthropic model name (Phase 5+).
  synthModel: z.string().default('claude-sonnet-4-6'),
});

export type AtlasConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AtlasConfig = ConfigSchema.parse({ version: 1 });

export interface ResolvedPaths {
  root: string;
  configPath: string;
  atlasDir: string;
  dbPath: string;
}

export function resolvePaths(root: string, config: AtlasConfig): ResolvedPaths {
  const abs = resolve(root);
  return {
    root: abs,
    configPath: join(abs, CONFIG_FILE),
    atlasDir: join(abs, ATLAS_DIR),
    dbPath: join(abs, config.indexPath),
  };
}

export function loadConfig(root: string): AtlasConfig {
  const cfgPath = join(resolve(root), CONFIG_FILE);
  if (!existsSync(cfgPath)) {
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(cfgPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${cfgPath}: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config at ${cfgPath}:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}

export interface InitOptions {
  force?: boolean;
}

export interface InitResult {
  configPath: string;
  dbPath: string;
  created: boolean;
  configExisted: boolean;
}

/**
 * Idempotent: writes a default config (if missing) and creates an empty index DB.
 */
export function writeDefaultConfig(root: string, opts: InitOptions = {}): InitResult {
  const abs = resolve(root);
  const configPath = join(abs, CONFIG_FILE);
  const atlasDir = join(abs, ATLAS_DIR);
  const dbPath = join(abs, DEFAULT_CONFIG.indexPath);

  const configExisted = existsSync(configPath);
  if (!configExisted || opts.force) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  }

  mkdirSync(atlasDir, { recursive: true });

  return {
    configPath,
    dbPath,
    created: !configExisted,
    configExisted,
  };
}
