import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { gitStatus, makeGitRepo, runCli } from './helpers.js';

describe('CLI is read-only on the target repo', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeGitRepo('atlas-ro-');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('init, index, docs, drift, graph and search write only under .atlas/', async () => {
    await runCli(['init', '--cwd', dir]);
    await runCli(['index', dir]);
    await runCli(['docs', '--offline', '--cwd', dir]);
    await runCli(['drift', '--cwd', dir]);
    await runCli(['graph', '--cwd', dir]);
    await runCli(['search', 'user', '--cwd', dir]);
    const status = gitStatus(dir);
    expect(status.length).toBeGreaterThan(0);
    for (const line of status) expect(line.slice(3)).toMatch(/^\.atlas\//);
  });

  it('index without init also writes only under .atlas/', async () => {
    await runCli(['index', dir]);
    for (const line of gitStatus(dir)) expect(line.slice(3)).toMatch(/^\.atlas\//);
  });
});
