import { describe, expect, it } from 'vitest';
import { walkRepo } from '../../src/core/ingest/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('walkRepo', () => {
  it('finds the expected source files in the fixture', () => {
    const files = walkRepo(FIXTURE);
    const rels = files.map((f) => f.relativePath).sort();
    expect(rels).toEqual([
      'src/app.ts',
      'src/math.ts',
      'src/shapes.ts',
      'src/util.py',
    ]);
  });

  it('detects languages correctly', () => {
    const files = walkRepo(FIXTURE);
    const byPath = new Map(files.map((f) => [f.relativePath, f.language]));
    expect(byPath.get('src/math.ts')).toBe('typescript');
    expect(byPath.get('src/util.py')).toBe('python');
  });

  it('respects extra excludes', () => {
    const files = walkRepo(FIXTURE, { exclude: ['src/util.py'] });
    expect(files.find((f) => f.relativePath === 'src/util.py')).toBeUndefined();
  });
});
