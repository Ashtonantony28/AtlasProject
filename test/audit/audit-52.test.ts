// AUDIT-52: API / SDK consistency, round 15 (CLI, HTTP, MCP, package surface). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-52.md (IDs
// A52-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. The plain `it` pin what held: the shared parameter refusals read the same on
// the CLI, HTTP and the SDK client; the doc listings agree on a fresh index with committed docs;
// `drift --docs-dir` and `atlas_drift {persisted}` agree; graph JSON agrees on every surface.
//
// The CLI runs as `node --import tsx` in another process (see AUDIT-31); MCP runs in-process, as
// handlers and through the stock SDK `Client` over an in-memory transport.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import {
  createAtlasMcpServer,
  createMcpContext,
  handleDocsTool,
  handleDriftTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { startServer } from '../../src/web/server.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');

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

function cli(args: string[], cwd = ROOT): Run {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

function sample(extra?: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-audit52-')), 'repo');
  dirs.push(resolve(root, '..'));
  cpSync(SAMPLE, root, { recursive: true });
  for (const [p, text] of Object.entries(extra ?? {})) writeFileSync(join(root, p), text);
  return root;
}

function context(root: string): McpContext {
  const ctx = createMcpContext({ root, offline: true });
  cleanup.push(() => {
    if (ctx.db.open) closeDatabase(ctx.db);
  });
  return ctx;
}

async function linkedClient(ctx: McpContext): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audit52', version: '0.0.0' });
  await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  return client;
}

async function serve(root: string): Promise<string> {
  const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
  const handle = await startServer(db, root, { port: 0 });
  cleanup.push(async () => {
    await handle.close();
    closeDatabase(db);
  });
  return handle.url;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: r.isError === true, text: r.content[0]?.text ?? '' };
}

/**
 * The README reset (or a fresh clone): docs generated and committed under `.atlas/docs`, then a
 * file changed (so two docs are stale), then `rm .atlas/index.db*` and `atlas index`.
 */
function freshIndexWithCommittedDocs(): string {
  const root = sample();
  expect(cli(['index', root]).code).toBe(0);
  expect(cli(['docs', '--offline', '--cwd', root]).code).toBe(0);
  appendFileSync(
    join(root, 'src/math.ts'),
    'export function sub(a: number, b: number): number {\n  return a - b;\n}\n',
  );
  for (const f of ['index.db', 'index.db-wal', 'index.db-shm'])
    rmSync(join(root, '.atlas', f), { force: true });
  expect(cli(['index', root]).code).toBe(0);
  return root;
}

describe('AUDIT-52 consistent surfaces (pinned)', () => {
  it('shared parameter refusals read the same on the CLI (exit 1), HTTP (400) and the SDK client (isError)', async () => {
    const root = sample();
    expect(cli(['index', root]).code).toBe(0);
    const ctx = context(root);
    const client = await linkedClient(ctx);
    const url = await serve(root);
    const cases: { msg: string; argv: string[]; http: string; tool: string; args: object }[] = [
      {
        msg: 'limit must be an integer from 1 to 100',
        argv: ['search', 'x', '-n', '0'],
        http: 'api/search?q=x&limit=0',
        tool: 'atlas_search',
        args: { query: 'x', limit: 0 },
      },
      {
        msg: 'query must not be empty',
        argv: ['search', '  '],
        http: 'api/search?q=%20%20',
        tool: 'atlas_search',
        args: { query: '  ' },
      },
      {
        msg: "unknown kind 'module' (expected function, method, class, interface, type, variable)",
        argv: ['search', 'x', '-k', 'module'],
        http: 'api/search?q=x&kind=module',
        tool: 'atlas_search',
        args: { query: 'x', kind: ['module'] },
      },
      {
        msg: 'depth must be an integer from 1 to 3',
        argv: ['graph', '--depth', '9'],
        http: 'api/graph?depth=9',
        tool: 'atlas_graph',
        args: { depth: 9 },
      },
    ];
    for (const c of cases) {
      const run = cli([...c.argv, '--cwd', root]);
      expect(run).toMatchObject({ out: '', err: `atlas: ${c.msg}`, code: 1 });
      const res = await fetch(`${url}${c.http}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: c.msg });
      const viaSdk = await call(client, c.tool, c.args as Record<string, unknown>);
      expect(viaSdk.isError).toBe(true);
      expect(viaSdk.text).toContain(c.msg);
    }
  });

  it('on a fresh index with committed docs, `docs --list`, `atlas_docs`, `/api/docs` and `/api/stats` agree, and `drift --docs-dir` equals `atlas_drift {persisted}`', async () => {
    const root = freshIndexWithCommittedDocs();
    const list = cli(['docs', '--list', '--cwd', root]);
    expect(list.code).toBe(0);
    const cliTargets = list.out
      .trim()
      .split('\n')
      .map((l) => /^\[\w+\] (\S+) \(.*, (persisted|index)\)$/.exec(l)?.slice(1).join(' '));
    const drift = cli(['drift', '--json', '--docs-dir', '.atlas/docs', '--cwd', root]);
    expect(drift.code).toBe(2);

    const ctx = context(root);
    const mcpDocs = handleDocsTool(ctx, {}) as { target: string; source: string }[];
    expect(cliTargets).toEqual(mcpDocs.map((d) => `${d.target} ${d.source}`));
    expect(mcpDocs.every((d) => d.source === 'persisted')).toBe(true);
    const url = await serve(root);
    expect(await (await fetch(`${url}api/docs`)).json()).toEqual(mcpDocs);
    expect(((await (await fetch(`${url}api/stats`)).json()) as { docs: number }).docs).toBe(5);

    const mcpDrift = handleDriftTool(ctx, { persisted: true, limit: 1000 });
    expect(JSON.parse(drift.out)).toEqual(mcpDrift);
    expect(mcpDrift.stale.map((s) => s.targetPath).sort()).toEqual(['architecture', 'src/math.ts']);
  });

  it('graph JSON is the same from `atlas graph --limit 1000 --edge-limit 2000`, `atlas_graph` (SDK) and `/api/graph`', async () => {
    const root = sample();
    expect(cli(['index', root]).code).toBe(0);
    const run = cli(['graph', '--limit', '1000', '--edge-limit', '2000', '--cwd', root]);
    expect(run.code).toBe(0);
    const ctx = context(root);
    const client = await linkedClient(ctx);
    const viaSdk = JSON.parse((await call(client, 'atlas_graph', {})).text) as unknown;
    const url = await serve(root);
    const http = (await (await fetch(`${url}api/graph`)).json()) as unknown;
    expect(JSON.parse(run.out)).toEqual(viaSdk);
    expect(http).toEqual(viaSdk);
  });
});

describe('AUDIT-52 findings', () => {
  it.fails('A52-01: the README MCP config and `npx atlas` examples name a package this project can publish (npm `atlas` is an unrelated package)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    // `npm view atlas` (2026-11-03): atlas@1.0.0-alpha.0 by another maintainer, no `bin`, a
    // `postinstall` script. Running `npx atlas …` resolves to that package, not this one.
    const npxBare = /"command": "npx",\s*"args": \["atlas"/.test(readme) || /npx atlas /.test(readme);
    expect(npxBare).toBe(true);
    expect(pkg.name).not.toBe('atlas');
  });

  it.fails('A52-02: on an index whose only docs are the committed ones, drift (CLI and atlas_drift) does not say "no docs found … run `atlas docs` first" while every listing shows them', async () => {
    const root = freshIndexWithCommittedDocs();
    const list = cli(['docs', '--list', '--cwd', root]);
    expect(list.out.trim().split('\n')).toHaveLength(5);
    const ctx = context(root);
    const client = await linkedClient(ctx);
    expect(JSON.parse((await call(client, 'atlas_docs', {})).text)).toHaveLength(5);

    const viaSdk = await call(client, 'atlas_drift', {});
    const run = cli(['drift', '--cwd', root]);
    // Either drift checks the docs the listings show (two are stale: exit 2), or its refusal points
    // at them (`--docs-dir .atlas/docs` / `persisted: true`) instead of telling the user to
    // regenerate them, which rewrites the stale docs and loses the report.
    expect(run.err).not.toMatch(/run `atlas docs` first/);
    expect(viaSdk.text).toMatch(/persisted|stale/);
  });

  it.fails('A52-03: `--format dot` draws the edges the JSON export holds, and a page declares every node its edges name', () => {
    const root = sample({
      'src/ext.ts':
        "import _ from 'lodash';\nimport { nope } from './missing';\nexport function useIt() { return _.map([], nope); }\n",
    });
    expect(cli(['index', root]).code).toBe(0);
    const json = JSON.parse(cli(['graph', '--cwd', root]).out) as {
      edges: { src: number | null; dst: number | null }[];
    };
    const dot = cli(['graph', '--format', 'dot', '--cwd', root]).out;
    const arrows = dot.match(/->/g)?.length ?? 0;
    const page = cli(['graph', '--format', 'dot', '--limit', '5', '--cwd', root]).out;
    const declared = new Set([...page.matchAll(/^ {2}(n\d+) \[label=/gm)].map((m) => m[1]));
    const named = [...page.matchAll(/(n\d+) -> (n\d+)/g)].flatMap((m) => [m[1], m[2]]);
    expect(named.filter((n) => !declared.has(n))).toEqual([]);
    expect(json.edges.some((e) => e.dst === null)).toBe(true);
    expect(arrows).toBe(json.edges.length);
  });

  it.fails('A52-04: MCP tools carry annotations: the six read tools are readOnlyHint, atlas_index is not destructive', async () => {
    const ctx = context(sample());
    const client = await linkedClient(ctx);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    const reads = ['atlas_search', 'atlas_symbol', 'atlas_graph', 'atlas_drift', 'atlas_docs', 'atlas_ask'];
    for (const name of reads) expect(byName.get(name)?.readOnlyHint).toBe(true);
    expect(byName.get('atlas_index')?.destructiveHint).toBe(false);
  });

  it.fails("A52-05: importing the package's `main` does not run the CLI and exit the importing process", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      main: string;
      bin: Record<string, string>;
      exports?: unknown;
    };
    expect(pkg.main).toBe(pkg.bin.atlas);
    // `dist/cli/index.js` is the build of `src/cli/index.ts`; import the source the same way.
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(CLI)}); console.log('imported');`,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(r.stderr).not.toMatch(/Usage: atlas/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('imported');
  });
});
