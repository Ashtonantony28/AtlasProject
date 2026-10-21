// SG13: one parameter schema for the CLI, the HTTP API and MCP.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AskParamsSchema,
  budgetSchema,
  listArg,
  numberArg,
  ParamError,
  parseParams,
  portSchema,
  SEARCH_KINDS,
  SearchParamsSchema,
} from '../../src/core/params.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { resolvePaths, DEFAULT_CONFIG } from '../../src/core/config.js';
import { openProjectIndex, requireRoot } from '../../src/core/project.js';
import { startServer } from '../../src/web/server.js';
import { createMcpContext, handleSearchTool } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

const search = (raw: Record<string, unknown>) => parseParams(SearchParamsSchema, raw);

describe('shared parameter schemas', () => {
  it('applies defaults and trims', () => {
    expect(search({ query: '  area ' })).toEqual({ query: 'area', limit: 10 });
    expect(parseParams(AskParamsSchema, { question: ' why? ' })).toEqual({
      question: 'why?',
      k: 5,
      expand: 5,
    });
  });

  it('rejects out-of-range, fractional and non-numeric numbers with a named message', () => {
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      expect(() => search({ query: 'a', limit })).toThrow(ParamError);
      expect(() => search({ query: 'a', limit })).toThrow('limit must be an integer from 1 to 100');
    }
    expect(search({ query: 'a', limit: 100 }).limit).toBe(100);
    expect(() => parseParams(AskParamsSchema, { question: 'q', k: 0 })).toThrow(/k must be/);
    expect(() => parseParams(AskParamsSchema, { question: 'q', k: 21 })).toThrow(/k must be/);
    expect(parseParams(AskParamsSchema, { question: 'q', expand: 0 }).expand).toBe(0);
    expect(() => parseParams(AskParamsSchema, { question: 'q', expand: -1 })).toThrow(/expand/);
    expect(() => parseParams(budgetSchema, Number.NaN)).toThrow('budget must be an integer ≥ 1');
    expect(() => parseParams(budgetSchema, -5)).toThrow(/budget/);
    expect(parseParams(budgetSchema, 1500)).toBe(1500);
    expect(() => parseParams(portSchema, 70000)).toThrow(/port/);
    expect(parseParams(portSchema, 0)).toBe(0);
  });

  it('rejects empty queries and unknown kinds, including module', () => {
    expect(() => search({ query: '   ' })).toThrow('query must not be empty');
    expect(() => parseParams(AskParamsSchema, { question: '' })).toThrow(/question must not/);
    expect(() => search({ query: 'a', kind: ['bogus'] })).toThrow(/unknown kind 'bogus'/);
    expect(() => search({ query: 'a', kind: ['module'] })).toThrow(/unknown kind 'module'/);
    expect(search({ query: 'a', kind: [...SEARCH_KINDS] }).kind).toEqual([...SEARCH_KINDS]);
  });

  it('parses CLI and query-string values the same way', () => {
    expect(numberArg(undefined)).toBeUndefined();
    expect(numberArg(null)).toBeUndefined();
    expect(numberArg('7')).toBe(7);
    expect(numberArg('')).toBeNaN();
    expect(numberArg('abc')).toBeNaN();
    expect(listArg('method, class,,')).toEqual(['method', 'class']);
    expect(listArg(null)).toBeUndefined();
  });
});

describe('the same values fail on every surface', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function indexed(): Promise<string> {
    const root = join(mkdtempSync(join(tmpdir(), 'atlas-params-')), 'repo');
    dirs.push(root, join(root, '..'));
    cpSync(SAMPLE, root, { recursive: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', root]);
    return root;
  }

  it('CLI throws, HTTP answers 400 and MCP throws for each bad search', async () => {
    const root = await indexed();
    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    const ctx = createMcpContext({ root, offline: true });
    const handle = await startServer(db, root, { port: 43000 + Math.floor(Math.random() * 1000) });
    try {
      const cases: Array<{ cli: string[]; qs: string; mcp: Record<string, unknown>; msg: RegExp }> = [
        { cli: ['area', '--limit', 'abc'], qs: 'q=area&limit=abc', mcp: { query: 'area', limit: Number.NaN }, msg: /limit must be/ },
        { cli: ['area', '--limit=0'], qs: 'q=area&limit=0', mcp: { query: 'area', limit: 0 }, msg: /limit must be/ },
        { cli: ['area', '--kind', 'bogus'], qs: 'q=area&kind=bogus', mcp: { query: 'area', kind: ['bogus'] }, msg: /unknown kind/ },
        { cli: [' '], qs: 'q=%20', mcp: { query: ' ' }, msg: /query must not be empty/ },
      ];
      for (const c of cases) {
        await expect(runCli(['search', ...c.cli, '--cwd', root])).rejects.toThrow(c.msg);
        const r = await fetch(`${handle.url}api/search?${c.qs}`);
        expect(r.status).toBe(400);
        expect(((await r.json()) as { error: string }).error).toMatch(c.msg);
        await expect(handleSearchTool(ctx, c.mcp as never)).rejects.toThrow(c.msg);
      }
      // HTTP trims kinds like the CLI.
      const trimmed = (await (await fetch(`${handle.url}api/search?q=shape&kind=method,%20class`)).json()) as Array<{ kind: string }>;
      expect(trimmed.some((h) => h.kind === 'class')).toBe(true);
      // Unknown API routes are JSON 404s.
      const nope = await fetch(`${handle.url}api/nope`);
      expect(nope.status).toBe(404);
      expect(nope.headers.get('content-type')).toMatch(/json/);
    } finally {
      await handle.close();
      closeDatabase(db);
      closeDatabase(ctx.db);
    }
  });

  it('ask, docs and serve reject bad numbers before touching the index', async () => {
    const root = await indexed();
    await expect(runCli(['ask', '--offline', '--k', 'abc', '--cwd', root, 'q'])).rejects.toThrow(/k must be/);
    await expect(runCli(['ask', '--offline', '--expand=-1', '--cwd', root, 'q'])).rejects.toThrow(/expand must be/);
    await expect(runCli(['ask', '--offline', '--cwd', root, '  '])).rejects.toThrow(/question must not be empty/);
    await expect(runCli(['docs', '--offline', '--budget', '-5', '--cwd', root])).rejects.toThrow(/budget must be/);
    await expect(runCli(['serve', '--port', 'abc', '--cwd', root])).rejects.toThrow(/port must be/);
  });
});

describe('project roots and index paths', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('missing roots and indexes give clear errors and create nothing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'atlas-root-'));
    dirs.push(base);
    const missing = join(base, 'nope');
    expect(() => requireRoot(missing)).toThrow(`directory not found: ${missing}`);
    expect(() => createMcpContext({ root: missing })).toThrow(/directory not found/);
    for (const cmd of [['init'], ['graph'], ['drift'], ['docs', '--list'], ['search', 'x']]) {
      await expect(runCli([...cmd, '--cwd', missing])).rejects.toThrow(/directory not found/);
    }
    await expect(runCli(['index', missing])).rejects.toThrow(/directory not found/);
    expect(existsSync(missing)).toBe(false);
    for (const cmd of [['graph'], ['drift'], ['docs', '--list'], ['ask', '--offline', 'q'], ['search', 'x']]) {
      await expect(runCli([...cmd, '--cwd', base])).rejects.toThrow(/run `atlas index` first/);
    }
    expect(() => openProjectIndex(base)).toThrow(/run `atlas index` first/);
    expect(existsSync(join(base, '.atlas'))).toBe(false);
  });

  it('indexPath must resolve inside .atlas/', () => {
    const at = (indexPath: string) => resolvePaths('/repo', { ...DEFAULT_CONFIG, indexPath });
    expect(at('.atlas/index.db').dbPath).toBe('/repo/.atlas/index.db');
    expect(at('.atlas/sub/x.db').dbPath).toBe('/repo/.atlas/sub/x.db');
    for (const bad of ['index.db', '../x.db', '/tmp/x.db', '.atlas', '.atlas/../x.db']) {
      expect(() => at(bad)).toThrow(/indexPath must be inside \.atlas\//);
    }
  });
});
