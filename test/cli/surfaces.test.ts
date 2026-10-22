// SG13: docs lookup and the ask budget behave the same on the CLI, HTTP and MCP.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { startServer } from '../../src/web/server.js';
import { createMcpContext, handleDocsTool } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from './helpers.js';

async function capture(args: string[]): Promise<string> {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  try {
    await runCli(args);
  } finally {
    vi.restoreAllMocks();
  }
  return out.join('');
}

describe('docs from .atlas/docs on every surface (fresh clone)', () => {
  let root: string;
  beforeEach(async () => {
    root = join(mkdtempSync(join(tmpdir(), 'atlas-surfaces-')), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    await capture(['index', root]);
    await capture(['docs', '--offline', '--cwd', root]);
    for (const f of readdirSync(join(root, '.atlas'))) {
      if (f.startsWith('index.db')) rmSync(join(root, '.atlas', f));
    }
    await capture(['index', root]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('CLI --list/--show, the dashboard and atlas_docs return the same docs', async () => {
    const ctx = createMcpContext({ root, offline: true });
    const fromMcp = handleDocsTool(ctx, {}) as Array<{ kind: string; target: string; source: string; sourceHash: string; chars: number }>;
    const arch = handleDocsTool(ctx, { target: 'architecture' }) as { content: string };
    closeDatabase(ctx.db);
    expect(fromMcp.length).toBe(5);
    for (const d of fromMcp) expect(d.source).toBe('persisted');

    const listed = (await capture(['docs', '--list', '--cwd', root])).trim().split('\n');
    expect(listed).toEqual(
      fromMcp.map((d) => `[${d.kind}] ${d.target} (${d.chars} chars, hash=${d.sourceHash.slice(0, 8)}, persisted)`),
    );
    expect(await capture(['docs', '--show', 'architecture', '--cwd', root])).toBe(arch.content + '\n');
    await expect(capture(['docs', '--show', 'src/nope.ts', '--cwd', root])).rejects.toThrow(
      /no doc for 'src\/nope\.ts'/,
    );

    const db = openDatabase(join(root, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
    const handle = await startServer(db, root, { port: 0 });
    try {
      const get = async (p: string) => (await fetch(`${handle.url}${p}`)).json();
      expect(await get('api/docs')).toEqual(fromMcp);
      expect(((await get('api/stats')) as { docs: number }).docs).toBe(5);
      expect(((await get('api/doc/architecture')) as { content: string }).content).toBe(arch.content);
      const files = (await get('api/files')) as Array<{ id: number; path: string }>;
      const math = files.find((f) => f.path === 'src/math.ts')!;
      const doc = (await get(`api/doc/file/${math.id}`)) as { content: string; source: string };
      expect(doc.source).toBe('persisted');
      expect(doc.content).toMatch(/src\/math\.ts/);
    } finally {
      await handle.close();
      closeDatabase(db);
    }
  });
});

describe('ask honours tokenBudget on the CLI', () => {
  let root: string;
  beforeEach(async () => {
    root = join(mkdtempSync(join(tmpdir(), 'atlas-askbudget-')), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    await capture(['index', root]);
  });
  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('refuses a call larger than the budget and answers within it', async () => {
    writeFileSync(join(root, '.atlas', 'config.json'), JSON.stringify({ version: 1, tokenBudget: 100 }));
    await expect(capture(['ask', '--offline', '--cwd', root, 'circle area'])).rejects.toThrow(
      /token budget exhausted/,
    );
    writeFileSync(join(root, '.atlas', 'config.json'), JSON.stringify({ version: 1, tokenBudget: 50_000 }));
    const out = JSON.parse(await capture(['ask', '--offline', '--json', '--cwd', root, 'circle area'])) as {
      answer: string;
    };
    expect(out.answer.length).toBeGreaterThan(0);
  });
});
