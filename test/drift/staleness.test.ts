import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  getAllFiles,
  getDoc,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo, sha256 } from '../../src/core/ingest/index.js';
import {
  architectureContextToPrompt,
  buildArchitectureContext,
  buildModuleContext,
  createOfflineClient,
  moduleContextToPrompt,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

function edit(root: string, rel: string, from: string, to: string): void {
  const p = join(root, rel);
  const src = readFileSync(p, 'utf8');
  expect(src).toContain(from);
  writeFileSync(p, src.replace(from, to));
}

describe('docs.source_hash is the grounding-context hash', () => {
  let dir: string;
  let root: string;
  let db: DB;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-stale-'));
    root = join(dir, 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores sha256(prompt) for module and architecture docs', () => {
    for (const file of getAllFiles(db)) {
      const prompt = moduleContextToPrompt(buildModuleContext(db, root, file));
      expect(getDoc(db, 'file', file.id)?.source_hash).toBe(sha256(prompt));
      expect(getDoc(db, 'file', file.id)?.source_hash).not.toBe(file.content_hash);
    }
    const arch = architectureContextToPrompt(buildArchitectureContext(db));
    expect(getDoc(db, 'architecture', 0)?.source_hash).toBe(sha256(arch));
  });

  it('is clean right after synthesis', () => {
    const report = detectDrift(db, { root });
    expect(report.stale).toEqual([]);
    expect(report.undocumented).toEqual([]);
    expect(report.hasDrift).toBe(false);
  });

  it('reports exactly the mutated file as stale', async () => {
    edit(root, 'src/math.ts', 'return a * b;', 'return b * a;');
    await indexRepo(db, root);
    const report = detectDrift(db, { root });
    expect(report.stale.map((s) => `${s.kind}:${s.targetPath}`)).toEqual(['file:src/math.ts']);
    expect(report.hasDrift).toBe(true);
  });

  it('reports a doc stale when only its graph neighbourhood changed', async () => {
    edit(
      root,
      'src/app.ts',
      "import { add } from './math.js';",
      "import { add, multiply } from './math.js';",
    );
    edit(
      root,
      'src/app.ts',
      'const t = totalArea(2, 3);',
      'const t = multiply(totalArea(2, 3), 1);',
    );
    await indexRepo(db, root);
    const stale = detectDrift(db, { root }).stale.filter((s) => s.kind === 'file');
    expect(stale.map((s) => s.targetPath).sort()).toEqual(['src/app.ts', 'src/math.ts']);
  });

  it('regenerates only docs whose context hash changed', async () => {
    edit(root, 'src/math.ts', 'return a * b;', 'return b * a;');
    await indexRepo(db, root);
    const paths: string[] = [];
    const stats = await synthesizeDocs(db, createOfflineClient(), {
      root,
      tokenBudget: 200_000,
      onProgress: (e) => {
        if (e.status === 'generated') paths.push(e.path ?? e.kind);
      },
    });
    expect(paths).toEqual(['src/math.ts']);
    expect(stats.modulesCached).toBe(3);
    expect(detectDrift(db, { root }).stale).toEqual([]);
  });
});

describe('atlas docs → atlas drift (CLI)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-stale-cli-'));
    cpSync(SAMPLE, dir, { recursive: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('drift right after docs on a fresh index exits 0', async () => {
    await runCli(['index', dir]);
    await runCli(['docs', '--offline', '--cwd', dir]);
    await runCli(['drift', '--cwd', dir]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('drift exits 0 after docs even when the budget leaves modules undocumented', async () => {
    await runCli(['index', dir]);
    // The offline mock spends ~2.5k tokens on the sample: 2k pays for some docs, not all.
    await runCli(['docs', '--offline', '--budget', '2000', '--cwd', dir]);
    const out = vi
      .mocked(process.stdout.write)
      .mock.calls.map((c) => String(c[0]))
      .join('');
    expect(out).toMatch(/generated [1-9]\d*, cached 0, skipped [1-9]/);
    await runCli(['drift', '--cwd', dir]);
    expect(process.exitCode ?? 0).toBe(0);
    await runCli(['drift', '--strict', '--cwd', dir]);
    expect(process.exitCode).toBe(2);
  });

  it('drift exits 2 after a source change without regenerating docs', async () => {
    await runCli(['index', dir]);
    await runCli(['docs', '--offline', '--cwd', dir]);
    edit(dir, 'src/shapes.ts', "super('circle');", "super('round');");
    await runCli(['index', dir]);
    vi.mocked(process.stdout.write).mockClear();
    await runCli(['drift', '--json', '--cwd', dir]);
    expect(process.exitCode).toBe(2);
    const json = vi
      .mocked(process.stdout.write)
      .mock.calls.map((c) => String(c[0]))
      .join('');
    const report = JSON.parse(json) as { stale: Array<{ targetPath: string }> };
    expect(report.stale.map((s) => s.targetPath)).toEqual(['src/shapes.ts']);
  });
});
