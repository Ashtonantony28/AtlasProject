// AUDIT-37: API / SDK consistency, round 9 (CLI, HTTP, MCP, library exports). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-37.md (IDs
// A37-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. Plain `it` blocks pin what the audit found consistent: a leftover WAL the
// check cannot read (SG140) gives one refusal on the CLI, `atlas serve`, `atlas mcp` and the
// library, and the set-aside notices never reach stdout.
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. `ulimit -f` (with SIGXFSZ ignored) stands in for a full disk (AUDIT-34).
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleIndexTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { openProjectIndex } from '../../src/core/project.js';
import { startServer } from '../../src/web/server.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const NODE_ARGS = ['--import', 'tsx', CLI];
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';
const FULL_DISK = `trap '' XFSZ; ulimit -f 16; exec "$0" "$@"`;

const dirs: string[] = [];
const contexts: McpContext[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit37-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');
const aside = (root: string): string[] =>
  readdirSync(join(root, '.atlas')).filter((f) => f.includes('.foreign-'));

interface Run {
  out: string;
  err: string;
  code: number | null;
}

/** The real CLI in another process; `wrap` runs it under `bash -c` (e.g. a full disk). */
function cli(args: string[], wrap?: string): Run {
  const argv = [process.execPath, ...NODE_ARGS, ...args];
  const r = wrap
    ? spawnSync('bash', ['-c', wrap, ...argv], { cwd: ROOT, encoding: 'utf8' })
    : spawnSync(argv[0]!, argv.slice(1), { cwd: ROOT, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/** A copy of the sample (optionally with `extra` appended to src/app.ts), indexed and closed. */
function indexed(extra?: string): string {
  const root = join(tmp(), 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
  const r = cli(['index', root]);
  expect(r.code, r.err).toBe(0);
  return root;
}

/** A committed write SIGKILLed before any checkpoint: its WAL and -shm stay beside `dbPath`. */
function killedWriter(dbPath: string, checkpoint = false): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id");
     ${checkpoint ? "db.pragma('wal_checkpoint(PASSIVE)');" : ''}
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
}

/** A replaced index beside a killed writer's WAL, which the first read sets aside. */
function setAsideByRead(): { root: string; first: Run } {
  const root = indexed();
  const other = indexed(REPLACEMENT_FN);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(other), dbOf(root)); // restore a backup over an index after a crash
  const first = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
  expect(first.code, first.err).toBe(0);
  expect(first.err).toMatch(/does not belong to .*; moved it to .*-wal\.foreign-/);
  return { root, first };
}

/**
 * Starts `atlas mcp` over stdio with the SDK client (`wrap` runs it under `bash -c`). `error` is
 * what the client saw when the server did not start; `stderr` is the server's stderr either way.
 */
async function stdio(
  root: string,
  wrap?: string,
): Promise<{ client?: Client; error?: string; stderr: () => string }> {
  const argv = [process.execPath, ...NODE_ARGS, 'mcp', '--offline', '--cwd', root];
  const transport = new StdioClientTransport({
    command: wrap ? 'bash' : argv[0]!,
    args: wrap ? ['-c', wrap, ...argv] : argv.slice(1),
    cwd: ROOT,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += String(d)));
  const client = new Client({ name: 'audit37', version: '0.0.0' });
  cleanup.push(() => client.close().catch(() => undefined));
  try {
    await client.connect(transport);
  } catch (e) {
    await new Promise((ok) => setTimeout(ok, 200)); // let the last stderr chunk arrive
    return { error: (e as Error).message, stderr: () => stderr.trim() };
  }
  return { client, stderr: () => stderr.trim() };
}

/** Another process holding `<db>.open.lock`, as an opener checking a leftover WAL does. */
async function holdOpenLock(dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${BSQ});
       const lock = new D(${JSON.stringify(`${dbPath}.open.lock`)});
       lock.exec('BEGIN EXCLUSIVE');
       process.stdout.write('locked\\n');
       setInterval(() => lock.open, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cleanup.push(() => void child.kill('SIGKILL'));
  await new Promise<void>((ok) => child.stdout!.once('data', () => ok()));
  return child;
}

function text(res: unknown): { isError: boolean; text: string } {
  const r = res as { isError?: boolean; content?: { text?: string }[] };
  return { isError: r.isError ?? false, text: r.content?.[0]?.text ?? '' };
}

describe('AUDIT-37 consistent surfaces (pinned)', () => {
  it('SG140: a leftover WAL the check cannot read gives one refusal on the CLI (read and write, exit 1, stderr only), `atlas serve`, `atlas mcp` and the library; the WAL is kept', async () => {
    const root = indexed();
    killedWriter(dbOf(root));
    const db = dbOf(root);
    const msg =
      `atlas: index ${db}: cannot check ${db}-wal, left by a process that stopped ` +
      '(SQLITE_IOERR_SHMSIZE: disk I/O error); it is kept: free disk space (or fix the cause) ' +
      'and retry';
    for (const args of [
      ['search', 'add', '--cwd', root],
      ['index', root],
      ['drift', '--cwd', root, '--json'],
      ['serve', '--cwd', root, '--port', '0'],
    ]) {
      expect(cli(args, FULL_DISK), args[0]).toEqual({ out: '', err: msg, code: 1 });
    }
    // `atlas mcp` exits before the handshake, as for SG90's busy open (AUDIT-31).
    const mcp = await stdio(root, FULL_DISK);
    expect(mcp.client).toBeUndefined();
    expect(mcp.error).toMatch(/Connection closed/);
    expect(mcp.stderr()).toBe(msg);
    // The library throws the SqliteError with SQLite's code and the same text.
    const lib = join(tmp(), 'open.mts');
    writeFileSync(
      lib,
      `import { openDatabase } from ${JSON.stringify(join(ROOT, 'src/core/index.ts'))};
       import Database from ${JSON.stringify(require.resolve('better-sqlite3'))};
       try { openDatabase(${JSON.stringify(db)}); console.log('opened'); }
       catch (e) { console.log(JSON.stringify({ sqlite: e instanceof Database.SqliteError, code: e.code, message: e.message })); }`,
    );
    const r = spawnSync('bash', ['-c', FULL_DISK, process.execPath, '--import', 'tsx', lib], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(JSON.parse(r.stdout)).toEqual({
      sqlite: true,
      code: 'SQLITE_IOERR_SHMSIZE',
      message: msg.slice('atlas: '.length),
    });
    expect(existsSync(`${db}-wal`)).toBe(true);
    expect(aside(root)).toEqual([]);
    // Space is back: the killed writer's rows are there.
    const ok = cli(['search', 'add', '--cwd', root, '--limit', '1']);
    expect(ok.code, ok.err).toBe(0);
  }, 90_000);

  it('SG130: the set-aside notice and its reminder go to stderr only, so `--json` output stays parseable', () => {
    const { root } = setAsideByRead();
    const search = cli(['search', 'add', '--cwd', root, '--json', '--limit', '1']);
    expect(search.code, search.err).toBe(0);
    expect(search.err).toMatch(/was set aside from .*move it back to .*-wal before anything writes/);
    expect(JSON.parse(search.out)).toEqual([expect.objectContaining({ name: 'add' })]);
    const graph = cli(['graph', '--cwd', root, '--format', 'json', '--limit', '1']);
    expect(graph.code, graph.err).toBe(0);
    expect(graph.err).toMatch(/was set aside from/);
    expect(() => JSON.parse(graph.out) as unknown).not.toThrow();
  }, 60_000);
});

describe('AUDIT-37 findings', () => {
  it.fails(
    'A37-01: the set-aside reminder can be followed: a write command does not overtake it, MCP and HTTP report it, and moving the WAL back as it says is not refused',
    async () => {
      const { root } = setAsideByRead();
      // 1. `atlas index` prints "move it back … before anything writes the index", then writes.
      const index = cli(['index', root]);
      expect(index.err).toMatch(/was set aside from/);
      if (/before anything writes the index/.test(index.err)) expect(index.code).not.toBe(0);
      // 2. MCP and HTTP never say a WAL was set aside (stderr only).
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const ctx = createMcpContext({ root, offline: true });
      contexts.push(ctx);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createAtlasMcpServer(ctx).connect(a);
      const client = new Client({ name: 'a37', version: '0.0.0' });
      await client.connect(b);
      const mcp = text(await client.callTool({ name: 'atlas_index', arguments: {} }));
      await client.close();
      closeDatabase(ctx.db);
      const { db: ro } = openProjectIndex(root, { readonly: true });
      const handle = await startServer(ro, root, { port: 0, host: '127.0.0.1' });
      const health = await (await fetch(new URL('/api/health', handle.url))).text();
      await handle.close();
      closeDatabase(ro);
      vi.restoreAllMocks();
      expect(mcp.text).toMatch(/foreign/);
      expect(health).toMatch(/foreign/);
      // 3. Moving it back to `<db>-wal` before anything writes, as the reminder says, is refused
      //    as malformed, with a remedy that deletes the index.
      const fresh = setAsideByRead().root;
      const [name] = aside(fresh);
      renameSync(join(fresh, '.atlas', name!), `${dbOf(fresh)}-wal`);
      const after = cli(['search', 'add', '--cwd', fresh]);
      expect(after.err).not.toMatch(/unreadable/);
    },
    90_000,
  );

  it.fails(
    'A37-02: an index renamed over while another process holds the old one is refused with that cause and a remedy that keeps the replacement; once the holder stops, the replacement is what the CLI reads',
    async () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      const ctx = createMcpContext({ root, offline: true }); // a running `atlas mcp`
      contexts.push(ctx);
      await handleIndexTool(ctx, { force: true });
      renameSync(dbOf(other), dbOf(root));
      const held = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
      expect(held.code).toBe(1);
      expect(held.err).toMatch(/another process still has the replaced index open/);
      closeDatabase(ctx.db); // the user stops `atlas mcp` (a clean close)
      const stopped = cli(['search', 'replacementOnlyFn', '--cwd', root, '--limit', '1']);
      // Today: the refusal blames a WAL "it does not belong to" and says to delete the index (the
      // replacement); after the holder stops, its leftover WAL is judged the index's own and the
      // CLI answers from the OLD index with exit 0 (`Counter.increment`), checkpointing it in.
      expect(held.err).not.toMatch(/delete .* with its -wal and -shm/);
      expect(stopped.out).toMatch(/replacementOnlyFn/);
    },
    60_000,
  );

  it.fails(
    'A37-03: a read beside a leftover WAL that another opener is checking waits no longer than the busy timeout and names the check, not a writer',
    async () => {
      const root = indexed();
      killedWriter(dbOf(root));
      await holdOpenLock(dbOf(root));
      const t0 = Date.now();
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      const ms = Date.now() - t0;
      expect(r.code).toBe(1);
      // Today, after 60 s: `atlas: open: database is locked (another process is writing the
      // index; retry when it finishes)`.
      expect(r.err).not.toMatch(/is writing the index/);
      expect(ms).toBeLessThan(10_000);
    },
    120_000,
  );

  it.fails(
    'A37-04: where the README promises `MCP isError` for a refused leftover WAL, an MCP client gets an isError tool result naming it',
    async () => {
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const root = indexed();
      killedWriter(dbOf(root));
      const { client, error } = await stdio(root, FULL_DISK);
      const res = client
        ? text(await client.callTool({ name: 'atlas_search', arguments: { query: 'add' } }))
        : undefined;
      if (/MCP `isError`, HTTP 500/.test(readme)) {
        // Today: no tool result; the client sees `MCP error -32000: Connection closed`.
        expect(error).toBeUndefined();
        expect(res).toMatchObject({ isError: true, text: expect.stringMatching(/cannot check/) });
      }
    },
    60_000,
  );

  it.fails(
    'A37-05: the library throws every refused open as a SqliteError and leaves reporting a set-aside WAL to the caller (no writes to process.stderr)',
    () => {
      const root = indexed();
      const other = indexed(REPLACEMENT_FN);
      killedWriter(dbOf(root), true);
      copyFileSync(dbOf(other), dbOf(root));
      let thrown: unknown;
      try {
        openDatabase(dbOf(root)).close();
      } catch (e) {
        thrown = e;
      }
      expect((thrown as { code?: string }).code).toBe('SQLITE_CORRUPT');
      // Today: a plain Error with a copied code, unlike SQLite's own corruption and SG140's refusal.
      expect(thrown).toBeInstanceOf(Database.SqliteError);
      // And a set-aside WAL is written to process.stderr by `openDatabase` itself.
      const { root: moved } = setAsideByRead();
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      closeDatabase(openDatabase(dbOf(moved)));
      expect(write).not.toHaveBeenCalled();
    },
    60_000,
  );
});
