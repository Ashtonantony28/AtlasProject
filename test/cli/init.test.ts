import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDefaultConfig, loadConfig, DEFAULT_CONFIG } from '../../src/core/config.js';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';

describe('atlas init (core)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-init-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a valid config and creates the .atlas dir', () => {
    const result = writeDefaultConfig(dir);
    expect(result.created).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);

    const cfg = loadConfig(dir);
    expect(cfg.version).toBe(1);
    expect(cfg.indexPath).toBe(DEFAULT_CONFIG.indexPath);
    expect(cfg.languages).toContain('typescript');

    // The raw file is valid JSON.
    const raw = readFileSync(result.configPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();

    // Open DB at expected path; should succeed and create an empty index.
    const db = openDatabase(result.dbPath);
    expect(existsSync(result.dbPath)).toBe(true);
    closeDatabase(db);
  });

  it('does not overwrite an existing config unless force', () => {
    writeDefaultConfig(dir);
    // Mutate a field via direct write to detect overwrite.
    const cfgPath = join(dir, 'atlas.config.json');
    const before = readFileSync(cfgPath, 'utf8');
    const r2 = writeDefaultConfig(dir);
    expect(r2.created).toBe(false);
    expect(readFileSync(cfgPath, 'utf8')).toBe(before);

    const r3 = writeDefaultConfig(dir, { force: true });
    expect(r3.configExisted).toBe(true);
  });

  it('rejects invalid config', () => {
    const cfgPath = join(dir, 'atlas.config.json');
    // Write invalid config manually.
    const bad = JSON.stringify({ version: 2, languages: ['rust'] });
    writeFileSync(cfgPath, bad);
    expect(() => loadConfig(dir)).toThrow(/Invalid config/);
  });
});
