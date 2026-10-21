// AUDIT-4: test coverage. Each `it.fails` asserts the CORRECT behaviour and currently fails,
// reproducing one finding in AUDIT-4.md (IDs A4-xx). When a finding is fixed its test starts
// passing, `it.fails` turns red, and it should become a plain `it`. Each `it.todo` names a
// test that should exist: a mutation of correct code survived, or a correct path is untested.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  closeDatabase,
  counts,
  getDocTombstones,
  getFileByPath,
  getSymbolsForFile,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  budgeted,
  createOfflineClient,
  synthesizeDocs,
  TokenBudget,
  type LLMCallParams,
  type LLMClient,
} from '../../src/core/synth/index.js';
import type { DriftReport } from '../../src/core/drift/index.js';
import { ask } from '../../src/core/qa/index.js';
import { createMcpContext, handleDriftTool } from '../../src/mcp/server.js';
import * as web from '../../src/web/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

// Fault injection, off unless a test sets it.
const fault = vi.hoisted(() => ({
  unreadableDir: null as string | null,
  unstatableFile: null as string | null,
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
  const statSync = ((path: Parameters<typeof real.statSync>[0], ...rest: unknown[]) => {
    if (fault.unstatableFile !== null && String(path) === fault.unstatableFile) {
      throw Object.assign(new Error(`EIO: i/o error, stat '${String(path)}'`), { code: 'EIO' });
    }
    return (real.statSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.statSync;
  return { ...real, default: { ...real, readdirSync, statSync }, readdirSync, statSync };
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

vi.mock('../../src/web/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/server.js')>();
  return { ...actual, startServer: vi.fn(actual.startServer) };
});

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  fault.unreadableDir = null;
  fault.unstatableFile = null;
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
  it('A4-01: an unreadable directory does not prune the files indexed under it', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    const before = getFileByPath(db, 'lib/b.ts')!;
    expect(before).toBeDefined();
    const symbols = getSymbolsForFile(db, before.id).map((s) => s.name);
    const docs = counts(db).docs;
    expect(docs).toBeGreaterThan(0);

    fault.unreadableDir = join(root, 'lib');
    const failed: { path: string; reason?: string }[] = [];
    const stats = await indexRepo(db, root, {
      skipEmbeddings: true,
      onFile: (e) => {
        if (e.status === 'failed') failed.push(e);
      },
    });
    // A transient EACCES/EMFILE on readdir is not a deletion: the rows (and docs) must survive,
    // and the failure must be reported.
    expect(stats.filesRemoved).toBe(0);
    expect(stats.filesFailed).toBe(1);
    expect(failed).toEqual([
      { path: 'lib/', status: 'failed', reason: expect.stringContaining('EACCES') },
    ]);
    expect(getFileByPath(db, 'lib/b.ts')).toEqual(before);
    expect(getSymbolsForFile(db, before.id).map((s) => s.name)).toEqual(symbols);
    expect(getDocTombstones(db)).toEqual([]);
    expect(counts(db).docs).toBe(docs);

    fault.unreadableDir = null;
    const healed = await indexRepo(db, root, { skipEmbeddings: true });
    expect(healed).toMatchObject({ filesFailed: 0, filesRemoved: 0, filesSkipped: 2 });
  });

  it('A4-01: an unreadable root keeps the whole index', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    fault.unreadableDir = root;
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats).toMatchObject({ filesScanned: 0, filesFailed: 1, filesRemoved: 0 });
    expect(getFileByPath(db, 'a.ts')).toBeDefined();
    expect(getFileByPath(db, 'lib/b.ts')).toBeDefined();
  });

  it('A4-01: a file that fails to stat keeps its rows and is counted as failed', async () => {
    const { root, db } = repo(FILES);
    await indexRepo(db, root, { skipEmbeddings: true });
    const before = getFileByPath(db, 'lib/b.ts');
    fault.unstatableFile = join(root, 'lib', 'b.ts');
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats).toMatchObject({ filesFailed: 1, filesRemoved: 0 });
    expect(getFileByPath(db, 'lib/b.ts')).toEqual(before);
  });

  it('A4-02: an internal tree-sitter failure keeps the old rows and hash so the next run retries', async () => {
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
    // Same contract as test/ingest/failure.test.ts: the failed parse is not stored.
    expect(stats.filesFailed).toBe(1);
    expect(getFileByPath(db, 'lib/b.ts')?.content_hash).toBe(file.content_hash);
    const names = getSymbolsForFile(db, file.id).map((s) => s.name);
    expect(names).toContain('b');
    expect(names).not.toContain('c');

    fault.parseThrowsOn = null;
    const retried = await indexRepo(db, root, { skipEmbeddings: true });
    expect(retried).toMatchObject({ filesFailed: 0, filesIndexed: 1 });
    expect(getSymbolsForFile(db, file.id).map((s) => s.name)).toContain('c');
  });

  it('A4-06: `npm run typecheck` (run by CI) also typechecks test/', () => {
    const pkg = resolve(__dirname, '../..');
    const scripts = (
      JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.typecheck).toContain('tsc -p tsconfig.test.json --noEmit');
    const testConfig = JSON.parse(readFileSync(join(pkg, 'tsconfig.test.json'), 'utf8')) as {
      include: string[];
    };
    expect(testConfig.include).toContain('test/**/*');
    expect(readFileSync(join(pkg, '.github/workflows/atlas.yml'), 'utf8')).toContain(
      'npm run typecheck',
    );
  });

  describe('with an indexed and documented copy of fixtures/sample', () => {
    let root: string;
    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), 'atlas-audit4-'));
      dirs.push(root);
      cpSync(SAMPLE, root, { recursive: true });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await runCli(['index', root]);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.mocked(web.startServer).mockClear();
      process.exitCode = undefined;
    });

    const DELETED = 'src/shapes.ts';
    const lastJson = (): DriftReport => {
      const calls = vi.mocked(process.stdout.write).mock.calls;
      return JSON.parse(String(calls[calls.length - 1]![0])) as DriftReport;
    };
    const staleDeleted = (r: DriftReport) => r.stale.filter((s) => s.targetPath === DELETED);

    it('A4-03: `atlas serve` opens the index read-only', async () => {
      const dbPath = join(root, '.atlas', 'index.db');
      const bytes = readFileSync(dbPath);
      const signals = ['SIGINT', 'SIGTERM'] as const;
      const before = signals.map((s) => process.listeners(s));

      await runCli(['serve', '--port', '0', '--cwd', root]);
      const started = vi.mocked(web.startServer).mock;
      expect(started.calls).toHaveLength(1);
      const db = started.calls[0]![0];
      const handle = await started.results[0]!.value;
      try {
        expect(db.readonly).toBe(true);
        expect(() => db.prepare('DELETE FROM files').run()).toThrow(/readonly/);
        const res = await fetch(`${handle.url}api/stats`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { files: number }).files).toBeGreaterThan(0);
      } finally {
        await handle.close();
        closeDatabase(db);
        signals.forEach((s, i) => {
          for (const l of process.listeners(s)) {
            if (!before[i]!.includes(l)) process.removeListener(s, l);
          }
        });
      }
      expect(readFileSync(dbPath).equals(bytes)).toBe(true);
    });

    it('A4-04: runDrift (CLI and MCP) reports a pruned file as stale via its tombstone', async () => {
      await runCli(['docs', '--offline', '--cwd', root]);
      rmSync(join(root, DELETED));
      await runCli(['index', root]);

      await runCli(['drift', '--json', '--skip-architecture', '--cwd', root]);
      expect(process.exitCode).toBe(2);
      expect(staleDeleted(lastJson())).toEqual([
        expect.objectContaining({ kind: 'file', currentHash: 'missing' }),
      ]);

      const ctx = createMcpContext({ root, offline: true });
      try {
        const report = handleDriftTool(ctx, { skipArchitecture: true });
        expect(report.failing).toBe(true);
        expect(staleDeleted(report)).toEqual([
          expect.objectContaining({ kind: 'file', currentHash: 'missing' }),
        ]);
      } finally {
        closeDatabase(ctx.db);
      }
    });

    it('A4-08: drift reports the doc of a file deleted on disk but not yet re-indexed', async () => {
      await runCli(['docs', '--offline', '--cwd', root]);
      rmSync(join(root, DELETED));
      for (const args of [[], ['--docs-dir', '.atlas/docs']]) {
        process.exitCode = undefined;
        await runCli(['drift', '--json', '--skip-architecture', '--cwd', root, ...args]);
        expect(process.exitCode).toBe(2);
        expect(staleDeleted(lastJson())).toEqual([expect.objectContaining({ kind: 'file' })]);
      }
    });

    it('A4-05: the ask budget accepts a call that exactly fits and refuses one token less', async () => {
      const db = openDatabase(join(root, '.atlas', 'index.db'));
      dbs.push(db);
      const seen: LLMCallParams[] = [];
      const reserveOf = (p: LLMCallParams): number =>
        Math.ceil(
          ((p.system?.length ?? 0) + p.messages.reduce((n, m) => n + m.content.length, 0)) / 3,
        ) + p.maxTokens;
      const fake: LLMClient = {
        model: 'fake',
        complete: async (p) => {
          seen.push(p);
          const reserve = reserveOf(p);
          return { content: 'ok', inputTokens: reserve - p.maxTokens, outputTokens: p.maxTokens };
        },
      };
      const question = 'how is the area of a circle computed?';
      await ask(db, fake, root, question);
      const reserve = reserveOf(seen[0]!);
      seen.length = 0;

      const exact = new TokenBudget(reserve);
      await expect(ask(db, budgeted(fake, exact), root, question)).resolves.toMatchObject({
        answer: 'ok',
      });
      expect(seen).toHaveLength(1);
      expect(exact.remaining()).toBe(0);

      const short = new TokenBudget(reserve - 1);
      await expect(ask(db, budgeted(fake, short), root, question)).rejects.toThrow(
        /token budget exhausted/,
      );
      expect(seen).toHaveLength(1);

      const twice = new TokenBudget(2 * reserve - 1);
      const llm = budgeted(fake, twice);
      await ask(db, llm, root, question);
      expect(twice.remaining()).toBe(reserve - 1);
      await expect(ask(db, llm, root, question)).rejects.toThrow(/token budget exhausted/);
      expect(seen).toHaveLength(2);
    });
  });
});
