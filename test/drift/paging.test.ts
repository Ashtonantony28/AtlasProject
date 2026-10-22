// Paging (`limit`/`offset`) selects entries to show; it never changes the gate
// (`failing`, the exit code), `hasDrift` or the totals.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase } from '../../src/core/db/index.js';
import {
  pageDriftReport,
  type DriftReport,
  type StaleDocReport,
  type UndocumentedSymbolReport,
} from '../../src/core/drift/index.js';
import { createMcpContext, handleDriftTool } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

function report(nStale: number, nUndoc: number, strict = false): DriftReport {
  const stale: StaleDocReport[] = Array.from({ length: nStale }, (_, i) => ({
    kind: 'file',
    targetId: i + 1,
    targetPath: `src/f${i}.ts`,
    storedHash: 'old',
    currentHash: 'new',
  }));
  const undocumented: UndocumentedSymbolReport[] = Array.from({ length: nUndoc }, (_, i) => ({
    file: 'src/u.ts',
    symbol: `u${i}`,
    kind: 'function',
    startLine: i + 1,
  }));
  return {
    stale,
    undocumented,
    totals: { files: 5, docs: 5, publicSymbols: 9, stale: nStale, undocumented: nUndoc },
    hasDrift: nStale + nUndoc > 0,
    failing: nStale > 0 || (strict && nUndoc > 0),
    strict,
    truncated: false,
  };
}

describe('pageDriftReport', () => {
  const cases: [string, DriftReport][] = [
    ['stale only', report(1, 0)],
    ['stale and undocumented', report(2, 4)],
    ['undocumented only', report(0, 3)],
    ['undocumented only, strict', report(0, 3, true)],
    ['clean', report(0, 0)],
  ];

  it.each(cases)('keeps the gate, drift flag and totals on every page (%s)', (_, full) => {
    for (let offset = 0; offset <= 6; offset++) {
      for (let limit = 1; limit <= 6; limit++) {
        const page = pageDriftReport(full, { offset, limit });
        const end = offset + limit;
        expect(page).toEqual({
          ...full,
          stale: full.stale.slice(offset, end),
          undocumented: full.undocumented.slice(offset, end),
          truncated: offset > 0 || end < full.totals.stale || end < full.totals.undocumented,
        });
      }
    }
  });

  it('marks a last page that starts past entry 0 as truncated', () => {
    const page = pageDriftReport(report(2, 2), { offset: 1, limit: 5 });
    expect(page.stale).toHaveLength(1);
    expect(page.undocumented).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(pageDriftReport(report(2, 2), { offset: 0, limit: 2 }).truncated).toBe(false);
  });

  it('keeps `truncated` from an already truncated report', () => {
    const full = { ...report(1, 1), truncated: true };
    expect(pageDriftReport(full, { offset: 0, limit: 10 }).truncated).toBe(true);
  });
});

async function cli(args: string[]): Promise<{ out: string; code: number }> {
  const out: string[] = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runCli(args);
    return { out: out.join(''), code: typeof process.exitCode === 'number' ? process.exitCode : 0 };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
}

const PAGES = [[], ['--limit', '1'], ['--offset', '1'], ['--limit', '1', '--offset', '50']];

describe('drift gate under paging on a documented copy of fixtures/sample', () => {
  let base: string;
  let root: string;
  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'atlas-drift-paging-'));
    root = join(base, 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    await cli(['index', root]);
    await cli(['docs', '--offline', '--cwd', root]);
  }, 60_000);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  async function codes(extra: string[] = []): Promise<number[]> {
    const out: number[] = [];
    for (const page of PAGES) {
      for (const json of [[], ['--json']]) {
        out.push((await cli(['drift', ...json, ...page, ...extra, '--cwd', root])).code);
      }
    }
    return out;
  }

  function mcpFailing(): boolean[] {
    const ctx = createMcpContext({ root, offline: true });
    try {
      return [{}, { limit: 1 }, { offset: 1 }, { offset: 50, limit: 1 }].map(
        (p) => handleDriftTool(ctx, p).failing,
      );
    } finally {
      closeDatabase(ctx.db);
    }
  }

  it('exits 0 on every page when the docs are in sync, and 2 on every page once one is stale', async () => {
    expect(await codes()).toEqual(Array(8).fill(0));
    expect(mcpFailing()).toEqual([false, false, false, false]);

    appendFileSync(join(root, 'src', 'math.ts'), 'export function added(): number { return 1; }\n');
    await cli(['index', root]);
    const full = JSON.parse((await cli(['drift', '--json', '--cwd', root])).out) as DriftReport;
    expect(full.totals.stale).toBeGreaterThan(0);
    expect(full.totals.stale).toBeLessThan(50);

    const past = await cli(['drift', '--json', '--limit', '1', '--offset', '50', '--cwd', root]);
    const page = JSON.parse(past.out) as DriftReport;
    expect(page.stale).toEqual([]);
    expect(page.totals).toEqual(full.totals);
    expect(page.failing).toBe(true);
    expect(await codes()).toEqual(Array(8).fill(2));
    expect(mcpFailing()).toEqual([true, true, true, true]);
  });
});
