// AUDIT-3: API and SDK consistency across the CLI, the dashboard HTTP API and the MCP server.
// Each `it.fails` asserts the CORRECT (consistent) behaviour and currently fails, reproducing
// one finding in AUDIT-3.md (IDs A3-xx). When a finding is fixed its test starts passing,
// `it.fails` turns red, and it should become a plain `it`. Plain `it` blocks pin behaviour
// the audit found consistent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { startServer } from '../../src/web/server.js';
import {
  createMcpContext,
  handleAskTool,
  handleDocsTool,
  handleDriftTool,
  handleGraphTool,
  handleSearchTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

const dirs: string[] = [];
const contexts: McpContext[] = [];

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit3-'));
  dirs.push(d);
  return d;
}

function sampleCopy(): string {
  const root = join(tempDir(), 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  return root;
}

interface CliRun {
  out: string;
  err: string;
  code: number;
  thrown?: unknown;
}

async function cli(args: string[]): Promise<CliRun> {
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
  const code =
    thrown !== undefined ? 1 : typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return {
    out: out.join(''),
    err: err.join(''),
    code,
    ...(thrown !== undefined ? { thrown } : {}),
  };
}

async function indexed(): Promise<string> {
  const root = sampleCopy();
  await cli(['index', root]);
  return root;
}

async function withDocs(): Promise<string> {
  const root = await indexed();
  await cli(['docs', '--offline', '--cwd', root]);
  return root;
}

function mcp(root: string): McpContext {
  const ctx = createMcpContext({ root, offline: true });
  contexts.push(ctx);
  return ctx;
}

async function withServer<T>(root: string, fn: (base: string) => Promise<T>): Promise<T> {
  const db = openDatabase(join(root, '.atlas', 'index.db'), {
    readonly: true,
    fileMustExist: true,
  });
  const port = 42000 + Math.floor(Math.random() * 2000);
  const handle = await startServer(db, root, { port });
  try {
    return await fn(handle.url);
  } finally {
    await handle.close();
    closeDatabase(db);
  }
}

describe('AUDIT-3 consistent surfaces (pinned)', () => {
  it('graph JSON is identical from CLI, HTTP and MCP', async () => {
    const root = await indexed();
    const fromCli = JSON.parse((await cli(['graph', '--cwd', root])).out);
    const fromHttp = await withServer(root, async (b) => (await fetch(`${b}api/graph`)).json());
    const ctx = mcp(root);
    const fromMcp = handleGraphTool(ctx, {});
    expect(fromHttp).toEqual(fromCli);
    expect(fromMcp).toEqual(fromCli);
  });

  it('search returns the same result set and order from CLI, HTTP and MCP', async () => {
    const root = await indexed();
    const q = 'circle area';
    const names = (xs: Array<{ name: string; file: string }>) =>
      xs.map((h) => `${h.file}#${h.name}`);
    const fromCli = JSON.parse((await cli(['search', q, '--json', '--cwd', root])).out);
    const fromHttp = await withServer(root, async (b) =>
      (await fetch(`${b}api/search?q=${encodeURIComponent(q)}`)).json(),
    );
    const ctx = mcp(root);
    const fromMcp = await handleSearchTool(ctx, { query: q });
    expect(names(fromCli).length).toBeGreaterThan(0);
    expect(names(fromHttp)).toEqual(names(fromCli));
    expect(names(fromMcp)).toEqual(names(fromCli));
  });

  it('ask --json and atlas_ask agree apart from budgetRemaining', async () => {
    const root = await indexed();
    const q = 'How is the area of a circle computed?';
    const fromCli = JSON.parse((await cli(['ask', '--offline', '--json', '--cwd', root, q])).out);
    const ctx = mcp(root);
    const { budgetRemaining: _b, ...fromMcp } = await handleAskTool(ctx, { question: q });
    expect(fromMcp).toEqual(fromCli);
  });
});

describe('AUDIT-3 findings', () => {
  it.fails(
    'A3-01: atlas_drift {persisted:true} fails like `drift --docs-dir` when .atlas/docs is missing',
    async () => {
      const root = await withDocs();
      rmSync(join(root, '.atlas', 'docs'), { recursive: true, force: true });
      const run = await cli(['drift', '--docs-dir', '.atlas/docs', '--cwd', root]);
      expect(run.code).toBe(1);
      const ctx = mcp(root);
      // Correct: the MCP tool must not report "no stale docs" when there are no docs to check.
      expect(() => handleDriftTool(ctx, { persisted: true })).toThrow(/docs/);
    },
  );

  it.fails(
    'A3-02: drift JSON `hasDrift` agrees with the CLI exit code (undocumented only)',
    async () => {
      const root = await withDocs();
      const db = openDatabase(join(root, '.atlas', 'index.db'));
      db.prepare(
        "UPDATE docs SET content = '# math' WHERE target_kind = 'file' AND target_id = (SELECT id FROM files WHERE path = 'src/math.ts')",
      ).run();
      closeDatabase(db);
      const run = await cli(['drift', '--json', '--cwd', root]);
      const report = JSON.parse(run.out) as {
        hasDrift: boolean;
        stale: unknown[];
        undocumented: unknown[];
      };
      expect(report.stale).toHaveLength(0);
      expect(report.undocumented.length).toBeGreaterThan(0);
      expect(report.hasDrift).toBe(run.code !== 0);
    },
  );

  it.fails(
    'A3-03: DB-mode drift with no docs at all fails like `--docs-dir` with no docs',
    async () => {
      const root = await indexed();
      mkdirSync(join(root, '.atlas', 'docs'), { recursive: true });
      const dirMode = await cli(['drift', '--docs-dir', '.atlas/docs', '--cwd', root]);
      expect(dirMode.code).toBe(1);
      const dbMode = await cli(['drift', '--cwd', root]);
      expect(dbMode.code).not.toBe(0);
    },
  );

  it.fails(
    'A3-04: a doc returned by atlas_docs is also shown by `docs --show` and the dashboard',
    async () => {
      const root = await withDocs();
      // Fresh clone: committed .atlas/docs, freshly built index (as in CI).
      for (const f of readdirSync(join(root, '.atlas'))) {
        if (f.startsWith('index.db')) rmSync(join(root, '.atlas', f));
      }
      await cli(['index', root]);
      const ctx = mcp(root);
      const fromMcp = handleDocsTool(ctx, { target: 'src/math.ts' }) as { content: string };
      expect(fromMcp.content).toMatch(/src\/math\.ts/);
      closeDatabase(ctx.db);
      const shown = await cli(['docs', '--show', 'src/math.ts', '--cwd', root]);
      const stats = await withServer(root, async (b) => (await fetch(`${b}api/stats`)).json());
      expect(shown.out).toContain(fromMcp.content.trim());
      expect((stats as { docs: number }).docs).toBeGreaterThan(0);
    },
  );

  it.fails('A3-05: CLI `ask` honours tokenBudget like atlas_ask', async () => {
    const root = await indexed();
    writeFileSync(
      join(root, '.atlas', 'config.json'),
      JSON.stringify({ version: 1, tokenBudget: 100 }),
    );
    const ctx = mcp(root);
    await expect(handleAskTool(ctx, { question: 'circle area' })).rejects.toThrow(/budget/);
    const run = await cli(['ask', '--offline', '--json', '--cwd', root, 'circle area']);
    expect(run.code).not.toBe(0);
  });

  it.fails(
    'A3-06: `docs --budget` rejects a non-numeric value instead of disabling the cap',
    async () => {
      const root = await indexed();
      const run = await cli(['docs', '--offline', '--budget', 'abc', '--cwd', root]);
      expect(run.out).not.toMatch(/budget remaining NaN/);
      expect(run.code).not.toBe(0);
    },
  );

  it.fails('A3-07: a negative limit is rejected on CLI and HTTP as it is on MCP', async () => {
    const root = await indexed();
    // MCP rejects limit < 1 in its zod schema (src/mcp/server.ts:274).
    const run = await cli(['search', 'area', '--limit=-1', '--json', '--cwd', root]);
    const status = await withServer(
      root,
      async (b) => (await fetch(`${b}api/search?q=area&limit=-1`)).status,
    );
    expect(run.code).toBe(1);
    expect(status).toBe(400);
  });

  it.fails(
    'A3-07b: a non-numeric limit is a validation error (400), not a 500 "datatype mismatch"',
    async () => {
      const root = await indexed();
      const res = await withServer(root, async (b) => {
        const r = await fetch(`${b}api/search?q=area&limit=abc`);
        return { status: r.status, body: await r.text() };
      });
      expect(res.status).toBe(400);
    },
  );

  it.fails(
    'A3-08: an unknown kind fails on HTTP as on CLI (exit 1) and MCP (isError)',
    async () => {
      const root = await indexed();
      const run = await cli(['search', 'area', '--kind', 'bogus', '--cwd', root]);
      expect(run.code).toBe(1);
      const status = await withServer(
        root,
        async (b) => (await fetch(`${b}api/search?q=area&kind=bogus`)).status,
      );
      expect(status).toBe(400);
    },
  );

  it.fails('A3-08b: an empty search query fails on CLI as it does on MCP', async () => {
    const root = await indexed();
    const ctx = mcp(root);
    await expect(handleSearchTool(ctx, { query: '   ' })).rejects.toThrow(/empty/);
    const run = await cli(['search', '   ', '--json', '--cwd', root]);
    expect(run.code).toBe(1);
  });

  it.fails('A3-09: the MCP server does not create a missing project root', () => {
    const root = join(tempDir(), 'missing', 'repo');
    try {
      mcp(root);
    } catch {
      // Throwing is the correct outcome.
    }
    expect(existsSync(root)).toBe(false);
  });

  it.fails(
    'A3-09b: read commands on a missing index do not create .atlas/ in the target',
    async () => {
      const root = join(tempDir(), 'repo');
      mkdirSync(root);
      const run = await cli(['search', 'area', '--cwd', root]);
      expect(run.code).toBe(1);
      expect(existsSync(join(root, '.atlas'))).toBe(false);
    },
  );

  it.fails('A3-10: indexPath cannot place the index outside .atlas/', async () => {
    const root = sampleCopy();
    mkdirSync(join(root, '.atlas'), { recursive: true });
    writeFileSync(
      join(root, '.atlas', 'config.json'),
      JSON.stringify({ version: 1, indexPath: 'index.db' }),
    );
    await cli(['index', root]);
    expect(existsSync(join(root, 'index.db'))).toBe(false);
  });

  it.fails('A3-11: search hits use the same field names on CLI --json, HTTP and MCP', async () => {
    const root = await indexed();
    const fromCli = JSON.parse((await cli(['search', 'area', '--json', '--cwd', root])).out)[0];
    const fromHttp = (
      await withServer(root, async (b) => (await fetch(`${b}api/search?q=area`)).json())
    )[0];
    const ctx = mcp(root);
    const [fromMcp] = await handleSearchTool(ctx, { query: 'area' });
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(fromHttp)).toEqual(keys(fromCli));
    expect(keys(fromMcp!)).toEqual(keys(fromCli));
  });

  it.fails('A3-13: `index` accepts --cwd like every other project command', async () => {
    const root = sampleCopy();
    const run = await cli(['index', '--cwd', root]);
    expect(run.code).toBe(0);
  });

  it.fails('A3-15: `--kind module` is either rejected or returns module symbols', async () => {
    const root = await indexed();
    const run = await cli(['search', 'shapes', '--kind', 'module', '--json', '--cwd', root]);
    const ok = run.code === 1 || (JSON.parse(run.out) as unknown[]).length > 0;
    expect(ok).toBe(true);
  });

  it.fails('A3-16: unknown /api/* paths return a JSON 404, not the HTML shell', async () => {
    const root = await indexed();
    const status = await withServer(root, async (b) => (await fetch(`${b}api/nope`)).status);
    expect(status).toBe(404);
  });
});
