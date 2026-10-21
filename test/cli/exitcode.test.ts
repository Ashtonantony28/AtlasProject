import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
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
    // Docs exist (drift with no docs at all exits 1), but one names none of its exports.
    await runCli(['docs', '--offline', '--cwd', dir]);
    const db = openDatabase(join(dir, '.atlas', 'index.db'));
    db.prepare(
      "UPDATE docs SET content = '# math' WHERE target_kind = 'file' AND target_id = (SELECT id FROM files WHERE path = 'src/math.ts')",
    ).run();
    closeDatabase(db);
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('drift --strict sets exit code 2 in-process without exiting', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['drift', '--strict', '--cwd', dir]);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(2);
  });

  it('drift reports undocumented symbols but exits 0 when no doc is stale', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    await runCli(['drift', '--cwd', dir]);
    vi.restoreAllMocks();
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.join('')).toMatch(/Undocumented/);
  });

  it('drift exits 1 when the index has no docs at all, like --docs-dir with none', async () => {
    const db = openDatabase(join(dir, '.atlas', 'index.db'));
    db.prepare('DELETE FROM docs').run();
    closeDatabase(db);
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
    await runCli(['drift', '--cwd', dir]);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(1);
    expect(err.join('')).toMatch(/no docs found in the index/);
  });

  it('drift --strict exits 2 and closes the DB (no lingering WAL)', () => {
    const wal = join(dir, '.atlas/index.db-wal');
    const r = spawnSync(TSX, [CLI, 'drift', '--strict', '--cwd', dir], { encoding: 'utf8' });
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
