// AUDIT-19: API / SDK consistency, round 5 (CLI, HTTP, MCP). Each `it.fails` asserts the CORRECT
// behaviour and currently fails, reproducing one finding in AUDIT-19.md (IDs A19-xx). When a
// finding is fixed its test starts passing, `it.fails` turns red, and it should become a plain
// `it`. Plain `it` blocks pin what the audit found consistent: SG34 (joined index calls), SG40
// (config reload), SG50 (budget reservations, whole graph during a run), SG45 (run stamps) and the
// budget remedy on each surface.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  closeDatabase,
  counts,
  getLastRun,
  getLastRunStats,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { startServer, type ServeHandle } from '../../src/web/server.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleAskTool,
  handleDriftTool,
  handleGraphTool,
  handleIndexTool,
  handleSearchTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';
import { fakeAnthropic as startFake, message } from '../helpers/fakeAnthropic.js';

const dirs: string[] = [];
const contexts: McpContext[] = [];
const servers: Server[] = [];
const locks: Database.Database[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const l of locks.splice(0)) if (l.open) l.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(extraFiles = 0): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit19-'));
  dirs.push(d);
  const root = join(d, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  for (let i = 0; i < extraFiles; i++) {
    writeFileSync(
      join(root, 'src', `gen${i}.ts`),
      `import { add } from './math';\nexport function g${i}(x: number) { return add(x, ${i}); }\nexport class K${i} { run() { return g${i}(1); } }\n`,
    );
  }
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

async function indexed(extraFiles = 0): Promise<string> {
  const root = sampleCopy(extraFiles);
  expect((await cli(['index', root])).code).toBe(0);
  return root;
}

function mcp(root: string, offline = true): McpContext {
  const ctx = createMcpContext({ root, offline });
  contexts.push(ctx);
  return ctx;
}

function editConfig(root: string, patch: Record<string, unknown>): void {
  const p = join(root, '.atlas', 'config.json');
  const cfg = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as object) : { version: 1 };
  writeFileSync(p, JSON.stringify({ ...cfg, ...patch }));
}

function holdIndexLock(root: string): Database.Database {
  const lock = new Database(join(root, '.atlas', 'index.db.lock'));
  lock.exec('BEGIN EXCLUSIVE');
  locks.push(lock);
  return lock;
}

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit19', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  return client;
}

async function serve(root: string): Promise<{ handle: ServeHandle; db: DB }> {
  const db = openDatabase(join(root, '.atlas', 'index.db'), {
    readonly: true,
    fileMustExist: true,
  });
  const handle = await startServer(db, root, { port: 0 });
  return { handle, db };
}

const runCount = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
const vectorCount = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM embeddings_meta').get() as { c: number }).c;
const text = (r: Record<string, unknown>): string =>
  (r['content'] as Array<{ text: string }> | undefined)?.[0]?.text ?? '';

/** Calls `read` at every event-loop turn (each of the run's yields) until `run` settles. */
async function duringRun<T, S>(
  run: Promise<S>,
  read: () => T | Promise<T>,
): Promise<{ stats: S; seen: T[] }> {
  let done = false;
  const tracked = run.finally(() => (done = true));
  const seen: T[] = [];
  while (!done) {
    await new Promise(setImmediate);
    if (!done) seen.push(await read());
  }
  return { stats: await tracked, seen };
}

async function fakeAnthropic(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
) {
  const fake = await startFake(reply);
  servers.push(fake.server);
  vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  return fake;
}

const EXHAUSTED_DETAIL =
  /token budget exhausted: a call needs ~\d+ tokens \(~\d+ prompt \+ 1024 output\), \d+ of \d+ left/;

describe('AUDIT-19 consistent surfaces (pinned)', () => {
  it('SG34: index calls queued together over the SDK share one run and one stats object; a forced call does not join', async () => {
    const root = await indexed();
    appendFileSync(
      join(root, 'src', 'math.ts'),
      '\nexport function cube(x: number) { return x * x * x; }\n',
    );
    const ctx = mcp(root);
    const before = runCount(ctx.db);
    const client = await linkedClient(ctx);
    try {
      const res = await Promise.all(
        [{}, {}, {}, { force: true }].map((args) =>
          client.callTool({ name: 'atlas_index', arguments: args }),
        ),
      );
      const [a, b, c, forced] = res.map((r) => JSON.parse(text(r)) as Record<string, unknown>);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(a).toMatchObject({ filesIndexed: 1, resolveReason: 'files changed' });
      expect(forced).toMatchObject({ filesIndexed: 4, resolveReason: 'forced' });
      expect(runCount(ctx.db) - before).toBe(2);
    } finally {
      await client.close();
    }
    // The CLI (its own process, no joining) then sees nothing to do.
    expect((await cli(['index', root])).out).toMatch(/\(graph unchanged\)/);
  });

  it('SG34 + A15-02: retries while another process holds the lock coalesce into at most two runs', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    const lock = holdIndexLock(root);
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      calls.push(handleIndexTool(ctx, {}));
      await new Promise((r) => setTimeout(r, 30));
    }
    const before = runCount(ctx.db);
    lock.close();
    const stats = await Promise.all(calls);
    expect(runCount(ctx.db) - before).toBe(2);
    expect(stats[1]).toBe(stats[4]); // calls 2..5 joined the run queued behind the waiting one
    expect(stats[0]).not.toBe(stats[1]);
  });

  it('SG40: an invalid config fails CLI search, atlas_ask and atlas_index with one message; an indexPath move fails ask and index alike', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    editConfig(root, { tokenBudget: -5 });
    const invalid =
      /^Invalid config at .*config\.json:\n {2}- tokenBudget: Number must be greater than 0$/;
    expect((await cli(['search', 'area', '--cwd', root])).err).toMatch(invalid);
    await expect(handleAskTool(ctx, { question: 'area' })).rejects.toThrow(invalid);
    await expect(handleIndexTool(ctx, {})).rejects.toThrow(invalid);
    expect(ctx.config.tokenBudget).toBe(200_000); // a failed reload leaves the session config alone

    editConfig(root, { tokenBudget: 200_000, indexPath: '.atlas/other.db' });
    const moved =
      /^indexPath changed to '\.atlas\/other\.db' after atlas mcp started; restart the server to use it \(still serving .*index\.db\)$/;
    await expect(handleAskTool(ctx, { question: 'area' })).rejects.toThrow(moved);
    await expect(handleIndexTool(ctx, {})).rejects.toThrow(moved);
    expect((await cli(['search', 'area', '--cwd', root])).err).toMatch(
      /^no index at .*other\.db: run `atlas index` first$/,
    );
  });

  it('BudgetExhaustedError: docs, docs --budget, ask and atlas_ask give one detail and the remedy that works there', async () => {
    const root = await indexed();
    const docsFlag = await cli(['docs', '--offline', '--budget', '1000', '--cwd', root]);
    expect(docsFlag.code).toBe(1);
    expect(docsFlag.err).toMatch(new RegExp(`^${EXHAUSTED_DETAIL.source}; raise --budget$`));
    editConfig(root, { tokenBudget: 1000 });
    const docs = await cli(['docs', '--offline', '--cwd', root]);
    const ask = await cli(['ask', '--offline', '--cwd', root, 'circle area']);
    expect([docs.code, ask.code]).toEqual([1, 1]);
    const fromConfig = new RegExp(
      `^${EXHAUSTED_DETAIL.source.replace('\\d+ of \\d+', '1000 of 1000')}; raise tokenBudget$`,
    );
    expect(docs.err).toMatch(fromConfig);
    expect(ask.err).toMatch(fromConfig);
    const ctx = mcp(root);
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(fromConfig);
    editConfig(root, { tokenBudget: 200_000 }); // the remedy works mid-session (A15-01 stays fixed)
    expect((await handleAskTool(ctx, { question: 'circle area' })).answer).toMatch(/Circle\.area/);
  });

  it('SG50: one atlas_ask at a time sends the max_tokens the CLI sends; parallel ones are capped by reservations', async () => {
    const root = await indexed();
    editConfig(root, { tokenBudget: 40_000 });
    const fake = await fakeAnthropic((body) =>
      message(body, {
        content: [{ type: 'text', text: 'Circle.area [1]' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 700, output_tokens: 50 },
      }),
    );
    expect((await cli(['ask', '--cwd', root, 'circle area'])).code).toBe(0);
    const ctx = mcp(root, false);
    await handleAskTool(ctx, { question: 'circle area' });
    const [fromCli, fromMcp] = fake.bodies.map((b) => b['max_tokens']);
    expect(fromMcp).toBe(fromCli);
    fake.bodies.length = 0;
    await Promise.all([1, 2, 3].map(() => handleAskTool(ctx, { question: 'circle area' })));
    const parallel = fake.bodies.map((b) => b['max_tokens'] as number);
    expect(parallel.slice(0, 2)).toEqual([fromCli, fromCli]);
    expect(parallel[2]).toBeLessThan(fromCli as number); // A19-01: the third gets what the first two left
    expect(ctx.budget.total().spent).toBeLessThanOrEqual(40_000); // A17-02 stays fixed
  });

  it('SG50/SG45: during a forced atlas_index, graph, drift, /api/stats and the last finished run look as before at every yield', async () => {
    const root = await indexed(40);
    expect((await cli(['docs', '--offline', '--cwd', root])).code).toBe(0);
    const ctx = mcp(root);
    const { handle, db } = await serve(root);
    try {
      const snapshot = async () => ({
        counts: counts(ctx.db),
        graphEdges: (
          handleGraphTool(ctx, { limit: 1000, edgeLimit: 10000 }) as { edges: unknown[] }
        ).edges.length,
        drift: handleDriftTool(ctx, {}).totals,
        http: (await (await fetch(`${handle.url}api/stats`)).json()) as unknown,
        lastFinished: getLastRunStats(ctx.db).resolveReason,
      });
      const before = await snapshot();
      const { stats, seen } = await duringRun(handleIndexTool(ctx, { force: true }), snapshot);
      expect(stats.resolveReason).toBe('forced');
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) {
        expect(s.counts).toEqual(before.counts);
        expect(s.graphEdges).toBe(before.graphEdges);
        expect(s.drift).toEqual(before.drift);
        expect(s.http).toEqual(before.http);
        expect([before.lastFinished, 'forced']).toContain(s.lastFinished);
      }
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });
});

describe('AUDIT-19 findings', () => {
  it.fails(
    'A19-01: a parallel atlas_ask refused for in-flight reservations does not claim the budget is spent',
    async () => {
      const root = await indexed();
      editConfig(root, { tokenBudget: 20_000 });
      const ctx = mcp(root);
      const settled = await Promise.allSettled(
        [1, 2, 3].map(() => handleAskTool(ctx, { question: 'circle area' })),
      );
      const refused = settled.flatMap((r) =>
        r.status === 'rejected' ? [String((r.reason as Error).message)] : [],
      );
      // Three sequential asks spend ~1.9k of 20k; the third parallel one is refused with "0 of 20000 left; raise tokenBudget".
      expect(ctx.budget.total().spent).toBeLessThan(2_000);
      for (const m of refused) expect(m).not.toMatch(/ 0 of 20000 left; raise tokenBudget$/);
    },
  );

  it.fails(
    'A19-02: MCP read tools follow config edits like atlas_ask, atlas_index and the CLI',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      editConfig(root, { indexPath: '.atlas/other.db' });
      await expect(handleAskTool(ctx, { question: 'area' })).rejects.toThrow(/restart the server/);
      // atlas_search keeps answering from the old file, which nothing will update any more.
      await expect(handleSearchTool(ctx, { query: 'area', limit: 1 })).rejects.toThrow(
        /indexPath changed|restart the server/,
      );
    },
  );

  it.fails(
    'A19-03: semantic search keeps its vectors while a forced atlas_index re-parses files',
    async () => {
      const root = await indexed(20);
      const ctx = mcp(root);
      const before = vectorCount(ctx.db);
      const { seen } = await duringRun(handleIndexTool(ctx, { force: true }), () =>
        vectorCount(ctx.db),
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(Math.min(...seen)).toBe(before); // drops to 0 after the parse loop, until the embed phase
    },
  );

  it.fails('A19-04: the README documents the SG34/SG40/SG50 MCP behaviour', () => {
    const readme = readFileSync(join(__dirname, '../../README.md'), 'utf8');
    expect(readme).toMatch(/restart/); // a changed indexPath needs a server restart
    expect(readme).toMatch(/in[- ]flight|reserv/); // parallel atlas_ask calls reserve their maximum
    expect(readme).toMatch(/re-?reads?.*config|config.*re-?read/is); // which tools re-read the config
  });

  it.fails(
    'A19-05: getLastRun keeps its pre-SG45 shape: an unfinished run has no stats_json',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      const { seen } = await duringRun(handleIndexTool(ctx, {}), () => getLastRun(ctx.db));
      const unfinished = seen.filter((r) => r?.finished_at === null);
      expect(unfinished.length).toBeGreaterThan(0);
      for (const r of unfinished) expect(r?.stats_json).toBeNull(); // now '{"state":{"extractorVersion":3}}'
    },
  );
});
