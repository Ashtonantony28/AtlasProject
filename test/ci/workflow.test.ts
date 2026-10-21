// End-to-end simulation of the GitHub Action: index → docs (offline) →
// drift --json → ci-comment. Asserts that the comment payload contains the
// drift the CI would post. This stands in for `act --dry-run`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  cpSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { synthesizeDocs, createOfflineClient } from '../../src/core/synth/index.js';
import { detectDrift, type DriftReport } from '../../src/core/drift/index.js';
import { renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { makeGitRepo, runCli } from '../cli/helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('CI workflow end-to-end (index → drift → ci-comment)', () => {
  let dir: string;
  let workRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-ci-e2e-'));
    workRoot = join(dir, 'repo');
    cpSync(FIXTURE, workRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces the "all docs in sync" payload after a clean index + synth', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    await synthesizeDocs(db, createOfflineClient(), { root: workRoot, tokenBudget: 200_000 });

    // Drift report (as the workflow would capture it).
    const report = detectDrift(db, { root: workRoot });
    // After offline synthesis, every public symbol's name is in its doc → no drift.
    expect(report.hasDrift).toBe(false);

    const comment = renderComment(report);
    // The payload the workflow would post.
    expect(comment).toMatch(/All docs are in sync/);
    expect(comment).toMatch(/4 files/);
    expect(comment).not.toMatch(/Stale docs/);
    expect(comment).not.toMatch(/Undocumented public symbols/);

    closeDatabase(db);
  });

  it('produces a stale-doc + undocumented payload after a fixture mutation', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    await synthesizeDocs(db, createOfflineClient(), { root: workRoot, tokenBudget: 200_000 });

    // Simulate a developer adding a brand-new public symbol AND mutating an
    // existing file's body — the two kinds of drift the workflow catches.
    const newFn = '\nexport function freshlyAdded(): number { return 42; }\n';
    const mathPath = join(workRoot, 'src/math.ts');
    writeFileSync(mathPath, readFileSync(mathPath, 'utf8') + newFn);
    await indexRepo(db, workRoot, { force: true });

    const report = detectDrift(db, { root: workRoot });
    expect(report.hasDrift).toBe(true);
    // The mutated math file should be stale.
    expect(report.stale.some((s) => s.targetPath === 'src/math.ts')).toBe(true);
    // The newly added symbol must be flagged as undocumented.
    expect(report.undocumented.some((u) => u.symbol === 'freshlyAdded')).toBe(true);

    const comment = renderComment(report);
    // Payload sanity for the CI-posted comment.
    expect(comment).toMatch(/Atlas — documentation report/);
    expect(comment).toMatch(/### Stale docs/);
    expect(comment).toMatch(/### Undocumented public symbols/);
    expect(comment).toMatch(/`src\/math\.ts`/);
    expect(comment).toMatch(/`freshlyAdded`/);
    // Sticky-comment marker isn't part of the body itself; the workflow
    // prepends it. But the renderer must produce a valid markdown table.
    expect(comment).toMatch(/\| Kind \| Symbol \| Location \|/);

    closeDatabase(db);
  });

  it('the workflow yaml chains index, drift against committed docs, and ci-comment in order', async () => {
    const yml = readFileSync(
      new URL('../../.github/workflows/atlas.yml', import.meta.url),
      'utf8',
    );
    // Order matters: index before drift, drift before ci-comment, comment
    // before post. Docs are NOT regenerated before drift: that would hide
    // exactly the staleness the job exists to catch.
    const indexIdx = yml.indexOf('index .');
    const driftIdx = yml.indexOf('drift --json --docs-dir .atlas/docs');
    const ciCommentIdx = yml.indexOf('ci-comment');
    const postIdx = yml.indexOf('actions/github-script');
    expect(indexIdx).toBeGreaterThan(0);
    expect(driftIdx).toBeGreaterThan(indexIdx);
    expect(ciCommentIdx).toBeGreaterThan(driftIdx);
    expect(postIdx).toBeGreaterThan(ciCommentIdx);
    expect(yml).not.toMatch(/index\.js docs\b/);
  });

  it('triggers on PRs to any branch and pushes to the default branch, without an API key', () => {
    const yml = readFileSync(
      new URL('../../.github/workflows/atlas.yml', import.meta.url),
      'utf8',
    );
    expect(yml).not.toMatch(/\bmain\b/);
    const pr = yml.slice(yml.indexOf('pull_request:'), yml.indexOf('workflow_dispatch:'));
    expect(pr).not.toMatch(/branches:\s*\[\s*main/);
    expect(pr.split('push:')[0]).not.toMatch(/branches:/);
    expect(yml).toMatch(/push:\s*\n\s*branches:\s*\[\s*claude\/build-atlas-phase-1-f3WUm\s*\]/);
    expect(yml).not.toMatch(/ANTHROPIC_API_KEY/);
  });
});

/** The CLI args of the first `node ./dist/cli/index.js <cmd> ...` line in the workflow. */
function workflowCommand(yml: string, cmd: string): { args: string[]; out?: string } {
  const m = yml.match(new RegExp(`node \\./dist/cli/index\\.js (${cmd}\\b[^\\n>]*?)\\s*(?:>\\s*(\\S+))?\\s*$`, 'm'));
  if (!m?.[1]) throw new Error(`no '${cmd}' step in workflow`);
  return { args: m[1].trim().split(/\s+/), ...(m[2] ? { out: m[2] } : {}) };
}

describe('CI workflow against committed docs (git checkout simulation)', () => {
  const yml = readFileSync(new URL('../../.github/workflows/atlas.yml', import.meta.url), 'utf8');
  let base: string;
  let dir: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    });

  beforeEach(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    base = makeGitRepo('atlas-ci-base-');
    dir = mkdtempSync(join(tmpdir(), 'atlas-ci-pr-'));
    // Base commit: docs generated and committed under .atlas/docs.
    await runCli(['index', base]);
    await runCli(['docs', '--offline', '--cwd', base]);
    git(base, 'add', '.atlas/docs');
    git(base, 'commit', '-q', '-m', 'docs');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /** Fresh clone (no index.db), then run the workflow's index + drift steps. */
  async function runWorkflow(): Promise<{ code: number; report: DriftReport; clone: string }> {
    const clone = join(dir, `clone-${Math.random().toString(36).slice(2)}`);
    git(dir, 'clone', '-q', base, clone);
    expect(existsSync(join(clone, '.atlas/index.db'))).toBe(false);
    const index = workflowCommand(yml, 'index');
    await runCli(index.args.map((a) => (a === '.' ? clone : a)));
    const drift = workflowCommand(yml, 'drift');
    expect(drift.out).toBe('.atlas/drift.json');
    vi.mocked(process.stdout.write).mockClear();
    process.exitCode = undefined;
    await runCli([...drift.args, '--cwd', clone]);
    const code = Number(process.exitCode ?? 0);
    const json = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
    return { code, report: JSON.parse(json) as DriftReport, clone };
  }

  it('is green on the base commit', async () => {
    const { code, report } = await runWorkflow();
    expect(code).toBe(0);
    expect(report.stale).toEqual([]);
    expect(report.failing).toBe(false);
    expect(renderComment(report)).toMatch(/All docs are in sync/);
    expect(yml).toMatch(/"\$code" -eq 2 \]; then\n\s*echo "failing=true"/);
    expect(yml).toMatch(/if: steps\.drift\.outputs\.failing == 'true'/);
  });

  it('reports the changed file as stale when a PR changes code without regenerating docs', async () => {
    const p = join(base, 'src/math.ts');
    writeFileSync(p, readFileSync(p, 'utf8').replace('return a * b;', 'return b * a;'));
    git(base, 'commit', '-q', '-am', 'change multiply');
    const { code, report, clone } = await runWorkflow();
    expect(code).toBe(2);
    expect(report.failing).toBe(true);
    expect(report.stale.map((s) => `${s.kind}:${s.targetPath}`)).toEqual(['file:src/math.ts']);
    const db = openDatabase(join(clone, '.atlas/index.db'), { fileMustExist: true });
    const exported = db
      .prepare("SELECT COUNT(*) AS c FROM symbols WHERE exported = 1 AND kind != 'module'")
      .get() as { c: number };
    closeDatabase(db);
    expect(report.totals.publicSymbols).toBe(exported.c);
    const comment = renderComment(report);
    expect(comment).toMatch(/\*\*Drift check: failed\*\* \(1 stale doc\(s\)\)/);
    expect(comment).toMatch(/### Stale docs \(1\)/);
    expect(comment).toMatch(/`src\/math\.ts`/);
    expect(comment).toMatch(new RegExp(`${exported.c} public symbols`));
  });

  it('is green again once the PR regenerates and commits the docs', async () => {
    const p = join(base, 'src/math.ts');
    writeFileSync(p, readFileSync(p, 'utf8').replace('return a * b;', 'return b * a;'));
    await runCli(['index', base]);
    await runCli(['docs', '--offline', '--cwd', base]);
    git(base, 'add', '-A', 'src', '.atlas/docs');
    git(base, 'commit', '-q', '-m', 'change multiply + docs');
    const { code, report } = await runWorkflow();
    expect(code).toBe(0);
    expect(report.stale).toEqual([]);
  });

  it('fails (exit 1) instead of passing when no docs are committed', async () => {
    git(base, 'rm', '-q', '-r', '.atlas/docs');
    git(base, 'commit', '-q', '-m', 'drop docs');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runWorkflow()).rejects.toThrow(SyntaxError); // no JSON on stdout
    expect(process.exitCode).toBe(1);
  });

  it('indexes with the committed config, so a custom exclude does not cause drift', async () => {
    cpSync(new URL('../../.gitignore', import.meta.url), join(base, '.gitignore'));
    const cfgPath = join(base, '.atlas/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { exclude: string[] };
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, exclude: [...cfg.exclude, 'src/shapes.ts'] }));
    await runCli(['index', base]);
    await runCli(['docs', '--offline', '--cwd', base]);
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '-m', 'exclude shapes');
    expect(git(base, 'ls-files', '.atlas').split('\n').filter(Boolean).sort()).toEqual([
      '.atlas/config.json',
      '.atlas/docs/architecture.md',
      '.atlas/docs/files/src/app.ts.md',
      '.atlas/docs/files/src/math.ts.md',
      '.atlas/docs/files/src/util.py.md',
    ]);
    const { code, report } = await runWorkflow();
    expect(code).toBe(0);
    expect(report.stale).toEqual([]);
    expect(report.totals.files).toBe(3);
  });
});
