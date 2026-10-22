// AUDIT-24: test coverage, round 6 (SG65, SG55, SG50). Plain `it` tests pin behaviour that is
// correct today but that a surviving mutation showed no other test checks (the mutant IDs are in
// each test name; AUDIT-24.md has the diffs). Each `it.fails` asserts the correct behaviour and
// currently fails, reproducing one finding in AUDIT-24.md (IDs A24-xx); when it is fixed it turns
// red and should become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  MIGRATIONS,
  nameBusy,
  openDatabase,
  type DB,
  type SymbolRow,
} from '../../src/core/db/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { buildSymbolText, createEmbedder, embedAllSymbols } from '../../src/core/vector/index.js';
import { createMcpContext, type McpContext } from '../../src/mcp/server.js';
import { makeGitRepo, runCli } from '../cli/helpers.js';

// Another process creating the index between this one's `existsSync` and its link into place:
// when the temporary file for `race.dbPath` is opened, `race.dbPath` is created first, in WAL
// mode, with a `marker` table, as a racing `atlas` process would.
const race = vi.hoisted(() => ({ dbPath: null as string | null }));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default;
  class Racing extends Real {
    constructor(path: string, opts?: Database.Options) {
      const target = race.dbPath;
      if (target !== null && path.startsWith(`${target}.`) && path.endsWith('.tmp')) {
        race.dbPath = null;
        const other = new Real(target);
        other.pragma('journal_mode = WAL');
        other.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('first')");
        other.close();
      }
      super(path, opts);
    }
  }
  return { default: Racing };
});

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  race.dbPath = null;
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0)) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-a24-'));
  dirs.push(d);
  return d;
}

function open(path: string): DB {
  const db = openDatabase(path);
  cleanup.push(() => db.open && closeDatabase(db));
  return db;
}

/** Another process holding the write lock (`BEGIN IMMEDIATE`) of the WAL index `path` for `ms`. */
async function holdWriteLock(path: string, ms: number): Promise<void> {
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
       const db = new D(${JSON.stringify(path)});
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${ms});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cleanup.push(() => holder.kill());
  await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
}

describe('AUDIT-24 SG65 creating a fresh index', () => {
  it('D04/D05: an index another process creates first is opened as it is, not replaced', () => {
    const dir = tmp();
    const path = join(dir, 'index.db');
    race.dbPath = path;
    const db = open(path);
    expect(race.dbPath).toBeNull(); // the race happened
    // The other process's file is kept (link fails with EEXIST), then migrated as usual.
    expect(db.prepare('SELECT v FROM marker').pluck().all()).toEqual(['first']);
    expect(db.prepare('SELECT MAX(version) FROM _migrations').pluck().get()).toBe(LATEST);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(readdirSync(dir).filter((f) => !/^index\.db(-wal|-shm)?$/.test(f))).toEqual([]);
  });

  it('D07: an in-memory index creates no file (no `:memory:` in the cwd)', () => {
    const dir = tmp();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      closeDatabase(openDatabase(':memory:'));
    } finally {
      process.chdir(cwd);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('AUDIT-24 SG65 naming SQLITE_BUSY', () => {
  it('D13/D14: every SQLITE_BUSY code is named, and other errors are left as they are', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY']) {
      const err = new Database.SqliteError('database is locked', code);
      nameBusy(err, 'migrations');
      expect(err.message, code).toBe(
        'migrations: database is locked (another process is writing the index; retry when it finishes)',
      );
    }
    const other = new Database.SqliteError('UNIQUE constraint failed: t.v', 'SQLITE_CONSTRAINT');
    nameBusy(other, 'index write');
    expect(other.message).toBe('UNIQUE constraint failed: t.v');
    const plain = new Error('database is locked');
    nameBusy(plain, 'index write');
    expect(plain.message).toBe('database is locked');
  });

  it('A24-01: `atlas docs` that outwaits the busy timeout names the step that got SQLITE_BUSY', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = makeGitRepo('atlas-a24-');
    dirs.push(dir);
    await runCli(['index', dir]);
    // Another process (here a stand-in for a long `atlas index` resolve) holds the write lock
    // longer than the 5 s busy wait.
    await holdWriteLock(join(dir, '.atlas', 'index.db'), 8000);
    const t0 = Date.now();
    const err = await runCli(['docs', '--offline', '--cwd', dir]).then(
      () => null,
      (e: Error) => e,
    );
    expect(Date.now() - t0).toBeGreaterThan(4500);
    expect(err?.message).toMatch(
      /^docs write: database is locked \(another process is writing the index; retry when it finishes\)$/,
    );
  }, 30_000);
});

describe('AUDIT-24 SG55 embedding text', () => {
  it('V06: two sources of the same length are each sliced from their own lines', () => {
    const sym = {
      id: 1,
      file_id: 1,
      kind: 'function',
      name: 'f',
      qualified_name: 'f',
      signature: null,
      docstring: null,
      start_line: 1,
      end_line: 1,
      exported: 1,
    } as unknown as SymbolRow;
    const a = 'alpha();\nshared tail\n';
    const b = 'bravo();\nshared tail\n';
    expect(a.length).toBe(b.length);
    expect(buildSymbolText(sym, { path: 'a.ts' }, a)).toBe('function: f\nfile: a.ts\nalpha();');
    expect(buildSymbolText(sym, { path: 'b.ts' }, b)).toBe('function: f\nfile: b.ts\nbravo();');
  });
});

describe('AUDIT-24 SG55 embed yields', () => {
  it('V03/V04: the embed loop yields about every 50 ms, not after every batch', async () => {
    const root = join(tmp(), 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(root, 'src', `m${i}.ts`),
        Array.from(
          { length: 30 },
          (_, k) => `export function f${i}_${k}(): number {\n  return ${k};\n}\n`,
        ).join(''),
      );
    }
    const db = open(join(root, '..', 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
    let turns = 0;
    let ticking = true;
    const tick = (): void => {
      turns++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const t0 = Date.now();
    // One symbol per batch: 600 batches.
    const stats = await embedAllSymbols(db, createEmbedder(DEFAULT_CONFIG), root, { batchSize: 1 });
    const ms = Date.now() - t0;
    ticking = false;
    expect(stats.generated).toBe(600);
    // About one turn per 50 ms (plus slack), never one per batch.
    expect(turns).toBeLessThan(Math.max(20, ms / 10));
    expect(turns).toBeLessThan(150);
  });
});

describe('AUDIT-24 SG55 refusals under in-flight reservations', () => {
  it('V08–V11: "retry when they finish" only when a retry could be paid; otherwise "raise tokenBudget"', async () => {
    const root = tmp();
    mkdirSync(join(root, '.atlas'));
    writeFileSync(
      join(root, '.atlas', 'config.json'),
      JSON.stringify({ version: 1, tokenBudget: 20_000 }),
    );
    const gates: (() => void)[] = [];
    const ctx: McpContext = createMcpContext({
      root,
      llm: {
        model: 'gated',
        complete: async () => {
          await new Promise<void>((r) => gates.push(r));
          return { content: 'ok', inputTokens: 10, outputTokens: 10, stopReason: 'end_turn' };
        },
      },
    });
    cleanup.push(() => closeDatabase(ctx.db));
    const llm = await ctx.llm();
    const ask = (chars: number) =>
      llm
        .complete({ messages: [{ role: 'user', content: 'x'.repeat(chars) }], maxTokens: 16_000 })
        .then(
          () => 'ran',
          (e: Error) => e.message,
        );
    // Holds 1 prompt + 16,000 output tokens until released.
    const first = ask(1);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // ~3,000 prompt tokens: refused now (3,999 left), affordable once the first call settles.
    expect(await ask(9_000)).toBe(
      'token budget exhausted: a call needs ~4024 tokens (~3000 prompt + 1024 output), 3999 of 20000 left, 16001 tokens reserved by calls in progress; retry when they finish',
    );
    // ~20,000 prompt tokens: no retry can pay it.
    expect(await ask(60_000)).toBe(
      'token budget exhausted: a call needs ~21024 tokens (~20000 prompt + 1024 output), 20000 of 20000 left; raise tokenBudget',
    );
    gates.forEach((g) => g());
    expect(await first).toBe('ran');
    expect(ctx.budget.total().spent).toBe(20);
  });
});
