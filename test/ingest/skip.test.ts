import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { walkRepo, type WalkOptions } from '../../src/core/ingest/walker.js';
import { DEFAULT_CONFIG, loadConfig } from '../../src/core/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-skip-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const walk = (root: string, opts: WalkOptions = { exclude: DEFAULT_CONFIG.exclude }): string[] =>
  walkRepo(root, opts).map((f) => f.relativePath);

describe('walker skip rules (A5-03)', () => {
  it('indexes nested build, dist, coverage, vendor, venv and cache directories by default', () => {
    const nested = [
      'src/build/compile.ts',
      'lib/vendor/x.js',
      'src/dist/d.ts',
      'pkg/coverage/c.py',
      'pip/_internal/operations/build/wheel.py',
      'Lib/venv/__init__.py',
      'app/.cache/k.ts',
      'web/.next/n.js',
    ];
    const root = tree(Object.fromEntries(nested.map((p) => [p, '\n'])));
    expect(walk(root)).toEqual([...nested].sort((a, b) => a.localeCompare(b)));
  });

  it('skips the root-level generated directories in the default exclude', () => {
    const root = tree({
      'build/a.ts': '\n',
      'dist/b.js': '\n',
      'coverage/c.js': '\n',
      '.next/d.js': '\n',
      '.cache/e.ts': '\n',
      'venv/f.py': '\n',
      '.venv/g.py': '\n',
      'src/main.ts': '\n',
    });
    expect(walk(root)).toEqual(['src/main.ts']);
  });

  it('indexes a root directory once its entry is removed from exclude', () => {
    const root = tree({ 'build/a.ts': '\n', 'dist/b.js': '\n' });
    const exclude = DEFAULT_CONFIG.exclude.filter((g) => g !== 'build/**');
    expect(walk(root, { exclude })).toEqual(['build/a.ts']);
  });

  it('with no exclude, only the never-source names are skipped', () => {
    const root = tree({ 'build/a.ts': '\n', 'dist/b.js': '\n', 'node_modules/m/i.js': '\n' });
    expect(walk(root, {})).toEqual(['build/a.ts', 'dist/b.js']);
  });

  it('skips .git, .atlas, node_modules and __pycache__ at any depth', () => {
    const root = tree({
      '.git/hooks/h.js': '\n',
      'pkg/.git/x.js': '\n',
      'packages/a/node_modules/dep/index.js': '\n',
      'packages/a/.atlas/x.ts': '\n',
      'src/__pycache__/m.py': '\n',
      'packages/a/src/a.ts': '\n',
    });
    expect(walk(root, {})).toEqual(['packages/a/src/a.ts']);
  });

  it('skips virtualenvs (a directory holding pyvenv.cfg) at any depth, whatever their name', () => {
    const root = tree({
      'services/api/env/pyvenv.cfg': 'home = /usr/bin\n',
      'services/api/env/lib/site.py': '\n',
      'services/api/app.py': '\n',
    });
    expect(walk(root, {})).toEqual(['services/api/app.py']);
  });

  it('an unanchored root .gitignore pattern still applies at any depth', () => {
    const root = tree({
      '.gitignore': 'build/\n',
      'src/build/a.ts': '\n',
      'src/b.ts': '\n',
    });
    expect(walk(root)).toEqual(['src/b.ts']);
  });

  it('reads nested .gitignore files relative to their own directory', () => {
    const root = tree({
      'packages/a/.gitignore': 'dist/\n/gen.ts\n',
      'packages/a/dist/out.js': '\n',
      'packages/a/gen.ts': '\n',
      'packages/a/src/gen.ts': '\n',
      'packages/b/dist/out.js': '\n',
    });
    expect(walk(root)).toEqual(['packages/a/src/gen.ts', 'packages/b/dist/out.js']);
  });

  it('a deeper .gitignore overrides a shallower one, and exclude is applied last', () => {
    const root = tree({
      '.gitignore': '*.gen.ts\n',
      'src/.gitignore': '!keep.gen.ts\n',
      'src/keep.gen.ts': '\n',
      'src/drop.gen.ts': '\n',
      'lib/keep.gen.ts': '\n',
      'lib/x.ts': '\n',
    });
    expect(walk(root, {})).toEqual(['lib/x.ts', 'src/keep.gen.ts']);
    expect(walk(root, { exclude: ['src/keep.gen.ts'] })).toEqual(['lib/x.ts']);
    expect(walk(root, { exclude: ['!lib/keep.gen.ts'] })).toEqual([
      'lib/keep.gen.ts',
      'lib/x.ts',
      'src/keep.gen.ts',
    ]);
  });

  it('include restricts the walk without re-adding ignored paths', () => {
    const root = tree({
      '.gitignore': 'src/build/tmp/\n',
      'src/build/a.ts': '\n',
      'src/build/tmp/t.ts': '\n',
      'src/b.ts': '\n',
    });
    expect(walk(root, { include: ['src/build/**'] })).toEqual(['src/build/a.ts']);
  });

  it('matches `git ls-files --cached --others --exclude-standard` on a mixed tree', () => {
    const root = tree({
      '.gitignore': '*.log\n/out/\ntmp/\n!keep/tmp/\n',
      'src/build/a.ts': '\n',
      'src/tmp/x.ts': '\n',
      'keep/tmp/y.ts': '\n',
      'out/z.js': '\n',
      'lib/out/w.js': '\n',
      'packages/p/.gitignore': 'dist/\n!dist/types.d.ts\n*.py\n!main.py\n',
      'packages/p/dist/i.js': '\n',
      'packages/p/main.py': '\n',
      'packages/p/other.py': '\n',
      'packages/p/sub/.gitignore': '!other.py\n',
      'packages/p/sub/other.py': '\n',
      'packages/q/dist/i.js': '\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const git = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((p) => /\.(ts|js|py)$/.test(p))
      .sort((a, b) => a.localeCompare(b));
    expect(walk(root, {})).toEqual(git);
  });

  it('indexing Atlas itself with its committed config skips dist, coverage and .atlas', () => {
    const repo = resolve(__dirname, '../..');
    const paths = walk(repo, { exclude: loadConfig(repo).exclude });
    expect(paths.some((p) => p.startsWith('src/core/ingest/'))).toBe(true);
    expect(paths.filter((p) => /^(dist|coverage|\.atlas|node_modules)\//.test(p))).toEqual([]);
  });
});
