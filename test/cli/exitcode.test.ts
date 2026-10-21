import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeGitRepo, runCli } from './helpers.js';

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli/index.ts');

describe('CLI exit codes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = makeGitRepo('atlas-exit-');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', dir]);
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('drift sets exit code 2 in-process without exiting', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['drift', '--cwd', dir]);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(2);
  });

  it('drift exits 2 and closes the DB (no lingering WAL)', () => {
    const wal = join(dir, '.atlas/index.db-wal');
    const r = spawnSync(TSX, [CLI, 'drift', '--cwd', dir], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/drift|undocumented|stale/i);
    expect(existsSync(wal)).toBe(false);
  });

  it('errors still exit 1', () => {
    const r = spawnSync(TSX, [CLI, 'search', 'x', '--kind', 'bogus', '--cwd', dir], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown kind/);
    expect(existsSync(join(dir, '.atlas/index.db-wal'))).toBe(false);
  });
});
