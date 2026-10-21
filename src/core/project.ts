// Opening a project's index for read commands, with the same errors on every
// surface and no writes when the root or index is missing.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type DB, openDatabase } from './db/index.js';
import { type AtlasConfig, loadConfig, resolvePaths, type ResolvedPaths } from './config.js';

export interface Project {
  root: string;
  config: AtlasConfig;
  paths: ResolvedPaths;
  docsDir: string;
}

/** Throws unless `root` is an existing directory. */
export function requireRoot(root: string): string {
  const abs = resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`directory not found: ${abs}`);
  }
  return abs;
}

export function loadProject(root: string): Project {
  const abs = requireRoot(root);
  const config = loadConfig(abs);
  const paths = resolvePaths(abs, config);
  return { root: abs, config, paths, docsDir: join(paths.atlasDir, 'docs') };
}

/** Open an existing index; never creates `.atlas/` or the DB. */
export function openProjectIndex(
  root: string,
  opts: { readonly?: boolean } = {},
): Project & { db: DB } {
  const project = loadProject(root);
  if (!existsSync(project.paths.dbPath)) {
    throw new Error(`no index at ${project.paths.dbPath}: run \`atlas index\` first`);
  }
  const db = openDatabase(project.paths.dbPath, { ...opts, fileMustExist: true });
  return { ...project, db };
}
