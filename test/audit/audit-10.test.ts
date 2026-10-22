// AUDIT-10: performance under load (round 3). Each `it.fails` asserts the CORRECT (bounded)
// behaviour and currently fails, reproducing one finding in AUDIT-10.md (IDs A10-xx). When a
// finding is fixed its test starts passing, `it.fails` turns red, and it should become a plain
// `it`. These tests count work, not time; timings live in scripts/audit3-patho.mjs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModuleResolver, type ModuleFile } from '../../src/core/graph/modules.js';

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

  it.fails('A10-01: resolving one Python import does not probe every project root', () => {
    const resolver = new ModuleResolver(root, byPath);
    const from = byPath.get('proj0/src/pkg0/m.py')!;
    // Warm the per-repo discovery (config reads, package roots); it is paid once per resolve pass.
    resolver.resolve(from, 'pkg1');
    byPath.gets = 0;
    // A stdlib import that is not in the index, as most imports in a real project are.
    expect(resolver.resolve(from, 'os')).toBeNull();
    // Today this tries 3 candidates under each of the PROJECTS + 2 roots (183 lookups),
    // so a repo of N projects costs O(imports × N): 3.2 s/1k files at 500 projects.
    expect(byPath.gets).toBeLessThan(PROJECTS);
  });
});
