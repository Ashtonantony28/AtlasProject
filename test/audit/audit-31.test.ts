// AUDIT-31: API / SDK consistency, round 8 (CLI, HTTP, MCP, library exports). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-31.md (IDs
// A31-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. Plain `it` blocks pin what the audit found consistent: a missing index gives
// one refusal on every read surface; an empty index another process holds stops `atlas mcp` at
// startup with the CLI's `journal mode` message; SG90's reset works after a stopped `atlas mcp`.
//
// Processes run as `node --import tsx`, not through the `tsx` binary: the `tsx` wrapper relays
// SIGTERM/SIGINT to a child that exits through `process.exit`, which closes the index, so it hides
// A31-02. `node --import tsx` behaves like the built `dist/cli/index.js`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeDatabase } from '../../src/core/db/index.js';
import { openProjectIndex } from '../../src/core/project.js';
import {
  createMcpContext,
  handleIndexTool,
  handleSearchTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { startServer } from '../../src/web/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const NODE_ARGS = ['--import', 'tsx', CLI];
const REMEDY = '(another process is writing the index; retry when it finishes)';

const dirs: string[] = [];
const contexts: McpContext[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0)) await f();
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit31-'));
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
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');

async function indexed(extra?: string): Promise<string> {
  const root = sampleCopy();
  if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
  const r = await cli(['index', root]);
  expect(r.code, r.err).toBe(0);
  return root;
}

const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';

/** `atlas mcp` over stdio with the SDK client, as an editor runs it. */
async function stdioServer(
  root: string,
): Promise<{ client: Client; child: () => ChildProcess; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, 'mcp', '--offline', '--cwd', root],
    cwd: ROOT,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += String(d)));
  const client = new Client({ name: 'audit31', version: '0.0.0' });
  cleanup.push(() => client.close().catch(() => undefined));
  await client.connect(transport);
  return {
    client,
    child: () => (transport as unknown as { _process: ChildProcess })._process,
    stderr: () => stderr,
  };
}

/** Stops `atlas mcp` the way an editor or a terminal does, and waits for it to exit. */
async function stopWith(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  child.kill(signal);
  await exited;
}

/** A writer that committed and was SIGKILLed before checkpointing: its WAL stays beside the DB. */
function killedWriter(root: string): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
     const db = new D(${JSON.stringify(dbOf(root))});
     db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id");
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
  expect(statSync(`${dbOf(root)}-wal`).size).toBeGreaterThan(0);
}

/** Another process holding `dbPath`'s write lock for `holdMs`. */
async function holdLock(dbPath: string, holdMs: number): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
       const db = new D(${JSON.stringify(dbPath)}, { timeout: 5000 });
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cleanup.push(() => void child.kill());
  await new Promise<void>((ok) => child.stdout.once('data', () => ok()));
}

function integrity(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('integrity_check', { simple: true }) as string;
  } finally {
    db.close();
  }
}

describe('AUDIT-31 consistent surfaces (pinned)', () => {
  it('a deleted index (no process holding it) gives one refusal on every read command and on serve, creates nothing; atlas mcp says to call atlas_index', async () => {
    const root = await indexed();
    for (const f of readdirSync(join(root, '.atlas'))) {
      if (f.startsWith('index.db')) rmSync(join(root, '.atlas', f));
    }
    const refusal = `no index at ${dbOf(root)}: run \`atlas index\` first`;
    for (const args of [
      ['search', 'area', '--cwd', root],
      ['graph', '--cwd', root],
      ['drift', '--cwd', root],
      ['ask', '--offline', 'how?', '--cwd', root],
      ['docs', '--list', '--cwd', root],
    ]) {
      expect(await cli(args), args[0]).toEqual({ out: '', err: refusal, code: 1 });
    }
    expect(() => openProjectIndex(root, { readonly: true })).toThrow(refusal); // `atlas serve`
    expect(existsSync(dbOf(root))).toBe(false);

    const ctx = createMcpContext({ root, offline: true });
    contexts.push(ctx);
    await expect(handleSearchTool(ctx, { query: 'area' })).rejects.toThrow(
      'index is empty: call atlas_index first',
    );
  }, 30_000);

  it('SG90 over stdio: `atlas mcp` started while another process holds an empty index past the busy timeout exits 1 with the CLI’s journal-mode message', async () => {
    const root = sampleCopy();
    mkdirSync(join(root, '.atlas'));
    writeFileSync(dbOf(root), '');
    await holdLock(dbOf(root), 9_000);
    const r = spawnSync(process.execPath, [...NODE_ARGS, 'mcp', '--offline', '--cwd', root], {
      cwd: ROOT,
      encoding: 'utf8',
      input: '',
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe(`atlas: journal mode: database is locked ${REMEDY}`);
  }, 30_000);

  it('SG90: after `atlas mcp` is stopped by SIGTERM, `rm index.db && atlas index` gives a fresh healthy index that a new atlas mcp serves', async () => {
    const root = await indexed();
    const first = await stdioServer(root);
    await first.client.callTool({ name: 'atlas_index', arguments: { force: true } });
    await stopWith(first.child(), 'SIGTERM');
    rmSync(dbOf(root));
    appendFileSync(join(root, 'src', 'app.ts'), REPLACEMENT_FN);
    const r = cliProcess(['index', root]);
    expect(r.code, r.err).toBe(0);
    expect(integrity(dbOf(root))).toBe('ok');
    const second = await stdioServer(root);
    const res = (await second.client.callTool({
      name: 'atlas_symbol',
      arguments: { name: 'replacementOnlyFn' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/"name":"replacementOnlyFn"/);
  }, 60_000);
});

describe('AUDIT-31 findings', () => {
  it.fails(
    'A31-01: an index.db replaced beside a stale WAL is either used as is or refused with its cause; it is never silently mixed with the old WAL',
    async () => {
      const root = await indexed();
      const other = await indexed(REPLACEMENT_FN);
      killedWriter(root); // or Ctrl-C of `atlas index`, or SIGTERM of `atlas mcp` (A31-02)
      copyFileSync(dbOf(other), dbOf(root)); // restore a backup, copy another checkout's index
      const search = await cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
      const index = await cli(['index', root]);
      // Either the replacement is what the surfaces read, or every surface refuses it naming the
      // stale WAL and what to delete. Today search exits 0 with `add`, and index fails as below.
      expect(index.err).not.toBe('database disk image is malformed');
      expect(search.out).toMatch(/replacementOnlyFn/);
    },
    30_000,
  );

  it.fails(
    'A31-02: `atlas mcp` stopped by SIGTERM (or SIGINT) closes the index like `atlas serve` does, leaving no WAL and a complete index.db',
    async () => {
      const root = sampleCopy();
      const server = await stdioServer(root);
      await server.client.callTool({ name: 'atlas_index', arguments: {} });
      await stopWith(server.child(), 'SIGTERM');
      // Today: index.db is 4096 bytes and the whole index (~2 MB) is left in index.db-wal.
      expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
      expect(statSync(dbOf(root)).size).toBeGreaterThan(4096);
    },
    30_000,
  );

  it.fails(
    'A31-03: an index.db replaced (renamed into place) while atlas mcp runs is what the CLI then reads, and is not overwritten',
    async () => {
      const root = await indexed();
      const other = await indexed(REPLACEMENT_FN);
      const ctx = createMcpContext({ root, offline: true });
      contexts.push(ctx);
      await handleIndexTool(ctx, { force: true }); // the server's connection has written its WAL
      renameSync(dbOf(other), dbOf(root));
      const search = cliProcess(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
      expect(search.code, search.err).toBe(0);
      // Today the CLI reads the old index through the server's WAL (`Counter.increment`), and
      // its next write checkpoints the old pages over the replacement.
      expect(search.out).toMatch(/replacementOnlyFn/);
    },
    30_000,
  );

  it.fails(
    'A31-04: `atlas serve` on an empty (0-byte) index says the index is empty, as the CLI read commands do, not `no such table`',
    async () => {
      const root = sampleCopy();
      mkdirSync(join(root, '.atlas'));
      writeFileSync(dbOf(root), '');
      const { db } = openProjectIndex(root, { readonly: true });
      const handle = await startServer(db, root, { port: 0, host: '127.0.0.1' });
      cleanup.push(async () => {
        await handle.close();
        closeDatabase(db);
      });
      const health = await fetch(new URL('/api/health', handle.url));
      const stats = await fetch(new URL('/api/stats', handle.url));
      const body = (await stats.json()) as { error?: string };
      expect(health.status).toBe(200);
      // Today: 500 {"error":"no such table: files"} on every /api route but /api/health.
      expect(body.error ?? '').not.toMatch(/no such table/);
      expect(stats.status).not.toBe(500);
    },
    30_000,
  );
});
