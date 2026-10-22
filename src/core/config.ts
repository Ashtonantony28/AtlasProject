import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

export const ATLAS_DIR = '.atlas';
export const CONFIG_FILE = `${ATLAS_DIR}/config.json`;
// Pre-SG8 location; still read if present, never written.
export const LEGACY_CONFIG_FILE = 'atlas.config.json';
export const DB_FILE = 'index.db';

export const ConfigSchema = z.object({
  version: z.literal(1),
  // Where the SQLite index lives, relative to project root; must stay inside `.atlas/`.
  indexPath: z.string().default(`${ATLAS_DIR}/${DB_FILE}`),
  // Languages we attempt to parse. Phase 2 supports ts, js, py.
  languages: z
    .array(z.enum(['typescript', 'javascript', 'python']))
    .default(['typescript', 'javascript', 'python']),
  // Gitignore-style globs. Empty include = walk everything; exclude adds to .gitignore.
  // The defaults are root-anchored: `src/build/` is still walked.
  include: z.array(z.string()).default([]),
  exclude: z
    .array(z.string())
    .default([
      'node_modules/**',
      'dist/**',
      'build/**',
      '.atlas/**',
      'coverage/**',
      '.venv/**',
      'venv/**',
      '.next/**',
      '.cache/**',
    ]),
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
  const atlasDir = join(abs, ATLAS_DIR);
  const dbPath = resolve(abs, config.indexPath);
  const rel = relative(atlasDir, dbPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`indexPath must be inside ${ATLAS_DIR}/ (got '${config.indexPath}')`);
  }
  return {
    root: abs,
    configPath: findConfigPath(abs) ?? join(abs, CONFIG_FILE),
    atlasDir,
    dbPath,
  };
}

function findConfigPath(root: string): string | null {
  for (const f of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    const p = join(root, f);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(root: string): AtlasConfig {
  const cfgPath = findConfigPath(resolve(root));
  if (!cfgPath) {
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
 * Idempotent: writes `.atlas/config.json` (if missing) and creates `.atlas/`.
 * Never writes outside `.atlas/`; a legacy root config is left untouched.
 */
export function writeDefaultConfig(root: string, opts: InitOptions = {}): InitResult {
  const abs = resolve(root);
  const existing = findConfigPath(abs);
  const configExisted = existing !== null;
  let configPath = existing ?? join(abs, CONFIG_FILE);
  mkdirSync(join(abs, ATLAS_DIR), { recursive: true });
  if (!configExisted || opts.force) {
    configPath = join(abs, CONFIG_FILE);
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  }
  return {
    configPath,
    dbPath: resolvePaths(abs, loadConfig(abs)).dbPath,
    created: !configExisted,
    configExisted,
  };
}
