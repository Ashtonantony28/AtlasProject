// SG15: CLI graph and drift stay complete by default and accept the same
// limit/offset/scope params as atlas_graph, atlas_drift and /api/graph.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriftReport } from '../../src/core/drift/index.js';
import type { GraphJson } from '../../src/core/graph/index.js';
import { FILES, FNS, indexBigRepo } from '../helpers/bigRepo.js';
import { runCli } from './helpers.js';

async function cli(args: string[]): Promise<{ out: string; code: number }> {
  const out: string[] = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let code = 0;
  try {
    await runCli(args);
    code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch {
    code = 1;
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return { out: out.join(''), code };
}

describe('CLI graph and drift on an index larger than the RPC limits', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-cli-bounded-'));
    await indexBigRepo(dir);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('graph exports everything by default and honours --limit/--file', async () => {
    const all = JSON.parse((await cli(['graph', '--cwd', dir])).out) as GraphJson;
    expect(all.nodes).toHaveLength(FILES * (FNS + 1));
    expect(all.truncated).toBe(false);
    expect(all.edges).toHaveLength(all.totals.edges);
    const some = JSON.parse((await cli(['graph', '--cwd', dir, '--limit', '10'])).out) as GraphJson;
    expect(some.nodes).toHaveLength(10);
    expect(some.truncated).toBe(true);
    const file = JSON.parse(
      (await cli(['graph', '--cwd', dir, '--file', 'src/m2.ts', '--edge-limit', '1'])).out,
    ) as GraphJson;
    expect(file.nodes).toHaveLength(FNS + 1);
    expect(file.edges).toHaveLength(1);
    expect((await cli(['graph', '--cwd', dir, '--limit', '0'])).code).toBe(1);
  });

  it('drift --json is complete by default and paged with --limit/--offset', async () => {
    const full = await cli(['drift', '--json', '--skip-architecture', '--cwd', dir]);
    expect(full.code).toBe(2);
    const report = JSON.parse(full.out) as DriftReport;
    expect(report.undocumented).toHaveLength(FILES * FNS);
    expect(report.truncated).toBe(false);
    const paged = await cli(['drift', '--json', '--limit', '3', '--offset', '1', '--cwd', dir]);
    expect(paged.code).toBe(2);
    const page = JSON.parse(paged.out) as DriftReport;
    expect(page.undocumented).toEqual(report.undocumented.slice(1, 4));
    expect(page.totals.undocumented).toBe(FILES * FNS);
    expect(page.truncated).toBe(true);
    const text = await cli(['drift', '--limit', '2', '--cwd', dir]);
    expect(text.out).toMatch(/showing 2 of \d+ stale, 2 of 1200 undocumented/);
  });
});
