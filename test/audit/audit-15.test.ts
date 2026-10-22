// AUDIT-15: API / SDK consistency, round 4 (CLI, HTTP, MCP, dashboard, Anthropic client).
// Each `it.fails` asserts the CORRECT behaviour and currently fails, reproducing one
// finding in AUDIT-15.md (IDs A15-xx). When a finding is fixed its test starts passing,
// `it.fails` turns red, and it should become a plain `it`. Plain `it` blocks pin
// behaviour the audit found consistent (SG28, SG29, SG31, SG32, SG33 and the AUDIT-11 fixes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, counts, openDatabase } from '../../src/core/db/index.js';
import { acquireIndexLock } from '../../src/core/ingest/lock.js';
import { EXTRACTOR_VERSION } from '../../src/core/parse/version.js';
import { startServer } from '../../src/web/server.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleAskTool,
  handleDriftTool,
  handleGraphTool,
  handleIndexTool,
  handleSearchTool,
  handleSymbolTool,
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

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit15-'));
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

async function indexed(): Promise<string> {
  const root = sampleCopy();
  await cli(['index', root]);
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

/** Another process's run, as SG32 sees it: an exclusive SQLite lock on `<db>.lock`. */
function holdIndexLock(root: string): Database.Database {
  const lock = new Database(join(root, '.atlas', 'index.db.lock'));
  lock.exec('BEGIN EXCLUSIVE');
  locks.push(lock);
  return lock;
}

/** Make the last finished run look as if an older extractor wrote the index. */
function setRecordedExtractorVersion(root: string, version: number): void {
  const db = openDatabase(join(root, '.atlas', 'index.db'));
  try {
    const row = db
      .prepare('SELECT id, stats_json FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as { id: number; stats_json: string };
    const stats = JSON.parse(row.stats_json) as { state: Record<string, unknown> };
    stats.state.extractorVersion = version;
    db.prepare('UPDATE runs SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), row.id);
  } finally {
    closeDatabase(db);
  }
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

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit15', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  return client;
}

async function httpJson(root: string, path: string): Promise<unknown> {
  const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
  const handle = await startServer(db, root, { port: 0 });
  try {
    return (await (await fetch(`${handle.url}${path}`)).json()) as unknown;
  } finally {
    await handle.close();
    closeDatabase(db);
  }
}

const DESTRUCTURED = [
  'function NextAuth(c: object) { return { auth: () => c, handlers: { GET: () => 1 } }; }',
  'export const { auth, handlers: routes } = NextAuth({});',
  'export const [first, ...rest] = [1, 2, 3];',
  '',
].join('\n');

describe('AUDIT-15 consistent surfaces (pinned)', () => {
  it('SG31: destructured symbols agree on search, symbol, graph, docs and drift across CLI, HTTP and MCP', async () => {
    const root = sampleCopy();
    writeFileSync(join(root, 'src', 'auth.ts'), DESTRUCTURED);
    writeFileSync(
      join(root, 'src', 'use.ts'),
      "import { auth } from './auth';\nexport function whoami() { return auth(); }\n",
    );
    expect((await cli(['index', root])).code).toBe(0);
    const names = ['auth', 'routes', 'first', 'rest'];
    const ctx = mcp(root);

    type Hit = { name: string; kind: string; file: string };
    const pick = (hits: Hit[]) =>
      hits.filter((h) => names.includes(h.name)).map((h) => `${h.kind} ${h.name} ${h.file}`).sort();
    const cliHits = JSON.parse(
      (await cli(['search', 'auth routes first rest', '--kind', 'variable', '--limit', '50', '--json', '--cwd', root])).out,
    ) as Hit[];
    const mcpHits = await handleSearchTool(ctx, {
      query: 'auth routes first rest',
      kind: ['variable'],
      limit: 50,
    });
    const httpHits = (await httpJson(
      root,
      'api/search?q=auth%20routes%20first%20rest&kind=variable&limit=50',
    )) as Hit[];
    expect(pick(cliHits)).toEqual(names.map((n) => `variable ${n} src/auth.ts`).sort());
    expect(pick(mcpHits)).toEqual(pick(cliHits));
    expect(pick(httpHits)).toEqual(pick(cliHits));
    expect(handleSymbolTool(ctx, { name: 'routes' })[0]).toMatchObject({
      kind: 'variable',
      exported: true,
      file: 'src/auth.ts',
    });

    const fromCli = JSON.parse((await cli(['graph', '--symbol', 'auth', '--cwd', root])).out) as {
      nodes: Array<{ id: number; name: string }>;
      edges: Array<{ src: number; dst: number; kind: string }>;
    };
    const auth = fromCli.nodes.find((n) => n.name === 'auth')?.id;
    const whoami = fromCli.nodes.find((n) => n.name === 'whoami')?.id;
    expect(fromCli.edges).toContainEqual(expect.objectContaining({ src: whoami, dst: auth, kind: 'calls' }));
    expect(handleGraphTool(ctx, { symbol: 'auth' })).toEqual(fromCli);
    expect(await httpJson(root, 'api/graph?symbol=auth')).toEqual(fromCli);

    expect((await cli(['docs', '--offline', '--cwd', root])).code).toBe(0);
    const doc = (await cli(['docs', '--show', 'src/auth.ts', '--cwd', root])).out;
    for (const n of names) expect(doc).toContain(`\`${n}\``);
    const drift = JSON.parse((await cli(['drift', '--json', '--cwd', root])).out) as unknown;
    expect(handleDriftTool(ctx, {})).toEqual(drift);
  });

  it('SG33: an interrupted run is reported the same way by `atlas index` and atlas_index, once', async () => {
    const root = await indexed();
    const interrupt = (db: Database.Database) =>
      db.prepare('INSERT INTO runs (commit_sha, started_at) VALUES (NULL, ?)').run(new Date().toISOString());
    const raw = new Database(join(root, '.atlas', 'index.db'));
    interrupt(raw);
    raw.close();
    const run = await cli(['index', root]);
    expect(run.out).toMatch(/^resolved \d+ edges \(\d+ weak\) after an interrupted run$/m);
    const ctx = mcp(root);
    interrupt(ctx.db);
    const stats = await handleIndexTool(ctx, {});
    expect(stats.resolveReason).toBe('previous run interrupted');
    expect(stats.edges).toBe(counts(ctx.db).edges);
    expect((await handleIndexTool(ctx, {})).resolveReason).toBeNull();
    expect((await cli(['index', root])).out).toMatch(/\(graph unchanged\)/);
  });

  it('SG28: one budget message on docs, ask and atlas_ask; nothing is sent; max_tokens is capped alike', async () => {
    const root = await indexed();
    const fake = await fakeAnthropic((body) =>
      message(body, { content: [{ type: 'text', text: 'Circle.area [1]' }], stop_reason: 'end_turn' }),
    );
    const exhausted =
      /^atlas: token budget exhausted: a call needs ~\d+ tokens \(~\d+ prompt \+ 1024 output\), 1000 of 1000 left; raise tokenBudget$/m;
    const docs = await cli(['docs', '--budget', '1000', '--cwd', root]);
    expect(docs.code).toBe(1);
    expect(`atlas: ${docs.err}`).toMatch(exhausted);
    editConfig(root, { tokenBudget: 1000 });
    const ask = await cli(['ask', '--cwd', root, 'circle area']);
    expect(ask.code).toBe(1);
    expect(`atlas: ${ask.err}`).toMatch(exhausted);
    await expect(handleAskTool(mcp(root, false), { question: 'circle area' })).rejects.toThrow(
      /^token budget exhausted: .*1000 of 1000 left; raise tokenBudget$/,
    );
    expect(fake.bodies).toHaveLength(0);

    editConfig(root, { tokenBudget: 5000 });
    expect((await cli(['ask', '--cwd', root, 'circle area'])).code).toBe(0);
    await handleAskTool(mcp(root, false), { question: 'circle area' });
    const [fromCli, fromMcp] = fake.bodies.map((b) => b['max_tokens'] as number);
    expect(fromCli).toBeLessThan(5000);
    expect(fromMcp).toBe(fromCli);
  });

  it('A11-01/A11-03 stay fixed: a modest --budget writes docs; docs on an empty index exits 1 without a call', async () => {
    const root = await indexed();
    const run = await cli(['docs', '--offline', '--budget', '10000', '--cwd', root]);
    expect(run.out).toMatch(/generated 4/);
    const empty = sampleCopy();
    await cli(['init', '--cwd', empty]);
    const fake = await fakeAnthropic((body) => message(body, { content: [{ type: 'text', text: 'x' }] }));
    const r = await cli(['docs', '--cwd', empty]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/index is empty: run `atlas index` first/);
    expect(fake.bodies).toHaveLength(0);
    expect(existsSync(join(empty, '.atlas', 'docs', 'architecture.md'))).toBe(false);
  });

  it('SG29 (A11-02, A11-05, A7-08 stay fixed): atlas_index queues, writes a missing config and reads edits', async () => {
    const root = sampleCopy();
    const ctx = mcp(root);
    expect(existsSync(join(root, '.atlas', 'config.json'))).toBe(false);
    const runs = await Promise.all([1, 2, 3].map(() => handleIndexTool(ctx, { force: true })));
    expect(existsSync(join(root, '.atlas', 'config.json'))).toBe(true);
    expect(counts(ctx.db).symbols).toBe(24);
    expect(runs.map((r) => r.resolveReason)).toEqual(['forced', 'forced', 'forced']);
    editConfig(root, { maxFileBytes: 500 });
    expect((await handleIndexTool(ctx, {})).filesTooLarge).toBe(1);
    const fromCli = await cli(['index', root]);
    expect(fromCli.out).toMatch(/^1 file over the 500-byte cap not indexed/m);
  });

  it('SG32: while another process holds the lock, reads answer on MCP and HTTP and the run waits, then completes', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    const lock = holdIndexLock(root);
    let finished = false;
    const run = handleIndexTool(ctx, {}).then((s) => ((finished = true), s));
    expect(await handleSearchTool(ctx, { query: 'area', limit: 1 })).toHaveLength(1);
    expect(await httpJson(root, 'api/stats')).toMatchObject({ files: 4 });
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false);
    lock.close();
    expect((await run).filesSkipped).toBe(4);
    await expect(acquireIndexLock(join(root, '.atlas', 'index.db'), 0).then((release) => (release(), 'acquired'))).resolves.toBe('acquired');
    holdIndexLock(root);
    await expect(acquireIndexLock(join(root, '.atlas', 'index.db'), 150)).rejects.toThrow(
      /^another atlas index run is writing .*index\.db; gave up after 0s$/,
    );
  });

  it('extractor upgrade: `atlas index` and atlas_index report the same from/to', async () => {
    const root = await indexed();
    setRecordedExtractorVersion(root, EXTRACTOR_VERSION - 1);
    const run = await cli(['index', root]);
    expect(run.out).toMatch(
      new RegExp(`^index was written by extractor v${EXTRACTOR_VERSION - 1}; re-parsed every file with extractor v${EXTRACTOR_VERSION}$`, 'm'),
    );
    setRecordedExtractorVersion(root, EXTRACTOR_VERSION - 1);
    const stats = await handleIndexTool(mcp(root), {});
    expect(stats.extractorUpgrade).toEqual({ from: EXTRACTOR_VERSION - 1, to: EXTRACTOR_VERSION });
    expect(stats.filesIndexed).toBe(4);
  });
});

describe('AUDIT-15 findings', () => {
  it.fails('A15-01: atlas_ask follows a raised tokenBudget, as the error message tells the user to do', async () => {
    const root = await indexed();
    editConfig(root, { tokenBudget: 1000 });
    const ctx = mcp(root);
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(/raise tokenBudget/);
    editConfig(root, { tokenBudget: 200_000 });
    await handleIndexTool(ctx, {}); // re-reads the config (SG29)
    expect(ctx.config.tokenBudget).toBe(200_000);
    const answer = await handleAskTool(ctx, { question: 'circle area' });
    expect(answer.answer).toMatch(/Circle\.area/);
  });

  it.fails('A15-02: atlas_index answers within the client timeout while another process holds the index lock', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    const lock = holdIndexLock(root);
    const client = await linkedClient(ctx);
    try {
      const res = await client.callTool({ name: 'atlas_index', arguments: {} }, undefined, { timeout: 500 });
      expect(JSON.stringify(res.content)).toMatch(/another atlas index run/);
    } finally {
      lock.close();
      await handleIndexTool(ctx, {}); // queued behind the abandoned call
      await client.close();
    }
  });

  it.fails('A15-03: `docs --budget N` that cannot pay a call names --budget, not the config key', async () => {
    const root = await indexed();
    const run = await cli(['docs', '--offline', '--budget', '1000', '--cwd', root]);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/--budget/);
  });

  it.fails('A15-04: a docs run cut short by the budget says so without --verbose', async () => {
    const root = await indexed();
    const run = await cli(['docs', '--offline', '--budget', '2000', '--cwd', root]);
    expect(run.out).toMatch(/skipped [1-9]/);
    expect(run.out + run.err).toMatch(/token budget exhausted/);
  });

  it.fails('A15-05: `index --force` over an older extractor still reports the upgrade', async () => {
    const root = await indexed();
    setRecordedExtractorVersion(root, EXTRACTOR_VERSION - 1);
    const stats = await handleIndexTool(mcp(root), { force: true });
    expect(stats.extractorUpgrade).toEqual({ from: EXTRACTOR_VERSION - 1, to: EXTRACTOR_VERSION });
  });

  it.fails('A15-06: actual usage never exceeds tokenBudget (or the overspend is reported)', async () => {
    const root = await indexed();
    editConfig(root, { tokenBudget: 3000 });
    await fakeAnthropic((body) =>
      message(body, {
        content: [{ type: 'text', text: 'Circle.area [1]' }],
        stop_reason: 'end_turn',
        // A prompt that tokenizes denser than ~3 chars/token (CJK comments, minified code).
        usage: { input_tokens: 2900, output_tokens: 400 },
      }),
    );
    const ctx = mcp(root, false);
    const res = await handleAskTool(ctx, { question: 'circle area' });
    expect(res.inputTokens + res.outputTokens).toBe(3300);
    expect(ctx.budget.total().spent).toBeLessThanOrEqual(ctx.budget.cap);
  });

  it.fails('A15-07: the README documents the index lock and lists `docs` among the empty-index refusals', () => {
    const readme = readFileSync(join(__dirname, '../../README.md'), 'utf8');
    expect(readme).toMatch(/another atlas index run|index\.db\.lock/);
    expect(readme).toMatch(/`search`, `graph`, `docs`, `ask` and `drift` also exit 1/);
  });
});
