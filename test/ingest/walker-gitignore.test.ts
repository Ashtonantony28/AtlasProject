// SG27 (A10-04): the walker carries each .gitignore set's directory verdict down the tree and
// tests segment-local sets by entry name. These tests pin that the result is identical to the
// previous walk, which re-tested every full path against every ancestor set.
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import ignore from 'ignore';
import { segmentLocal, walkRepo } from '../../src/core/ingest/walker.js';
import { detectLanguage } from '../../src/core/ingest/language.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The pre-SG27 walk: every path tested against every ancestor set's `ig.test(fullRel)`. */
function referenceWalk(root: string, exclude: string[]): string[] {
  type R = { base: string; ig: ReturnType<typeof ignore> };
  const ex: R[] = exclude.length ? [{ base: '', ig: ignore().add(exclude) }] : [];
  const out: string[] = [];
  const toRel = (abs: string): string => relative(root, abs).split(sep).join('/');
  const isIgnored = (rules: R[], rel: string): boolean => {
    let ignored = false;
    for (const { base, ig } of rules) {
      const r = ig.test(base ? rel.slice(base.length + 1) : rel);
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    }
    return ignored;
  };
  const visit = (dir: string, inherited: R[]): void => {
    const gi = join(dir, '.gitignore');
    const parents = existsSync(gi)
      ? [...inherited, { base: toRel(dir), ig: ignore().add(readFileSync(gi, 'utf8')) }]
      : inherited;
    const rules = [...parents, ...ex];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = toRel(abs);
      if (e.isDirectory()) {
        if (['.git', '.atlas', 'node_modules', '__pycache__'].includes(e.name)) continue;
        if (!isIgnored(rules, rel + '/')) visit(abs, parents);
      } else if (!isIgnored(rules, rel) && detectLanguage(e.name)) out.push(rel);
    }
  };
  visit(root, []);
  return out.sort((a, b) => a.localeCompare(b));
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

describe('walker .gitignore evaluation (SG27, A10-04)', () => {
  it('classifies segment-local rule sets', () => {
    expect(segmentLocal('*.log\nbuild0/\n!keep0.ts\ntmp0*\n# c\n\n')).toBe(true);
    expect(segmentLocal('/a\n')).toBe(false);
    expect(segmentLocal('a/b\n')).toBe(false);
    expect(segmentLocal('**/c\n')).toBe(false);
    expect(segmentLocal('x\\ y\n')).toBe(false);
  });

  it('returns the same files as the previous walk on random nested .gitignore trees', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const root = randomTree(seed);
      for (const exclude of [[], ['**/*.py', 'c/']]) {
        const got = walkRepo(root, { exclude }).map((f) => f.relativePath);
        expect(got, `seed ${seed} exclude ${exclude.join(',')}`).toEqual(
          referenceWalk(root, exclude),
        );
      }
    }
  });

  it('keeps a deeper re-include of a directory a shallower set ignores', () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-gi-'));
    dirs.push(root);
    const w = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    w('.gitignore', 'build/\n*.log\n');
    w('x/.gitignore', '!build/\n');
    w('x/build/f.ts', '');
    w('y/build/g.ts', '');
    w('x/build/deep/h.ts', '');
    const got = walkRepo(root).map((f) => f.relativePath);
    expect(got).toEqual(referenceWalk(root, []));
  });
});
