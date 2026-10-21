// SG13: the drift exit code, the JSON report, MCP and ci-comment agree.
//   exit 0: no stale docs (undocumented symbols are reported, `failing: false`)
//   exit 2: `failing` (stale docs, or undocumented symbols with --strict)
//   exit 1: nothing to check (no docs in the index, or --docs-dir missing/empty)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import type { DriftReport } from '../../src/core/drift/index.js';
import { renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { createMcpContext, handleDriftTool } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

async function drift(args: string[]): Promise<{ code: number; report?: DriftReport }> {
  const out: string[] = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await runCli(['drift', '--json', ...args]);
  vi.restoreAllMocks();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  const text = out.join('');
  return { code, ...(text ? { report: JSON.parse(text) as DriftReport } : {}) };
}

describe('drift exit code / JSON contract', () => {
  let root: string;
  beforeEach(async () => {
    root = join(mkdtempSync(join(tmpdir(), 'atlas-contract-')), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', root]);
    await runCli(['docs', '--offline', '--cwd', root]);
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  function blankMathDoc(): void {
    const db = openDatabase(join(root, '.atlas', 'index.db'));
    db.prepare(
      "UPDATE docs SET content = '# math' WHERE target_kind = 'file' AND target_id = (SELECT id FROM files WHERE path = 'src/math.ts')",
    ).run();
    closeDatabase(db);
  }

  function expectAgreement(code: number, report: DriftReport | undefined): void {
    expect(report).toBeDefined();
    expect(report!.failing).toBe(code === 2);
    expect(report!.hasDrift).toBe(report!.stale.length + report!.undocumented.length > 0);
    expect(report!.failing).toBe(
      report!.stale.length > 0 || (report!.strict && report!.undocumented.length > 0),
    );
  }

  it('clean: exit 0, nothing to report, comment says passed', async () => {
    for (const args of [['--cwd', root], ['--cwd', root, '--docs-dir', '.atlas/docs']]) {
      const { code, report } = await drift(args);
      expect(code).toBe(0);
      expectAgreement(code, report);
      expect(report).toMatchObject({ hasDrift: false, failing: false, strict: false });
      expect(renderComment(report!)).toMatch(/\*\*Drift check: passed\.\*\* All docs are in sync/);
    }
  });

  it('undocumented only: exit 0 and failing false; --strict: exit 2 and failing true', async () => {
    blankMathDoc();
    const plain = await drift(['--cwd', root]);
    expect(plain.code).toBe(0);
    expectAgreement(plain.code, plain.report);
    expect(plain.report).toMatchObject({ hasDrift: true, failing: false, stale: [] });
    const passed = renderComment(plain.report!);
    expect(passed).toMatch(/\*\*Drift check: passed\.\*\* No stale docs/);
    expect(passed).toMatch(/only with `--strict`/);
    expect(passed).toMatch(/### Undocumented public symbols/);

    const strict = await drift(['--strict', '--cwd', root]);
    expect(strict.code).toBe(2);
    expectAgreement(strict.code, strict.report);
    expect(strict.report).toMatchObject({ failing: true, strict: true });
    expect(renderComment(strict.report!)).toMatch(
      /\*\*Drift check: failed\*\* \(\d+ undocumented public symbol\(s\) \(--strict\)\)/,
    );

    const ctx = createMcpContext({ root, offline: true });
    try {
      const { formatted: _f, ...fromMcp } = handleDriftTool(ctx, {});
      expect(fromMcp).toEqual(plain.report);
      const { formatted: _g, ...strictMcp } = handleDriftTool(ctx, { strict: true });
      expect(strictMcp).toEqual(strict.report);
    } finally {
      closeDatabase(ctx.db);
    }
  });

  it('stale: exit 2 and failing true in DB and --docs-dir mode; comment says failed', async () => {
    const p = join(root, 'src/math.ts');
    writeFileSync(p, readFileSync(p, 'utf8').replace('return a * b;', 'return b * a;'));
    for (const args of [['--cwd', root], ['--cwd', root, '--docs-dir', '.atlas/docs']]) {
      const { code, report } = await drift(args);
      expect(code).toBe(2);
      expectAgreement(code, report);
      expect(report!.stale.map((s) => s.targetPath)).toEqual(['src/math.ts']);
      expect(renderComment(report!)).toMatch(/\*\*Drift check: failed\*\* \(1 stale doc\(s\)\)/);
    }
  });

  it('nothing to check: exit 1 with no JSON, on the CLI and MCP alike', async () => {
    rmSync(join(root, '.atlas', 'docs'), { recursive: true, force: true });
    expect(await drift(['--cwd', root, '--docs-dir', '.atlas/docs'])).toEqual({ code: 1 });
    const ctx = createMcpContext({ root, offline: true });
    try {
      expect(() => handleDriftTool(ctx, { persisted: true })).toThrow(/docs directory not found/);
      ctx.db.prepare('DELETE FROM docs').run();
      expect(() => handleDriftTool(ctx, {})).toThrow(/no docs found in the index/);
    } finally {
      closeDatabase(ctx.db);
    }
    expect(await drift(['--cwd', root])).toEqual({ code: 1 });
  });
});
