// AUDIT-4: test coverage. Each `it.fails` asserts the CORRECT behaviour and currently fails,
// reproducing one finding in AUDIT-4.md (IDs A4-xx). When a finding is fixed its test starts
// passing, `it.fails` turns red, and it should become a plain `it`. Each `it.todo` names a
// test that should exist: a mutation of correct code survived, or a correct path is untested.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getFileByPath,
  getSymbolsForFile,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

// Fault injection, off unless a test sets it.
const fault = vi.hoisted(() => ({
  unreadableDir: null as string | null,
  parseThrowsOn: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readdirSync = ((path: Parameters<typeof real.readdirSync>[0], ...rest: unknown[]) => {
    if (fault.unreadableDir !== null && String(path) === fault.unreadableDir) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(path)}'`), {
        code: 'EACCES',
      });
    }
    return (real.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readdirSync;
  return { ...real, default: { ...real, readdirSync }, readdirSync };
});

vi.mock('tree-sitter', async (importOriginal) => {
  const real = await importOriginal<{
    default: new () => { parse(...a: unknown[]): unknown };
  }>();
  const Base = real.default;
  class FaultyParser extends Base {
    parse(input: unknown, ...rest: unknown[]): unknown {
      if (fault.parseThrowsOn !== null && typeof input === 'function') {
        const head = String((input as (i: number) => string)(0));
        if (head.includes(fault.parseThrowsOn)) throw new Error('Invalid argument');
      }
      return super.parse(input, ...rest);
    }
  }
  return { ...real, default: FaultyParser };
});

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  fault.unreadableDir = null;
  fault.parseThrowsOn = null;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { root: string; db: DB } {
  const base = mkdtempSync(join(tmpdir(), 'atlas-audit4-'));
  dirs.push(base);
  const root = join(base, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const db = openDatabase(join(base, 'index.db'));
  dbs.push(db);
  return { root, db };
}

const FILES = {
  'a.ts': "import { b } from './lib/b';\nexport function a(): number { return b(); }\n",
  'lib/b.ts': 'export function b(): number { return 2; }\n',
};

describe('AUDIT-4 findings', () => {
  it.fails('A4-01: an unreadable directory does not prune the files indexed under it', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    const before = getFileByPath(db, 'lib/b.ts');
    expect(before).toBeDefined();

    fault.unreadableDir = join(root, 'lib');
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    // A transient EACCES/EMFILE on readdir is not a deletion: the rows (and docs) must survive,
    // or the failure must at least be reported.
    expect(stats.filesRemoved).toBe(0);
    expect(getFileByPath(db, 'lib/b.ts')).toBeDefined();
  });

  it.fails(
    'A4-02: an internal tree-sitter failure keeps the old rows and hash so the next run retries',
    async () => {
      const { root, db } = repo(FILES);
      await indexRepo(db, root, { skipEmbeddings: true });
      const file = getFileByPath(db, 'lib/b.ts')!;
      expect(getSymbolsForFile(db, file.id).map((s) => s.name)).toContain('b');

      writeFileSync(
        join(root, 'lib/b.ts'),
        '// TRIGGER\nexport function b(): number { return 3; }\nexport function c(): number { return 4; }\n',
      );
      fault.parseThrowsOn = 'TRIGGER';
      const stats = await indexRepo(db, root, { skipEmbeddings: true });
      // Same contract as test/ingest/failure.test.ts, but through the real parseSource,
      // which turns the throw into a diagnostic and returns zero symbols.
      expect(stats.filesFailed).toBe(1);
      expect(getFileByPath(db, 'lib/b.ts')?.content_hash).toBe(file.content_hash);
      expect(getSymbolsForFile(db, file.id).map((s) => s.name)).toContain('b');
    },
  );

  it.todo(
    'A4-08: drift reports the doc of a file deleted on disk but not yet re-indexed (correct today via the source read in modulePrompt; no test pins it)',
  );
  it.todo(
    'A4-03: `atlas serve` opens the index read-only (removing { readonly: true } in serveCmd survives)',
  );
  it.todo(
    'A4-04: runDrift in DB mode reports a pruned file as stale via its tombstone (dropping deletedDocsFromDb in drift/run.ts survives)',
  );
  it.todo(
    'A4-05: budgeted() refuses a call whose reserve exceeds the remaining budget by 1 token (a 1000-token slack survives)',
  );
});
