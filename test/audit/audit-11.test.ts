// AUDIT-11: API / SDK consistency, round 3 (CLI, HTTP, MCP, dashboard, Anthropic client).
// Each `it.fails` asserts the CORRECT behaviour and currently fails, reproducing one
// finding in AUDIT-11.md (IDs A11-xx). When a finding is fixed its test starts passing,
// `it.fails` turns red, and it should become a plain `it`. Plain `it` blocks pin
// behaviour the audit found consistent (several re-check AUDIT-7 fixes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, counts, openDatabase } from '../../src/core/db/index.js';
import { loadConfig } from '../../src/core/config.js';
import type { DriftReport } from '../../src/core/drift/index.js';
import { parseDriftReport, renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { startServer } from '../../src/web/server.js';
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

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit11-'));
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

function mcp(root: string): McpContext {
  const ctx = createMcpContext({ root, offline: true });
  contexts.push(ctx);
  return ctx;
}

function writeConfig(root: string, cfg: Record<string, unknown>): void {
  writeFileSync(join(root, '.atlas', 'config.json'), JSON.stringify({ version: 1, ...cfg }));
}

async function fakeAnthropic(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
) {
  const fake = await startFake(reply);
  servers.push(fake.server);
  return fake;
}

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit11', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  return client;
}

describe('AUDIT-11 consistent surfaces (pinned)', () => {
  it('maxFileBytes validates as README says, and atlas_index and `atlas index` count oversized files alike', async () => {
    const root = sampleCopy();
    await cli(['init', '--cwd', root]);
    for (const bad of [0, -1, 1.5, '1MB']) {
      writeConfig(root, { maxFileBytes: bad });
      expect(() => loadConfig(root)).toThrow(/maxFileBytes/);
      expect((await cli(['index', root])).code).toBe(1);
    }
    writeConfig(root, {});
    expect(loadConfig(root).maxFileBytes).toBeUndefined(); // walker default 1 MiB
    writeConfig(root, { maxFileBytes: 500 }); // src/shapes.ts is 673 bytes
    const run = await cli(['index', root]);
    expect(run.out).toMatch(/^1 file over the 500-byte cap not indexed/m);
    const stats = await handleIndexTool(mcp(root), { force: true });
    expect(stats.filesTooLarge).toBe(1);
    expect(stats.resolveReason).toBe('forced');
    expect(stats.resolverDiagnosticCount).toBe(stats.resolverDiagnostics.length);
  });

  it('A7-01/A7-03 stay fixed: no sampling params; max_tokens and refusal stops fail on docs, ask and atlas_ask', async () => {
    const root = await indexed();
    const fake = await fakeAnthropic((body) =>
      message(body, { content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens' }),
    );
    vi.stubEnv('ANTHROPIC_BASE_URL', fake.url);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const docs = await cli(['docs', '--cwd', root]);
    expect(docs.code).toBe(1);
    expect(docs.err).toMatch(/src\/app\.ts: not stored \(stop_reason max_tokens\)/);
    const ask = await cli(['ask', '--cwd', root, 'circle area']);
    expect(ask.code).toBe(1);
    expect(ask.err).toMatch(/incomplete response \(stop_reason max_tokens\)/);
    const ctx = createMcpContext({ root });
    contexts.push(ctx);
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(
      /incomplete response \(stop_reason max_tokens\)/,
    );
    for (const b of fake.bodies) {
      expect(Object.keys(b).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    }
  });

  it('A7-05 stays fixed: CLI and MCP refuse an empty index with the same message', async () => {
    const root = sampleCopy();
    await cli(['init', '--cwd', root]);
    for (const args of [
      ['search', 'area'],
      ['graph'],
      ['ask', '--offline', 'area'],
      ['drift'],
    ]) {
      const r = await cli([...args, '--cwd', root]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/index is empty: run `atlas index` first/);
    }
    const ctx = mcp(root);
    expect(() => handleDriftTool(ctx, {})).toThrow(/index is empty: call atlas_index first/);
    await expect(handleSearchTool(ctx, { query: 'area' })).rejects.toThrow(/index is empty/);
  });

  it('drift paging: `drift --json --limit/--offset` equals atlas_drift, and ci-comment renders totals', async () => {
    const root = await indexed();
    await cli(['docs', '--offline', '--cwd', root]);
    writeFileSync(join(root, 'src', 'math.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'src', 'app.ts'), 'export const y = 2;\n');
    await cli(['index', root]);
    const run = await cli(['drift', '--json', '--limit', '1', '--offset', '1', '--cwd', root]);
    expect(run.code).toBe(2);
    const fromCli = JSON.parse(run.out) as DriftReport;
    const ctx = mcp(root);
    expect(handleDriftTool(ctx, { limit: 1, offset: 1 })).toEqual(fromCli);
    expect(fromCli.truncated).toBe(true);
    // A saved atlas_drift result (with `formatted`) is accepted by ci-comment.
    const saved = JSON.stringify(handleDriftTool(ctx, { limit: 1, formatted: true }));
    const body = renderComment(parseDriftReport(saved));
    expect(body).toMatch(new RegExp(`failed\\*\\* \\(${fromCli.totals.stale} stale doc`));
    expect(body).toMatch(/one page of the drift check/);
  });

  it('`references` edges are identical from `graph --format json`, /api/graph and atlas_graph', async () => {
    const root = sampleCopy();
    writeFileSync(
      join(root, 'src', 'refs.ts'),
      'export function cb() { return 1; }\nexport function run() { return [1].map(cb); }\n',
    );
    await cli(['index', root]);
    const fromCli = JSON.parse((await cli(['graph', '--cwd', root])).out) as {
      edges: Array<{ kind: string }>;
    };
    expect(fromCli.edges.some((e) => e.kind === 'references')).toBe(true);
    const fromMcp = handleGraphTool(mcp(root), {});
    expect(fromMcp).toEqual(fromCli);
    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    const handle = await startServer(db, root, { port: 0 });
    try {
      const fromHttp = (await (await fetch(`${handle.url}api/graph`)).json()) as unknown;
      expect(fromHttp).toEqual(fromCli);
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });
});

describe('AUDIT-11 findings', () => {
  it(
    'A11-01: a tokenBudget that validates either produces docs or fails, instead of skipping everything with exit 0',
    async () => {
      const root = await indexed();
      // 10k tokens is ~20x what the offline mock spends on the whole sample (~2.5k).
      const run = await cli(['docs', '--offline', '--budget', '10000', '--cwd', root]);
      const generated = Number(/generated (\d+)/.exec(run.out)?.[1] ?? 0);
      expect(run.code !== 0 || generated > 0).toBe(true);
    },
  );

  it.fails('A11-02: concurrent atlas_index calls do not duplicate symbols', async () => {
    const root = sampleCopy();
    const ctx = mcp(root);
    await Promise.all([handleIndexTool(ctx, {}), handleIndexTool(ctx, {})]);
    // A single run on the sample stores 24 symbols (20 + 4 module symbols).
    expect(counts(ctx.db).symbols).toBe(24);
  });

  it('A11-03: `docs` on an empty index fails like the other read commands, without an LLM call', async () => {
    const root = sampleCopy();
    await cli(['init', '--cwd', root]);
    const run = await cli(['docs', '--offline', '--cwd', root]);
    expect(run.code).toBe(1);
    expect(existsSync(join(root, '.atlas', 'docs', 'architecture.md'))).toBe(false);
  });

  it.fails('A11-04: an oversized file is counted consistently (skipped ⊆ scanned)', async () => {
    const root = await indexed();
    writeConfig(root, { maxFileBytes: 500 });
    const stats = await handleIndexTool(mcp(root), {});
    expect(stats.filesTooLarge).toBe(1);
    expect(stats.filesIndexed + stats.filesSkipped + stats.filesFailed).toBeLessThanOrEqual(
      stats.filesScanned,
    );
  });

  it.fails('A11-05: atlas_index applies config edits made after the MCP server started', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    writeConfig(root, { maxFileBytes: 500 });
    const stats = await handleIndexTool(ctx, {});
    expect(stats.filesTooLarge).toBe(1);
  });

  it.fails('A11-06: /api/search on an empty index errors like CLI search and atlas_search', async () => {
    const root = sampleCopy();
    await cli(['init', '--cwd', root]);
    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    const handle = await startServer(db, root, { port: 0 });
    try {
      const res = await fetch(`${handle.url}api/search?q=area`);
      expect(res.status).not.toBe(200);
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });

  it.fails('A11-07: a no-op atlas_index reports the kept graph’s weakEdges, as it does edges', async () => {
    const root = sampleCopy();
    writeFileSync(join(root, 'src', 'ext.ts'), "import { t } from 'external-pkg';\nexport const u = t;\n");
    const ctx = mcp(root);
    const first = await handleIndexTool(ctx, {});
    expect(first.weakEdges).toBeGreaterThan(0);
    const again = await handleIndexTool(ctx, {});
    expect(again.resolveReason).toBeNull();
    expect(again.edges).toBe(first.edges);
    expect(again.weakEdges).toBe(first.weakEdges);
  });

  it.fails('A11-08: an unknown config key (typo) is rejected, not silently ignored', async () => {
    const root = sampleCopy();
    await cli(['init', '--cwd', root]);
    writeConfig(root, { maxFileByte: 10 });
    expect(() => loadConfig(root)).toThrow(/maxFileByte/);
  });

  it.fails('A11-09: `references` edges are named in atlas_graph’s description and the dashboard legend', async () => {
    const root = await indexed();
    const client = await linkedClient(mcp(root));
    try {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === 'atlas_graph')?.description).toMatch(/references/);
    } finally {
      await client.close();
    }
    const html = readFileSync(join(__dirname, '../../src/web/static/index.html'), 'utf8');
    expect(html).toMatch(/references/);
  });

  it.fails('A11-10: ci-comment never says "passed" for a report with failing: true', () => {
    const body = renderComment(
      parseDriftReport(
        JSON.stringify({
          stale: [],
          undocumented: [],
          totals: { files: 1, docs: 1, publicSymbols: 0, stale: 0, undocumented: 0 },
          hasDrift: false,
          failing: true,
        }),
      ),
    );
    expect(body).not.toMatch(/Drift check: passed/);
  });

  it.fails('A11-11: IndexStats spells "not applicable" one way (extractorUpgrade is null like resolveReason)', async () => {
    const root = sampleCopy();
    const stats = await handleIndexTool(mcp(root), {});
    expect(stats.resolveReason).not.toBeUndefined();
    expect(stats).toHaveProperty('extractorUpgrade', null);
  });
});
