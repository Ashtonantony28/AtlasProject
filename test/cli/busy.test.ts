// SG65: a CLI command that gets `SQLITE_BUSY` names the operation that hit it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeGitRepo, runCli } from './helpers.js';

// The next call of `busy.at` throws `SQLITE_BUSY`, as when another writer outlasts the busy wait.
const busy = vi.hoisted(() => ({ at: null as string | null }));
/** `f`, except that it throws `SQLITE_BUSY` when `busy.at` is `name` (once). */
function busyAt<A extends unknown[], R>(name: string, f: (...a: A) => R): (...a: A) => R {
  return (...a) => {
    if (busy.at === name) {
      busy.at = null;
      throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
    }
    return f(...a);
  };
}
vi.mock('../../src/core/db/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/db/index.js')>();
  return {
    ...real,
    startRun: busyAt('startRun', real.startRun),
    upsertFile: busyAt('upsertFile', real.upsertFile),
    finishRun: busyAt('finishRun', real.finishRun),
  };
});
vi.mock('../../src/core/graph/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/graph/resolver.js')>();
  return { ...real, resolveGraph: busyAt('resolveGraph', real.resolveGraph) };
});
vi.mock('../../src/core/vector/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/vector/index.js')>();
  return { ...real, embedAllSymbols: busyAt('embedAllSymbols', real.embedAllSymbols) };
});

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli/index.ts');

const dirs: string[] = [];
afterEach(() => {
  busy.at = null;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SG65 SQLITE_BUSY names the operation', () => {
  it('`atlas index` prints which step of the run got it', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const [at, op] of [
      ['startRun', 'run stamp'],
      ['upsertFile', 'index write'],
      ['resolveGraph', 'graph resolve'],
      ['embedAllSymbols', 'embeddings write'],
      ['finishRun', 'run stamp'],
    ] as const) {
      const dir = makeGitRepo('atlas-busy-');
      dirs.push(dir);
      busy.at = at;
      await expect(runCli(['index', dir]), at).rejects.toThrow(
        new RegExp(`^${op}: database is locked$`),
      );
      expect(busy.at, at).toBeNull();
    }
  });

  it('`atlas index` exits 1 with `atlas: journal mode: database is locked` when the open hits it', async () => {
    const dir = makeGitRepo('atlas-busy-');
    dirs.push(dir);
    mkdirSync(join(dir, '.atlas'));
    // Another program holds the write lock of an index it created in rollback mode.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
         const db = new D(${JSON.stringify(join(dir, '.atlas', 'index.db'))});
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => {}, 30_000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
      const r = spawnSync(TSX, [CLI, 'index', dir], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe('atlas: journal mode: database is locked\n');
    } finally {
      holder.kill();
    }
  });
});
