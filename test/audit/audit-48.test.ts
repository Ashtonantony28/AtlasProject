// AUDIT-48: API / SDK consistency, round 12 (CLI, HTTP, MCP, library exports), after SG240. Each
// `it.fails` asserts the CORRECT behaviour and currently fails, reproducing one finding in
// AUDIT-48.md (IDs A48-xx). When a finding is fixed its test starts passing, `it.fails` turns red,
// and it should become a plain `it`. The plain `it` pin what held: after an edit that was not
// re-indexed, `atlas ask` (text and `--json`), `ask()` and `atlas_ask` print one and the same note
// and cite nothing in the edited file; `atlas_symbol` withholds only that file's excerpt; no
// dashboard or search surface serves source text; `atlas_drift` and `runDrift` agree.
//
// The CLI runs as `node --import tsx` in another process (see AUDIT-31); MCP runs in-process, as
// handlers and through the stock SDK `Client` over an in-memory transport.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import * as qa from '../../src/core/qa/index.js';
import { runDrift } from '../../src/core/drift/index.js';
import { createOfflineClient } from '../../src/core/synth/index.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleAskTool,
  handleDriftTool,
  handleIndexTool,
  handleSearchTool,
  handleSymbolTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { startServer } from '../../src/web/server.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const QUESTION = 'What does add do?';
const NOTE =
  'Note: src/math.ts changed since indexing, so its snippets were left out; run `atlas index`.';

const dirs: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Run {
  out: string;
  err: string;
  code: number | null;
}

function cli(args: string[]): Run {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/** A copy of the sample, indexed by `atlas_index` (config written), with an open offline context. */
async function indexed(extra?: Record<string, string>): Promise<{ root: string; ctx: McpContext }> {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-audit48-')), 'repo');
  dirs.push(resolve(root, '..'));
  cpSync(SAMPLE, root, { recursive: true });
  for (const [p, text] of Object.entries(extra ?? {})) writeFileSync(join(root, p), text);
  const ctx = createMcpContext({ root, offline: true });
  cleanup.push(() => {
    if (ctx.db.open) closeDatabase(ctx.db);
  });
  await handleIndexTool(ctx, {});
  return { root, ctx };
}

/** The edit from SG240's acceptance: 12 lines prepended to src/math.ts, not re-indexed. */
function prepend(root: string): void {
  const p = join(root, 'src/math.ts');
  writeFileSync(p, '// added after indexing\n'.repeat(12) + readFileSync(p, 'utf8'));
}

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit48', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  return client;
}

const textOf = (r: unknown): string =>
  ((r as { content: { text: string }[] }).content[0]?.text ?? '') as string;

describe('AUDIT-48 consistent surfaces (pinned)', () => {
  it('SG240: after an unindexed edit, `atlas ask` text and `--json`, `ask()` and `atlas_ask` (handler and SDK client) give the same answer ending in one note, cite nothing in the file, and exit 0 with an empty stderr', async () => {
    const { root, ctx } = await indexed();
    prepend(root);

    const json = cli(['ask', '--offline', '--json', '--cwd', root, QUESTION]);
    expect([json.code, json.err]).toEqual([0, '']);
    const parsed = JSON.parse(json.out) as { answer: string; citations: { file: string }[] };
    expect(parsed.answer.endsWith(`\n\n${NOTE}`)).toBe(true);
    expect(parsed.citations.map((c) => c.file)).not.toContain('src/math.ts');

    const text = cli(['ask', '--offline', '--cwd', root, QUESTION]);
    expect([text.code, text.err]).toEqual([0, '']);
    expect(text.out.startsWith(`${parsed.answer}\n\nSources:\n`)).toBe(true);
    expect(text.out.split('Sources:')[1]).not.toMatch(/src\/math\.ts/);

    const core = await qa.ask(ctx.db, createOfflineClient(), root, QUESTION);
    expect(core.answer).toBe(parsed.answer);

    const tool = await handleAskTool(ctx, { question: QUESTION });
    expect(tool.answer).toBe(parsed.answer);
    expect(tool.citations).toEqual(parsed.citations);

    const client = await linkedClient(ctx);
    const res = await client.callTool({ name: 'atlas_ask', arguments: { question: QUESTION } });
    expect(res.isError).toBeFalsy();
    expect((JSON.parse(textOf(res)) as { answer: string }).answer).toBe(parsed.answer);
  });

  it('SG240: with the file unchanged (or re-indexed) no surface adds the note, and `add` is cited again', async () => {
    const { root, ctx } = await indexed();
    const capture = {
      model: 'capture',
      complete: async () => ({ content: 'ok', inputTokens: 1, outputTokens: 1 }),
    };
    const before = await qa.ask(ctx.db, capture, root, QUESTION);
    expect(before.answer).toBe('ok');
    expect(before.citations.some((c) => c.symbol === 'add')).toBe(true);
    prepend(root);
    await handleIndexTool(ctx, {});
    const after = await handleAskTool(ctx, { question: QUESTION });
    expect(after.answer).not.toMatch(/since indexing/);
    expect(after.citations.some((c) => c.symbol === 'add')).toBe(true);
    const json = cli(['ask', '--offline', '--json', '--cwd', root, QUESTION]);
    expect(JSON.parse(json.out).answer).not.toMatch(/since indexing/);
  });

  it('SG240: `atlas_symbol` withholds only the edited file’s excerpt (handler and SDK client agree) and restores it after `atlas_index`; `atlas_search`, `/api/search` and `/api/files` serve no source text', async () => {
    const { root, ctx } = await indexed();
    prepend(root);
    const [add] = handleSymbolTool(ctx, { name: 'add' });
    expect(add).toMatchObject({ name: 'add', file: 'src/math.ts', excerpt: null });
    expect(handleSymbolTool(ctx, { name: 'circle' })[0]?.excerpt).toMatch(/class Circle/);
    const client = await linkedClient(ctx);
    const viaSdk = JSON.parse(
      textOf(await client.callTool({ name: 'atlas_symbol', arguments: { name: 'add' } })),
    ) as unknown[];
    expect(viaSdk[0]).toEqual(add);

    for (const hit of await handleSearchTool(ctx, { query: 'add' }))
      expect(Object.keys(hit)).not.toContain('excerpt');
    const db = openDatabase(join(root, '.atlas', 'index.db'), {
      readonly: true,
      fileMustExist: true,
    });
    const handle = await startServer(db, root, { port: 0 });
    cleanup.push(async () => {
      await handle.close();
      closeDatabase(db);
    });
    const search = (await (await fetch(`${handle.url}api/search?q=add`)).json()) as object[];
    for (const hit of search)
      expect(Object.keys(hit).sort()).toEqual(['file', 'id', 'kind', 'line', 'name', 'score']);
    const files = (await (await fetch(`${handle.url}api/files`)).json()) as object[];
    for (const f of files) expect(JSON.stringify(f)).not.toMatch(/added after indexing|return a/);

    await handleIndexTool(ctx, {});
    expect(handleSymbolTool(ctx, { name: 'add' })[0]?.excerpt).toMatch(/return a \+ b/);
  });

  it('SG240: drift reports the edited file as `unindexed` the same way on `atlas_drift`, `runDrift` and `atlas drift --json` (exit 2)', async () => {
    const { root, ctx } = await indexed();
    const docs = cli(['docs', '--offline', '--cwd', root]);
    expect(docs.code).toBe(0);
    prepend(root);
    const tool = handleDriftTool(ctx, {});
    const core = runDrift(ctx.db, { root, skipArchitecture: false, strict: false });
    expect(tool.stale).toEqual(core.stale);
    expect(tool.stale).toMatchObject([{ targetPath: 'src/math.ts', currentHash: 'unindexed' }]);
    const json = cli(['drift', '--json', '--cwd', root]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).stale).toEqual(tool.stale);
  });
});

describe('AUDIT-48 findings', () => {
  it.fails(
    'A48-01: a file deleted (or renamed, or unreadable) since indexing gets the same "since indexing" note from `ask` as an edited one, instead of its snippets vanishing silently',
    async () => {
      const { root, ctx } = await indexed();
      rmSync(join(root, 'src/math.ts'));
      const res = await qa.ask(ctx.db, createOfflineClient(), root, QUESTION);
      expect(res.citations.map((c) => c.file)).not.toContain('src/math.ts');
      expect(res.answer).toMatch(/src\/math\.ts[^\n]*since indexing/);
    },
  );

  it.fails(
    'A48-02: `atlas docs` on a file edited since indexing says so (as `ask` does) instead of writing a doc without its source and reporting it generated',
    async () => {
      const { root } = await indexed();
      prepend(root);
      const r = cli(['docs', '--offline', '--cwd', root]);
      expect(r.code).toBe(0);
      expect(`${r.out}\n${r.err}`).toMatch(/src\/math\.ts[^\n]*(since indexing|atlas index)/);
    },
  );

  it.fails(
    'A48-03: the drift text report (and `atlas_drift` `formatted`) prints the `unindexed` sentinel whole, not cut to 8 characters',
    async () => {
      const { root, ctx } = await indexed();
      expect(cli(['docs', '--offline', '--cwd', root]).code).toBe(0);
      prepend(root);
      const { formatted } = handleDriftTool(ctx, { formatted: true });
      expect(formatted).toMatch(/current unindexed\b/);
    },
  );

  it.fails(
    'A48-04: `atlas_ask`’s note tells an MCP client to call `atlas_index`, as every other MCP message does, not to run the CLI',
    async () => {
      const { root, ctx } = await indexed();
      prepend(root);
      const res = await handleAskTool(ctx, { question: QUESTION });
      expect(res.answer).toMatch(/since indexing/);
      expect(res.answer).toMatch(/atlas_index/);
    },
  );

  it.fails(
    'A48-05: `atlas_symbol` never reports `truncated: true` for an excerpt it withheld',
    async () => {
      const body = Array.from({ length: 130 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      const { root, ctx } = await indexed({
        'src/long.ts': `export function longFn(): number {\n${body}\n  return 1;\n}\n`,
      });
      writeFileSync(join(root, 'src/long.ts'), '// edited\n', { flag: 'a' });
      const [sym] = handleSymbolTool(ctx, { name: 'longFn' });
      expect(sym?.excerpt).toBeNull();
      expect(sym?.truncated).toBe(false);
    },
  );

  it.fails(
    'A48-06: the library can tell a caller which files `retrieveForQuery` left out (the `changed` list `ask` uses is not exported)',
    async () => {
      const { root, ctx } = await indexed();
      prepend(root);
      const snippets = await qa.retrieveForQuery(ctx.db, root, QUESTION);
      expect(snippets.map((s) => s.file.path)).not.toContain('src/math.ts');
      expect('retrieve' in qa || 'changed' in snippets).toBe(true);
    },
  );

  it.fails(
    'A48-07: the `atlas_symbol` tool description and the README say an excerpt is withheld (`null`) for a file changed since indexing, and that `ask` notes it',
    async () => {
      const { ctx } = await indexed();
      const client = await linkedClient(ctx);
      const { tools } = await client.listTools();
      const symbol = tools.find((t) => t.name === 'atlas_symbol');
      expect(symbol?.description).toMatch(/null|changed since index/i);
      expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toMatch(/changed since indexing/);
    },
  );
});
