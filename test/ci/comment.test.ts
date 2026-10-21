import { describe, expect, it } from 'vitest';
import { renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import type { DriftReport } from '../../src/core/drift/index.js';

describe('renderComment', () => {
  it('reports happy path with a checkmark when no drift', () => {
    const report: DriftReport = {
      stale: [],
      undocumented: [],
      totals: { files: 4, docs: 5, publicSymbols: 19 },
      hasDrift: false,
      failing: false,
      strict: false,
    };
    const md = renderComment(report);
    expect(md).toMatch(/Atlas — documentation report/);
    expect(md).toMatch(/All docs are in sync/);
    expect(md).toMatch(/4 files/);
  });

  it('renders both stale and undocumented sections', () => {
    const report: DriftReport = {
      stale: [
        { kind: 'file', targetId: 1, targetPath: 'src/foo.ts', storedHash: 'deadbeefcafe', currentHash: 'feedfacecafe' },
      ],
      undocumented: [
        { file: 'src/foo.ts', symbol: 'foo', kind: 'function', startLine: 12 },
        { file: 'src/foo.ts', symbol: 'Bar', kind: 'class', startLine: 50 },
      ],
      totals: { files: 1, docs: 1, publicSymbols: 5 },
      hasDrift: true,
      failing: true,
      strict: false,
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
    const yml = readFileSync(
      new URL('../../.github/workflows/atlas.yml', import.meta.url),
      'utf8',
    );
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
