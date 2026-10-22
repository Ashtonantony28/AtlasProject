// SG27 (A10-04) carries .gitignore evaluation down the tree and tests segment-local sets by entry
// name; SG30 (A12-01) lets a deeper set re-include a directory a shallower one ignores. Git itself
// (`git ls-files -co --exclude-standard`) is the oracle.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { segmentLocal, walkRepo } from '../../src/core/ingest/walker.js';
import { detectLanguage } from '../../src/core/ingest/language.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The supported files git lists in `root`, with `exclude` as command-line patterns. */
function gitWalk(root: string, exclude: string[] = []): string[] {
  const git = (args: string[]): string =>
    execFileSync('git', ['-c', 'core.excludesFile=', ...args], { cwd: root }).toString();
  git(['init', '-q']);
  const x = exclude.flatMap((p) => ['-x', p]);
  return git(['ls-files', '-z', '-co', '--exclude-standard', ...x])
    .split('\0')
    .filter((p) => p && detectLanguage(p))
    .sort((a, b) => a.localeCompare(b));
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-gi-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** Asserts that walker and git agree, and returns the walked paths. */
function walked(root: string, exclude: string[] = []): string[] {
  const got = walkRepo(root, { exclude }).map((f) => f.relativePath);
  expect(got).toEqual(gitWalk(root, exclude));
  return got;
}

/** Deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PATTERNS = [
  '*.log',
  'build/',
  'b',
  '!keep.ts',
  'tmp*',
  '*.py',
  '!a.py',
  'a',
  'a/',
  '!b/',
  'c?.ts',
  '/a',
  'a/b',
  'b/*.ts',
  '**/c',
  'c/**',
  '!/b',
  '*/a.ts',
  '!**/keep.ts',
  '[ab].ts',
  '# note',
  '',
  'keep*',
  '!c',
  'x\\ y',
];
const NAMES = ['a', 'b', 'c', 'build', 'tmp1'];
const FILES = ['a.ts', 'b.ts', 'keep.ts', 'c1.ts', 'a.py', 'x.log', 'tmp2.ts'];

function randomTree(seed: number): string {
  const rand = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const root = mkdtempSync(join(tmpdir(), 'atlas-gi-'));
  dirs.push(root);
  const fill = (dir: string, depth: number): void => {
    mkdirSync(dir, { recursive: true });
    if (rand() < 0.5) {
      const n = 1 + Math.floor(rand() * 4);
      const lines = Array.from({ length: n }, () => pick(PATTERNS));
      writeFileSync(join(dir, '.gitignore'), lines.join('\n') + '\n');
    }
    for (const f of FILES) if (rand() < 0.5) writeFileSync(join(dir, f), 'x\n');
    if (depth < 4) for (const d of NAMES) if (rand() < 0.35) fill(join(dir, d), depth + 1);
  };
  fill(root, 0);
  return root;
}

describe('walker .gitignore evaluation (SG27, SG30)', () => {
  it('classifies segment-local rule sets', () => {
    expect(segmentLocal('*.log\nbuild0/\n!keep0.ts\ntmp0*\n# c\n\n')).toBe(true);
    expect(segmentLocal('/a\n')).toBe(false);
    expect(segmentLocal('a/b\n')).toBe(false);
    expect(segmentLocal('**/c\n')).toBe(false);
    expect(segmentLocal('x\\ y\n')).toBe(false);
  });

  it('returns the files git lists on random nested .gitignore trees', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const root = randomTree(seed);
      for (const exclude of [[], ['**/*.py', 'c/']]) {
        const got = walkRepo(root, { exclude }).map((f) => f.relativePath);
        expect(got, `seed ${seed} exclude ${exclude.join(',')}`).toEqual(gitWalk(root, exclude));
      }
    }
  });

  it('keeps a deeper re-include of a directory a shallower set ignores', () => {
    const root = tree({
      '.gitignore': 'build/\n*.log\n',
      'x/.gitignore': '!build/\n',
      'x/build/f.ts': '',
      'x/build/deep/h.ts': '',
      'x/build/deep/n.log': '',
      'y/build/g.ts': '',
    });
    expect(walked(root)).toEqual(['x/build/deep/h.ts', 'x/build/f.ts']);
  });

  it('does not re-include a file inside an ignored directory', () => {
    const root = tree({
      '.gitignore': 'build/\n!build/f.ts\n',
      'x/.gitignore': '!build/g.ts\n',
      'build/f.ts': '',
      'x/build/g.ts': '',
      'x/k.ts': '',
    });
    expect(walked(root)).toEqual(['x/k.ts']);
  });

  it('re-excludes a directory below a re-include', () => {
    const root = tree({
      '.gitignore': 'build/\n',
      'x/.gitignore': '!build/\n',
      'x/y/.gitignore': 'build/\n',
      'x/build/.gitignore': 'deep/\n*.py\n!keep.py\n',
      'x/build/f.ts': '',
      'x/build/a.py': '',
      'x/build/keep.py': '',
      'x/build/deep/h.ts': '',
      'x/y/build/g.ts': '',
    });
    expect(walked(root)).toEqual(['x/build/f.ts', 'x/build/keep.py']);
  });

  it('re-includes only where an anchored negation points', () => {
    const root = tree({
      '.gitignore': 'build/\n/lib/\n',
      'x/.gitignore': '!/build/\n',
      'x/build/f.ts': '',
      'x/z/build/g.ts': '',
      'lib/a.ts': '',
      'x/lib/b.ts': '',
    });
    expect(walked(root)).toEqual(['x/build/f.ts', 'x/lib/b.ts']);
  });

  it('lets the config exclude override a re-include', () => {
    const root = tree({
      '.gitignore': 'build/\n',
      'x/.gitignore': '!build/\n',
      'x/build/f.ts': '',
      'x/build/g.py': '',
    });
    expect(walked(root, ['*.py'])).toEqual(['x/build/f.ts']);
  });
});
