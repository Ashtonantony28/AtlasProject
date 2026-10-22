import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDriftReport, renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { pageDriftReport, type DriftReport } from '../../src/core/drift/index.js';
import { runCli } from '../cli/helpers.js';

describe('renderComment', () => {
  it('reports happy path with a checkmark when no drift', () => {
    const report: DriftReport = {
      stale: [],
      undocumented: [],
      totals: { files: 4, docs: 5, publicSymbols: 19, stale: 0, undocumented: 0 },
      hasDrift: false,
      failing: false,
      strict: false,
      truncated: false,
    };
    const md = renderComment(report);
    expect(md).toMatch(/Atlas — documentation report/);
    expect(md).toMatch(/All docs are in sync/);
    expect(md).toMatch(/4 files/);
  });

  it('renders both stale and undocumented sections', () => {
    const report: DriftReport = {
      stale: [
        {
          kind: 'file',
          targetId: 1,
          targetPath: 'src/foo.ts',
          storedHash: 'deadbeefcafe',
          currentHash: 'feedfacecafe',
        },
      ],
      undocumented: [
        { file: 'src/foo.ts', symbol: 'foo', kind: 'function', startLine: 12 },
        { file: 'src/foo.ts', symbol: 'Bar', kind: 'class', startLine: 50 },
      ],
      totals: { files: 1, docs: 1, publicSymbols: 5, stale: 1, undocumented: 2 },
      hasDrift: true,
      failing: true,
      strict: false,
      truncated: false,
    };
    const md = renderComment(report);
    expect(md).toMatch(/Stale docs/);
    expect(md).toMatch(/Undocumented public symbols/);
    expect(md).toMatch(/`src\/foo.ts:12`/);
    expect(md).toMatch(/`deadbeef`/);
    expect(md).toMatch(/`feedface`/);
  });

  it('truncates long undocumented lists', () => {
    const undocumented = Array.from({ length: 50 }, (_, i) => ({
      file: 'a.ts',
      symbol: `sym${i}`,
      kind: 'function',
      startLine: i + 1,
    }));
    const report: DriftReport = {
      stale: [],
      undocumented,
      totals: { files: 1, docs: 0, publicSymbols: 50, stale: 0, undocumented: 50 },
      hasDrift: true,
      failing: false,
      strict: false,
      truncated: false,
    };
    const md = renderComment(report);
    expect(md).toMatch(/…and 20 more\./);
  });
});

describe('workflow yaml is well-formed', () => {
  it('parses and includes the expected jobs', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync(new URL('../../.github/workflows/atlas.yml', import.meta.url), 'utf8');
    // Minimal sanity: required keys are present.
    expect(yml).toMatch(/name:\s+atlas/);
    expect(yml).toMatch(/jobs:/);
    expect(yml).toMatch(/runs-on:\s+ubuntu-latest/);
    expect(yml).toMatch(/atlas drift/);
    expect(yml).toMatch(/ci-comment/);
    expect(yml).toMatch(/permissions:/);
    expect(yml).toMatch(/pull-requests:\s+write/);
  });
});

describe('renderComment on a paged report (A5-09, A7-04)', () => {
  const full: DriftReport = {
    stale: ['a.ts', 'b.ts', 'architecture'].map((p, i) => ({
      kind: p === 'architecture' ? 'architecture' : 'file',
      targetId: i,
      targetPath: p,
      storedHash: `${i}`.repeat(12),
      currentHash: `${i + 5}`.repeat(12),
    })),
    undocumented: ['x', 'y', 'z'].map((s, i) => ({
      file: 'a.ts',
      symbol: s,
      kind: 'function',
      startLine: i + 1,
    })),
    totals: { files: 3, docs: 3, publicSymbols: 22, stale: 3, undocumented: 3 },
    hasDrift: true,
    failing: true,
    strict: false,
    truncated: false,
  };

  it('counts from totals and says the lists are one page', () => {
    const md = renderComment(pageDriftReport(full, { offset: 0, limit: 1 }));
    expect(md).toContain('**Drift check: failed** (3 stale doc(s)).');
    expect(md).toContain('### Stale docs (3, showing 1)');
    expect(md).toContain('### Undocumented public symbols (3 of 22, showing 1)');
    expect(md).toContain('1 of 3 stale docs, 1 of 3 undocumented symbols listed');
    expect(md).toContain('`a.ts`');
    expect(md).not.toContain('`b.ts`');
    expect(md).toContain('…and 2 more.');
  });

  it('an offset past the end still names the totals and renders no empty tables', () => {
    const md = renderComment(pageDriftReport(full, { offset: 5, limit: 1 }));
    expect(md).toContain('**Drift check: failed** (3 stale doc(s)).');
    expect(md).toContain('### Stale docs (3, showing 0)');
    expect(md).not.toContain('| Kind |');
    expect(md).not.toContain('()');
  });

  it('--strict counts undocumented symbols from totals', () => {
    const strict = { ...full, strict: true, stale: [], totals: { ...full.totals, stale: 0 } };
    const md = renderComment(pageDriftReport(strict, { offset: 0, limit: 2 }));
    expect(md).toContain('**Drift check: failed** (3 undocumented public symbol(s) (--strict)).');
    expect(md).not.toContain('### Stale docs');
  });

  it('a complete report has no paging note or "showing"', () => {
    const md = renderComment(full);
    expect(md).not.toMatch(/showing|one page/);
    expect(md).toContain('### Stale docs (3)');
  });
});

describe('parseDriftReport', () => {
  const current = {
    stale: [],
    undocumented: [],
    totals: { files: 1, docs: 1, publicSymbols: 0, stale: 0, undocumented: 0 },
    hasDrift: false,
    failing: false,
    strict: false,
    truncated: false,
  };

  it('round-trips a current report', () => {
    expect(parseDriftReport(JSON.stringify(current))).toEqual(current);
  });

  it('rejects non-JSON and non-reports with a clear message', () => {
    expect(() => parseDriftReport('nope')).toThrow(/drift report is not JSON/);
    expect(() => parseDriftReport('{}')).toThrow(/not a drift report .*stale/);
    expect(() => parseDriftReport('[]')).toThrow(/not a drift report/);
    expect(() =>
      parseDriftReport(JSON.stringify({ ...current, totals: { ...current.totals, stale: -1 } })),
    ).toThrow(/totals\.stale/);
  });

  it('derives the fields an older (pre-paging) report lacks from its complete lists', () => {
    const old = {
      stale: [
        { kind: 'file', targetId: 1, targetPath: 'a.ts', storedHash: 'aa', currentHash: 'bb' },
      ],
      undocumented: [{ file: 'a.ts', symbol: 'f', kind: 'function', startLine: 1 }],
      totals: { files: 1, docs: 1, publicSymbols: 1 },
      hasDrift: true,
    };
    const r = parseDriftReport(JSON.stringify(old));
    expect(r).toMatchObject({
      totals: { stale: 1, undocumented: 1 },
      failing: true,
      strict: false,
      truncated: false,
    });
    expect(renderComment(r)).toContain('**Drift check: failed** (1 stale doc(s)).');
  });
});

describe('atlas ci-comment', () => {
  let dir: string;
  afterEach(() => {
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders a paged report from --in with the totals', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-cicomment-'));
    const report: DriftReport = {
      stale: [
        {
          kind: 'file',
          targetId: 1,
          targetPath: 'a.ts',
          storedHash: 'aaaaaaaa',
          currentHash: 'bb',
        },
      ],
      undocumented: [],
      totals: { files: 3, docs: 3, publicSymbols: 4, stale: 3, undocumented: 0 },
      hasDrift: true,
      failing: true,
      strict: false,
      truncated: true,
    };
    writeFileSync(join(dir, 'd.json'), JSON.stringify(report));
    await runCli(['ci-comment', '--in', join(dir, 'd.json'), '--out', join(dir, 'c.md')]);
    const md = readFileSync(join(dir, 'c.md'), 'utf8');
    expect(md).toContain('(3 stale doc(s))');
    expect(md).toContain('1 of 3 stale docs');
  });

  it('fails on input that is not a drift report', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-cicomment-'));
    writeFileSync(join(dir, 'd.json'), '{}');
    await expect(runCli(['ci-comment', '--in', join(dir, 'd.json')])).rejects.toThrow(
      /not a drift report/,
    );
  });
});
