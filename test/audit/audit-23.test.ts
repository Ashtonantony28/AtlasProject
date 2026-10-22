// AUDIT-23: API / SDK consistency, round 6 (CLI, HTTP, MCP, library exports). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-23.md (IDs
// A23-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. Plain `it` blocks pin what the audit found consistent: SG65 (`SQLITE_BUSY`
// named alike on the CLI and MCP, reads unaffected, `nameBusy` on the public surface) and SG55 (a
// refusal caused by in-flight reservations names them).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as core from '../../src/core/index.js';
import { closeDatabase, nameBusy, openDatabase } from '../../src/core/db/index.js';
import { startServer } from '../../src/web/server.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleAskTool,
  handleSearchTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';
import { fakeAnthropic as startFake, message } from '../helpers/fakeAnthropic.js';

const dirs: string[] = [];
const contexts: McpContext[] = [];
const servers: Server[] = [];
const cleanup: (() => void)[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of cleanup.splice(0)) f();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit23-'));
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

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit23', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  return client;
}

const text = (r: Record<string, unknown>): string =>
  (r['content'] as Array<{ text: string }> | undefined)?.[0]?.text ?? '';

/**
 * Another process (as `atlas docs` would be) holding the index's write lock (`BEGIN IMMEDIATE`):
 * for `holdMs` at a time, released for `gapMs` between holds, until `totalMs` has passed. A single
 * hold is `totalMs` with `gapMs` 0.
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

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');

const RESERVED =
  /^token budget exhausted: a call needs ~\d+ tokens \(~\d+ prompt \+ 1024 output\), \d+ of \d+ left, \d+ tokens reserved by calls in progress; retry when they finish$/;

describe('AUDIT-23 consistent surfaces (pinned)', () => {
  it('SG65: a write lock held past the busy timeout fails `atlas index` and atlas_index with one named message; reads on CLI, MCP and HTTP answer', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    const ro = openDatabase(dbOf(root), { readonly: true, fileMustExist: true });
    cleanup.push(() => closeDatabase(ro));
    const handle = await startServer(ro, root, { port: 0 });
    cleanup.push(() => void handle.close());
    await writer(dbOf(root), 14_000, 14_000);

    // Reads never wait on a writer (WAL).
    const t0 = Date.now();
    expect((await cli(['search', 'area', '--cwd', root, '--json'])).code).toBe(0);
    expect(await handleSearchTool(ctx, { query: 'area', limit: 1 })).toHaveLength(1);
    expect((await fetch(`${handle.url}api/stats`)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2_000);

    const fromCli = await cli(['index', root]);
    const client = await linkedClient(ctx);
    try {
      const res = await client.callTool({ name: 'atlas_index', arguments: {} });
      expect(res.isError).toBe(true);
      expect(fromCli.code).toBe(1);
      expect(fromCli.err).toMatch(/^run stamp: database is locked/);
      expect(text(res)).toBe(fromCli.err);
    } finally {
      await client.close();
    }
  }, 40_000);

  it('SG65: nameBusy is on the public core surface and names only SQLITE_BUSY errors', () => {
    expect(core.nameBusy).toBe(nameBusy);
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
    const other = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    nameBusy(busy, 'index write');
    nameBusy(other, 'index write');
    nameBusy('not an error', 'index write');
    expect(busy.message).toBe('index write: database is locked');
    expect(String(busy.stack).split('\n')[0]).toBe('Error: index write: database is locked');
    expect(other.message).toBe('disk I/O error');
  });

  it('SG55: a refusal caused by in-flight reservations names them; a retry afterwards is answered; the plain refusal is unchanged', async () => {
    const root = await indexed();
    editConfig(root, { tokenBudget: 20_000 });
    const ctx = mcp(root);
    const settled = await Promise.allSettled(
      [1, 2, 3].map(() => handleAskTool(ctx, { question: 'circle area' })),
    );
    const refused = settled.flatMap((r) =>
      r.status === 'rejected' ? [String((r.reason as Error).message)] : [],
    );
    expect(refused.length).toBeGreaterThan(0);
    for (const m of refused) expect(m).toMatch(RESERVED);
    expect((await handleAskTool(ctx, { question: 'circle area' })).answer).toMatch(/Circle\.area/);

    // No call in flight: the refusal and its remedy are the CLI's.
    editConfig(root, { tokenBudget: 1000 });
    const plain =
      /^token budget exhausted: a call needs ~\d+ tokens \(~\d+ prompt \+ 1024 output\), 0 of 1000 left; raise tokenBudget$/;
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(plain);
    expect((await cli(['ask', '--offline', '--cwd', root, 'circle area'])).err).toMatch(
      /1000 of 1000 left; raise tokenBudget$/,
    );
  });
});

describe('AUDIT-23 findings', () => {
  it.fails(
    'A23-01: an index run waits out a concurrent writer that holds the write lock for 1 s at a time (busy timeout 5 s)',
    async () => {
      const root = await indexed();
      await writer(dbOf(root), 1_000, 12_000, 20);
      const t0 = Date.now();
      const res = await cli(['index', '--force', root]);
      // Fails in ~1.5 s with "index write: database is locked": the per-file transaction is
      // deferred, so its read-to-write upgrade gets SQLITE_BUSY at once, without the busy wait.
      expect({ code: res.code, err: res.err }).toEqual({ code: 0, err: '' });
      expect(Date.now() - t0).toBeLessThan(12_000);
    },
  );

  it.fails(
    'A23-02: SQLITE_BUSY errors name the step on `atlas docs` too, and say what to do',
    async () => {
      const root = await indexed();
      await writer(dbOf(root), 14_000, 14_000);
      const docs = await cli(['docs', '--offline', '--cwd', root]);
      const index = await cli(['index', root]);
      expect([docs.code, index.code]).toEqual([1, 1]);
      // index: "run stamp: database is locked"; docs: "database is locked" (no step).
      expect(docs.err).toMatch(/^[a-z ]+: database is locked/);
      for (const err of [docs.err, index.err]) {
        expect(err).toMatch(/another (atlas )?process|retry|try again/);
      }
    },
    40_000,
  );

  it.fails(
    'A23-03: a parallel atlas_ask capped by reservations is answered like the same call alone (or says why not)',
    async () => {
      const root = await indexed();
      editConfig(root, { tokenBudget: 40_000 });
      // A model whose answer needs ~7k output tokens: cut off when max_tokens is lower.
      const fake = await startFake((body) =>
        (body['max_tokens'] as number) < 8000
          ? message(body, {
              content: [{ type: 'text', text: 'Circle.area is' }],
              stop_reason: 'max_tokens',
              usage: { input_tokens: 700, output_tokens: body['max_tokens'] },
            })
          : message(body, {
              content: [{ type: 'text', text: 'Circle.area [1]' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 700, output_tokens: 7000 },
            }),
      );
      servers.push(fake.server);
      vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      const ctx = mcp(root, false);
      const settled = await Promise.allSettled(
        [1, 2, 3].map(() => handleAskTool(ctx, { question: 'circle area' })),
      );
      expect(fake.bodies.map((b) => b['max_tokens'])).toEqual([16000, 16000, 5801]);
      // The third fails with "no answer: the model returned an incomplete response (stop_reason
      // max_tokens)"; alone, the same call is answered (16000).
      for (const r of settled) {
        if (r.status === 'rejected') expect(String((r.reason as Error).message)).toMatch(/reserv/);
      }
    },
  );

  it.fails(
    'A23-04: "retry when they finish" holds: the retry is answered once the reserving calls settle',
    async () => {
      const root = await indexed();
      editConfig(root, { tokenBudget: 35_000 });
      // Each call uses all the output it is given.
      const fake = await startFake((body) =>
        message(body, {
          content: [{ type: 'text', text: 'Circle.area [1]' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 700, output_tokens: body['max_tokens'] },
        }),
      );
      servers.push(fake.server);
      vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      const ctx = mcp(root, false);
      const settled = await Promise.allSettled(
        [1, 2, 3].map(() => handleAskTool(ctx, { question: 'circle area' })),
      );
      const refused = settled.flatMap((r) =>
        r.status === 'rejected' ? [String((r.reason as Error).message)] : [],
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatch(RESERVED);
      // The retry fails: "… 1600 of 35000 left; raise tokenBudget".
      await expect(handleAskTool(ctx, { question: 'circle area' })).resolves.toBeDefined();
    },
  );

  it.fails(
    'A23-05: the README documents `database is locked` and the reservation refusal',
    () => {
      const readme = readFileSync(join(__dirname, '../../README.md'), 'utf8');
      expect(readme).toMatch(/database is locked/);
      expect(readme).toMatch(/retry when they finish|reserved by calls in progress/);
    },
  );
});
