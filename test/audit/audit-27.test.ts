// AUDIT-27: API / SDK consistency, round 7 (CLI, HTTP, MCP, library exports). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-27.md (IDs
// A27-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. Plain `it` blocks pin what the audit found consistent: SG80 (one busy message
// with its remedy on `atlas index`, `atlas docs` and atlas_index; index and docs wait out a writer's
// short gaps), SG90 (an empty index another process holds is waited out for 5 s; a killed run is
// recovered by re-running `atlas index` or by deleting `index.db`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as core from '../../src/core/index.js';
import { closeDatabase, nameBusy, openDatabase } from '../../src/core/db/index.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleIndexTool,
  handleSearchTool,
  handleSymbolTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli/index.ts');
const REMEDY = '(another process is writing the index; retry when it finishes)';

const dirs: string[] = [];
const contexts: McpContext[] = [];
const cleanup: (() => void)[] = [];

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0)) f();
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit27-'));
  dirs.push(d);
  const root = join(d, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  return root;
}

async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  let thrown: unknown;
  try {
    await runCli(args);
  } catch (e) {
    thrown = e;
  } finally {
    vi.restoreAllMocks();
  }
  if (thrown) err.push(thrown instanceof Error ? thrown.message : String(thrown));
  const code = thrown ? 1 : typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { out: out.join(''), err: err.join(''), code };
}

/** The real CLI in another process, as a user runs it beside a running `atlas mcp`. */
function cliProcess(args: string[]): { out: string; err: string; code: number | null } {
  const r = spawnSync(TSX, [CLI, ...args], { encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

async function indexed(): Promise<string> {
  const root = sampleCopy();
  expect((await cli(['index', root])).code).toBe(0);
  return root;
}

function mcp(root: string): McpContext {
  const ctx = createMcpContext({ root, offline: true });
  contexts.push(ctx);
  return ctx;
}

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit27', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  cleanup.push(() => void client.close());
  return client;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');

/**
 * Another process holding `dbPath`'s write lock (`BEGIN IMMEDIATE`): for `holdMs` at a time,
 * released for `gapMs` between holds (as `atlas docs` does), until `totalMs` has passed.
 */
async function writer(dbPath: string, holdMs: number, totalMs: number, gapMs = 0): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
       const db = new D(${JSON.stringify(dbPath)}, { timeout: 5000 });
       const end = Date.now() + ${totalMs};
       let first = true;
       (function cycle() {
         if (Date.now() > end) { db.close(); return; }
         db.exec('BEGIN IMMEDIATE');
         if (first) { process.stdout.write('locked\\n'); first = false; }
         setTimeout(() => { db.exec('COMMIT'); ${gapMs} ? setTimeout(cycle, ${gapMs}) : db.close(); }, ${holdMs});
       })();`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cleanup.push(() => child.kill());
  await new Promise<void>((ok) => child.stdout.once('data', () => ok()));
}

describe('AUDIT-27 consistent surfaces (pinned)', () => {
  it('SG80: a lock held past the busy timeout gives one named message with its remedy on `atlas index` (exit 1), `atlas docs` (exit 1) and atlas_index (isError); reads answer', async () => {
    const root = await indexed();
    expect((await cli(['docs', '--offline', '--cwd', root])).code).toBe(0);
    const ctx = mcp(root);
    const client = await linkedClient(ctx);
    await writer(dbOf(root), 20_000, 20_000);

    const t0 = Date.now();
    expect((await cli(['search', 'area', '--cwd', root, '--json'])).code).toBe(0);
    expect((await cli(['drift', '--cwd', root])).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2_000);

    const index = await cli(['index', '--force', root]);
    const docs = await cli(['docs', '--offline', '--force', '--cwd', root]);
    const res = await client.callTool({ name: 'atlas_index', arguments: { force: true } });
    expect(index).toEqual({ out: '', err: `run stamp: database is locked ${REMEDY}`, code: 1 });
    expect(docs).toEqual({ out: '', err: `docs write: database is locked ${REMEDY}`, code: 1 });
    expect(res).toEqual({
      content: [{ type: 'text', text: `run stamp: database is locked ${REMEDY}` }],
      isError: true,
    });
  }, 40_000);

  it('SG80: `atlas docs` and atlas_index wait out a writer that holds the lock for 1 s at a time', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    await writer(dbOf(root), 1_000, 7_000, 20);
    const docs = await cli(['docs', '--offline', '--force', '--cwd', root]);
    expect(docs.code, docs.err).toBe(0);
    const stats = await handleIndexTool(ctx, { force: true });
    expect(stats.filesIndexed).toBe(4);
  }, 30_000);

  it('SG90: an empty index file another process holds is waited out for the 5 s busy timeout, then named with the remedy', async () => {
    const root = sampleCopy();
    mkdirSync(join(root, '.atlas'));
    writeFileSync(dbOf(root), '');
    await writer(dbOf(root), 1_500, 1_500);
    const short = await cli(['index', root]);
    expect(short.code, short.err).toBe(0);

    const held = sampleCopy();
    mkdirSync(join(held, '.atlas'));
    writeFileSync(dbOf(held), '');
    await writer(dbOf(held), 12_000, 12_000);
    const t0 = Date.now();
    const long = await cli(['index', held]);
    const waited = Date.now() - t0;
    expect(long).toMatchObject({ code: 1, err: `journal mode: database is locked ${REMEDY}` });
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(7_000);
  }, 30_000);

  it('SG90/SG33: after a killed run, re-running `atlas index` says so and recovers; deleting index.db gives a fresh healthy index', async () => {
    const killed = async (root: string): Promise<void> => {
      // A run that stamped its start and was killed before it finished, leaving its WAL.
      const r = spawnSync(process.execPath, [
        '-e',
        `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
         const db = new D(${JSON.stringify(dbOf(root))});
         db.prepare('INSERT INTO runs (commit_sha, started_at) VALUES (NULL, ?)').run(new Date().toISOString());
         process.kill(process.pid, 'SIGKILL');`,
      ]);
      expect(r.signal).toBe('SIGKILL');
      expect(existsSync(`${dbOf(root)}-wal`)).toBe(true);
    };
    const rerun = await indexed();
    await killed(rerun);
    const again = await cli(['index', rerun]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/after an interrupted run/);

    const reset = await indexed();
    await killed(reset);
    rmSync(dbOf(reset));
    const fresh = await cli(['index', reset]);
    expect(fresh.code, fresh.err).toBe(0);
    const db = new Database(dbOf(reset), { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare('SELECT COUNT(*) FROM runs WHERE finished_at IS NULL').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM files').pluck().get()).toBe(4);
    } finally {
      db.close();
    }
  }, 30_000);

  it('SG80: nameBusy names an error once, so a step named inside another keeps its own name', () => {
    expect(core.nameBusy).toBe(nameBusy);
    const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    nameBusy(err, 'index write');
    nameBusy(err, 'run stamp');
    expect(err.message).toBe(`index write: database is locked ${REMEDY}`);
  });
});

describe('AUDIT-27 findings', () => {
  it.fails(
    'A27-01: deleting index.db while `atlas mcp` has written to it, then `atlas index`, gives a fresh index (or names the cause and remedy)',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      await handleIndexTool(ctx, { force: true }); // the server's connection has written its WAL
      rmSync(dbOf(root));
      const r = cliProcess(['index', root]);
      expect(r.err).not.toBe('atlas: disk I/O error');
      expect(r.code, r.err).toBe(0);
    },
    30_000,
  );

  it.fails(
    'A27-02: after the index is deleted and rebuilt on the CLI, a running atlas mcp answers from the new index or says to restart',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      await handleIndexTool(ctx, {});
      for (const f of readdirSync(join(root, '.atlas'))) {
        if (f.startsWith('index.db')) rmSync(join(root, '.atlas', f));
      }
      appendFileSync(join(root, 'src', 'app.ts'), '\nexport function brandNewFn(): number { return 1; }\n');
      const r = cliProcess(['index', root]);
      expect(r.code, r.err).toBe(0);
      expect(cliProcess(['search', 'brandNewFn', '--cwd', root, '--limit', '1']).out).toMatch(
        /brandNewFn/,
      );
      let answer: unknown;
      try {
        answer = handleSymbolTool(ctx, { name: 'brandNewFn' });
      } catch (err) {
        answer = (err as Error).message;
      }
      // Either the new symbol, or an error that says the index changed under the server.
      expect(answer).not.toEqual([]);
    },
    30_000,
  );

  it.fails(
    'A27-03: while atlas_index waits for another process’s write lock, the MCP server still answers atlas_search promptly',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      await writer(dbOf(root), 8_000, 8_000);
      const t0 = Date.now();
      const run = handleIndexTool(ctx, { force: true }).catch((e: unknown) => e);
      const searched = new Promise<number>((ok) =>
        setTimeout(() => {
          void handleSearchTool(ctx, { query: 'area', limit: 1 }).then(() => ok(Date.now() - t0));
        }, 300),
      );
      const ms = await searched;
      await run;
      expect(ms).toBeLessThan(1_500);
    },
    30_000,
  );

  it.fails(
    'A27-04: the exported write helpers name a busy error with its remedy, and `immediate` is exported beside nameBusy',
    async () => {
      const root = await indexed();
      const db = openDatabase(dbOf(root), { fileMustExist: true });
      cleanup.push(() => closeDatabase(db));
      await writer(dbOf(root), 8_000, 8_000);
      let message = '';
      try {
        core.upsertDoc(db, { target_kind: 'file', target_id: 1, content: 'x', source_hash: 'h' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/database is locked/);
      expect(message.endsWith(REMEDY)).toBe(true);
      expect('immediate' in core).toBe(true);
    },
    30_000,
  );

  it('A27-05: the README says what to do after a crash and how to reset the index safely', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/interrupted|crash|killed/i);
    expect(readme).toMatch(/index\.db-wal|stop `?atlas (mcp|serve)/);
  });
});
