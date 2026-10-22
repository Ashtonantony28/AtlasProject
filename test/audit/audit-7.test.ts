// AUDIT-7: API / SDK consistency, round 2 (CLI, HTTP, MCP, dashboard, Anthropic client).
// Each `it.fails` asserts the CORRECT behaviour and currently fails, reproducing one
// finding in AUDIT-7.md (IDs A7-xx). When a finding is fixed its test starts passing,
// `it.fails` turns red, and it should become a plain `it`. Plain `it` blocks pin
// behaviour the audit found consistent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { createAnthropicClient, listDocs } from '../../src/core/synth/index.js';
import type { DriftReport } from '../../src/core/drift/index.js';
import { renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { startServer } from '../../src/web/server.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleDriftTool,
  handleGraphTool,
  handleIndexTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';
import { fakeAnthropic as startFake, message } from '../helpers/fakeAnthropic.js';

const dirs: string[] = [];
const contexts: McpContext[] = [];
const servers: Server[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit7-'));
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
  let thrown = false;
  try {
    await runCli(args);
  } catch {
    thrown = true;
  } finally {
    vi.restoreAllMocks();
  }
  const code = thrown ? 1 : typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { out: out.join(''), err: err.join(''), code };
}

async function indexed(): Promise<string> {
  const root = sampleCopy();
  await cli(['index', root]);
  return root;
}

function mcp(root: string): McpContext {
  const ctx = createMcpContext({ root, offline: true });
  contexts.push(ctx);
  return ctx;
}

async function fakeAnthropic(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
) {
  const fake = await startFake(reply);
  servers.push(fake.server);
  return fake;
}

describe('AUDIT-7 consistent surfaces (pinned)', () => {
  it('atlas_drift and `drift --json` agree on totals, failing and the paged lists', async () => {
    const root = await indexed();
    await cli(['docs', '--offline', '--cwd', root]);
    const fromCli = JSON.parse((await cli(['drift', '--json', '--cwd', root])).out) as DriftReport;
    const fromMcp = handleDriftTool(mcp(root), {});
    expect(fromMcp).toEqual(fromCli);
  });

  it('the real client never puts the API key in a thrown error', async () => {
    const fake = await fakeAnthropic(() => ({
      status: 401,
      json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    }));
    vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-CANARY-0123456789');
    const llm = await createAnthropicClient('claude-sonnet-4-6');
    const err = await llm
      .complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toMatch(/CANARY/);
  });
});

describe('AUDIT-7 findings', () => {
  it(
    'A7-01: the Anthropic client sends no sampling parameters (current models reject them)',
    async () => {
      const fake = await fakeAnthropic((body) =>
        message(body, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
      );
      vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      const llm = await createAnthropicClient('claude-opus-5-5');
      await llm.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
      expect(fake.bodies).toHaveLength(1);
      expect(Object.keys(fake.bodies[0] ?? {})).not.toContain('temperature');
    },
  );

  it.fails(
    'A7-02: paging atlas_graph through every node returns every edge in scope',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      const seen = new Set<string>();
      let total = 0;
      let lastTruncated = true;
      for (let offset = 0; ; offset += 8) {
        const page = handleGraphTool(ctx, { limit: 8, offset });
        if (typeof page === 'string') throw new Error('expected json');
        total = page.totals.edges;
        for (const e of page.edges) seen.add(`${e.src}>${e.dst}:${e.kind}`);
        lastTruncated = page.truncated;
        if (offset + page.nodes.length >= page.totals.nodes) break;
      }
      expect(total).toBeGreaterThan(0);
      // Either every edge shows up on some page, or the final page admits it is incomplete.
      expect(seen.size === total || lastTruncated).toBe(true);
    },
  );

  it(
    'A7-03: a refused (empty) completion is not stored as a fresh, cached doc',
    async () => {
      const root = await indexed();
      const fake = await fakeAnthropic((body) =>
        message(body, { content: [], stop_reason: 'refusal' }),
      );
      vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      await cli(['docs', '--cwd', root]);
      expect(fake.bodies.length).toBeGreaterThan(0);
      const db = openDatabase(join(root, '.atlas', 'index.db'), { fileMustExist: true });
      try {
        const empty = listDocs(db, join(root, '.atlas', 'docs')).filter(
          (d) => d.content.trim() === '',
        );
        expect(empty.map((d) => d.target)).toEqual([]);
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails('A7-04: ci-comment reports totals, not the length of a paged list', () => {
    const report: DriftReport = {
      stale: [
        { kind: 'file', targetId: 1, targetPath: 'a.ts', storedHash: 'aaaaaaaa', currentHash: 'bbbbbbbb' },
      ],
      undocumented: [],
      totals: { files: 3, docs: 3, publicSymbols: 4, stale: 3, undocumented: 0 },
      hasDrift: true,
      failing: true,
      strict: false,
      truncated: true,
    };
    const body = renderComment(report);
    expect(body).toMatch(/3 stale doc/);
  });

  it.fails(
    'A7-05: `drift` on an empty index fails like atlas_drift instead of passing',
    async () => {
      const root = sampleCopy();
      await cli(['init', '--cwd', root]);
      expect(() => handleDriftTool(mcp(root), {})).toThrow(/index is empty/);
      contexts.splice(0).forEach((c) => closeDatabase(c.db));
      const run = await cli(['drift', '--cwd', root]);
      expect(run.code).not.toBe(0);
    },
  );

  it.fails(
    'A7-06: MCP rejects unknown tool arguments, as its advertised schema says',
    async () => {
      const root = await indexed();
      const ctx = mcp(root);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'audit7', version: '0.0.0' });
      await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
      try {
        const { tools } = await client.listTools();
        const schema = tools.find((t) => t.name === 'atlas_search')?.inputSchema as {
          additionalProperties?: boolean;
        };
        expect(schema.additionalProperties).toBe(false);
        const res = await client.callTool({
          name: 'atlas_search',
          arguments: { query: 'area', limt: 2 },
        });
        expect(res.isError).toBe(true);
      } finally {
        await client.close();
      }
    },
  );

  it.fails(
    'A7-08: atlas_index writes .atlas/config.json like `atlas index`',
    async () => {
      const root = sampleCopy();
      const ctx = mcp(root);
      await handleIndexTool(ctx, {});
      expect(existsSync(join(root, '.atlas', 'index.db'))).toBe(true);
      expect(existsSync(join(root, '.atlas', 'config.json'))).toBe(true);
    },
  );

  it.fails('A7-09: /api/doc/file/<id> rejects a non-numeric id', async () => {
    const root = await indexed();
    await cli(['docs', '--offline', '--cwd', root]);
    const db = openDatabase(join(root, '.atlas', 'index.db'), {
      readonly: true,
      fileMustExist: true,
    });
    const handle = await startServer(db, root, { port: 0 });
    try {
      const res = await fetch(`${handle.url}api/doc/file/1abc`);
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });
});

