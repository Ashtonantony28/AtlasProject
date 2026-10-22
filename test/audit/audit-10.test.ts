// AUDIT-10: performance under load (round 3). Each test asserts the CORRECT (bounded)
// behaviour for one finding in AUDIT-10.md (IDs A10-xx); A10-01 and A10-05 were fixed in SG27.
// These tests count work, not time; timings live in scripts/audit3-patho.mjs and test/perf.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModuleResolver, PathsMatcher, type ModuleFile } from '../../src/core/graph/modules.js';

const PROJECTS = 60;

/** Map that counts `get` calls, standing in for the resolver's path index. */
class CountingMap<K, V> extends Map<K, V> {
  gets = 0;
  override get(key: K): V | undefined {
    this.gets++;
    return super.get(key);
  }
}

describe('AUDIT-10 performance under load', () => {
  let dir: string;
  let root: string;
  const byPath = new CountingMap<string, ModuleFile>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-audit10-'));
    root = join(dir, 'repo');
    const write = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
      if (rel.endsWith('.py')) byPath.set(rel, { filePath: rel, language: 'python' });
    };
    // A Python monorepo: PROJECTS projects, each a pyproject.toml with a `src/` layout.
    for (let p = 0; p < PROJECTS; p++) {
      write(`proj${p}/pyproject.toml`, `[project]\nname = "proj${p}"\n`);
      write(`proj${p}/src/pkg${p}/__init__.py`, '');
      write(`proj${p}/src/pkg${p}/m.py`, 'import os\n');
    }
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('A10-01: resolving one Python import does not probe every project root', () => {
    const resolver = new ModuleResolver(root, byPath);
    const from = byPath.get('proj0/src/pkg0/m.py')!;
    // Warm the per-repo discovery (config reads, package roots); it is paid once per resolve pass.
    resolver.resolve(from, 'pkg1');
    byPath.gets = 0;
    // A stdlib import that is not in the index, as most imports in a real project are.
    expect(resolver.resolve(from, 'os')).toBeNull();
    // Before SG27 this tried 3 candidates under each of the PROJECTS + 2 roots (183 lookups),
    // so a repo of N projects cost O(imports × N): 3.2 s/1k files at 500 projects.
    expect(byPath.gets).toBe(0);
    // A real import probes only the root that holds the package.
    byPath.gets = 0;
    expect(resolver.resolve(from, `pkg${PROJECTS - 1}.m`)?.filePath).toBe(
      `proj${PROJECTS - 1}/src/pkg${PROJECTS - 1}/m.py`,
    );
    expect(byPath.gets).toBeLessThanOrEqual(3);
    expect(resolver.resolve(from, 'pkg7')?.filePath).toBe('proj7/src/pkg7/__init__.py');
    expect(resolver.submodule(from, 'pkg3', 'm')?.filePath).toBe('proj3/src/pkg3/m.py');
    expect(resolver.resolve(from, '.m')?.filePath).toBe('proj0/src/pkg0/m.py');
  });

  it('A10-05: tsconfig `paths` lookup does not scan every alias, and keeps TS precedence', () => {
    const N = 2000;
    const paths = [
      { pattern: '*', targets: ['any/*'], base: '' },
      { pattern: '@m/*', targets: ['m/*'], base: '' },
      { pattern: '@m/p1*', targets: ['first/*'], base: '' },
      { pattern: '@m/p1*', targets: ['second/*'], base: '' },
      { pattern: '@m/x*', targets: ['x/*'], base: '' },
      { pattern: '@m/x*.css', targets: ['css/*'], base: '' },
    ];
    for (let p = 0; p < N; p++) paths.push({ pattern: `@m/p${p}`, targets: [`p${p}`], base: '' });
    const m = new PathsMatcher(paths);
    // Reference: the pre-SG27 linear scan (exact wins, else longest prefix, first on a tie).
    const linear = (spec: string): string | null => {
      let best: (typeof paths)[number] | null = null;
      let bestLen = -1;
      for (const p of paths) {
        const i = p.pattern.indexOf('*');
        if (i < 0) {
          if (spec === p.pattern) return p.targets[0]!;
          continue;
        }
        const [pre, suf] = [p.pattern.slice(0, i), p.pattern.slice(i + 1)];
        const fits =
          spec.length >= pre.length + suf.length && spec.startsWith(pre) && spec.endsWith(suf);
        if (fits && pre.length > bestLen) [best, bestLen] = [p, pre.length];
      }
      return best ? best.targets[0]! : null;
    };
    const specs = [
      '@m/p1',
      '@m/p17',
      '@m/p1999',
      '@m/p2000',
      '@m/q',
      '@m/x.css',
      '@m/xa.css',
      '@m/x',
      '@m/p1x',
      'lodash',
      '',
      '@m/',
      '@m/p',
    ];
    for (const s of specs) expect(m.match(s)?.targets[0] ?? null, s).toBe(linear(s));
    m.probes = 0;
    m.match('@m/p1999');
    m.match('@m/zzz/deep/module');
    // At most one probe per distinct star-prefix length (4 here) plus the exact map, per call.
    expect(m.probes).toBeLessThanOrEqual(2 * 5);
  });
});
