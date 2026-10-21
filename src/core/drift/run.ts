// Shared drift entry point for the CLI and MCP: picks the docs to check and
// refuses to report "no stale docs" when there are no docs to check.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { counts, type DB } from '../db/index.js';
import { deletedDocsFromDb, docsFromDb, readPersistedDocs } from '../synth/index.js';
import { detectDrift, type DriftReport } from './detect.js';

export interface RunDriftOptions {
  root: string;
  // Check persisted docs in this directory (resolved against `root`) instead of the index.
  docsDir?: string;
  skipArchitecture?: boolean;
  strict?: boolean;
}

/** Throws when the docs to check are missing or empty while files are indexed. */
export function runDrift(db: DB, opts: RunDriftOptions): DriftReport {
  const indexed = counts(db).files > 0;
  let docs;
  if (opts.docsDir !== undefined) {
    const dir = resolve(opts.root, opts.docsDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`docs directory not found: ${dir}`);
    }
    docs = readPersistedDocs(dir);
    if (docs.length === 0 && indexed) {
      throw new Error(`no docs found in ${dir} (run \`atlas docs\` and commit them)`);
    }
  } else {
    docs = [...deletedDocsFromDb(db), ...docsFromDb(db)];
    if (docs.length === 0 && indexed) {
      throw new Error('no docs found in the index (run `atlas docs` first)');
    }
  }
  return detectDrift(db, {
    root: opts.root,
    docs,
    skipArchitecture: opts.skipArchitecture ?? false,
    strict: opts.strict ?? false,
  });
}
