import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolvePaths, writeDefaultConfig } from '../../src/core/config.js';
import { walkRepo } from '../../src/core/ingest/walker.js';

describe('config location', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('init writes .atlas/config.json and nothing at the root', () => {
    const r = writeDefaultConfig(dir);
    expect(r.configPath).toBe(join(dir, '.atlas', 'config.json'));
    expect(loadConfig(dir).version).toBe(1);
  });

  it('falls back to a legacy root atlas.config.json (read-only)', () => {
    writeFileSync(
      join(dir, 'atlas.config.json'),
      JSON.stringify({ version: 1, tokenBudget: 1234 }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.tokenBudget).toBe(1234);
    expect(resolvePaths(dir, cfg).configPath).toBe(join(dir, 'atlas.config.json'));
  });

  it('prefers .atlas/config.json over the legacy file', () => {
    writeFileSync(join(dir, 'atlas.config.json'), JSON.stringify({ version: 1, tokenBudget: 1 }));
    mkdirSync(join(dir, '.atlas'));
    writeFileSync(join(dir, '.atlas/config.json'), JSON.stringify({ version: 1, tokenBudget: 2 }));
    expect(loadConfig(dir).tokenBudget).toBe(2);
  });

  it('defaults include to [] (everything)', () => {
    expect(loadConfig(dir).include).toEqual([]);
  });
});

describe('walker honours languages and include', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-walk-'));
    for (const p of ['src/a.ts', 'src/b.py', 'lib/c.js', 'lib/d.py', 'e.ts']) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), '\n');
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const paths = (opts: Parameters<typeof walkRepo>[1]) =>
    walkRepo(dir, opts).map((f) => f.relativePath);

  it('walks everything by default', () => {
    expect(paths({ include: [] })).toEqual([
      'e.ts',
      'lib/c.js',
      'lib/d.py',
      'src/a.ts',
      'src/b.py',
    ]);
  });

  it("languages: ['python'] keeps only .py", () => {
    expect(paths({ languages: ['python'] })).toEqual(['lib/d.py', 'src/b.py']);
  });

  it("include: ['src/**'] restricts the walk", () => {
    expect(paths({ include: ['src/**'] })).toEqual(['src/a.ts', 'src/b.py']);
  });
});

describe('init with a legacy config', () => {
  it('leaves the legacy file in charge and writes no root file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-legacy-'));
    try {
      writeFileSync(join(dir, 'atlas.config.json'), JSON.stringify({ version: 1, tokenBudget: 7 }));
      const r = writeDefaultConfig(dir);
      expect(r.configExisted).toBe(true);
      expect(r.configPath).toBe(join(dir, 'atlas.config.json'));
      expect(loadConfig(dir).tokenBudget).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
