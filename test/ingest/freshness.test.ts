// SG25: the index stays current across Atlas upgrades (extractor version) and resolver config
// edits (fingerprint), oversized files are reported, and resolver diagnostics are surfaced.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  getLastRunStats,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo, type IndexStats } from '../../src/core/ingest/index.js';
import { MAX_RESOLVER_DIAGNOSTICS } from '../../src/core/ingest/indexer.js';
import { EXTRACTOR_VERSION } from '../../src/core/parse/index.js';
import { RESOLVER_VERSION, resolverFingerprint } from '../../src/core/graph/modules.js';
import { ConfigSchema } from '../../src/core/config.js';
import { createMcpContext, handleIndexTool, type McpContext } from '../../src/mcp/server.js';
import { runCli } from '../cli/helpers.js';

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function repo(files: Record<string, string>): { root: string; db: DB } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sg25-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  write(root, files);
  const db = openDatabase(join(dir, 'index.db'));
  dbs.push(db);
  return { root, db };
}

const index = (db: DB, root: string, opts: Parameters<typeof indexRepo>[2] = {}) =>
  indexRepo(db, root, { skipEmbeddings: true, ...opts });

/** Resolved edges as `srcPath::name -kind-> dstPath::name`. */
function strong(db: DB): string[] {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const syms = new Map(getAllSymbols(db).map((s) => [s.id, s]));
  const label = (id: number): string => {
    const s = syms.get(id)!;
    return `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`;
  };
  return getAllEdges(db)
    .filter((e) => e.weak === 0 && e.dst_symbol !== null && e.src_symbol !== null)
    .map((e) => `${label(e.src_symbol!)} -${e.kind}-> ${label(e.dst_symbol!)}`);
}

/** Rewrite the last run's recorded state, as an older Atlas (or a test) would have left it. */
function setState(db: DB, patch: Record<string, unknown> | null): void {
  const row = db
    .prepare(
      'SELECT id, stats_json FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get() as { id: number; stats_json: string };
  const stats = JSON.parse(row.stats_json) as Record<string, unknown>;
  if (patch === null) delete stats.state;
  else stats.state = { ...(stats.state as object), ...patch };
  db.prepare('UPDATE runs SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), row.id);
}

function expectNoop(s: IndexStats): void {
  expect(s.filesIndexed).toBe(0);
  expect(s.extractorUpgrade).toBeUndefined();
  expect(s.resolveReason).toBeNull();
}

async function cli(args: string[]): Promise<string> {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runCli(args);
  } finally {
    vi.restoreAllMocks();
  }
  return out.join('');
}

const TWO_FILES = {
  'a.ts': 'export function a(): number { return 1; }\n',
  'b.ts': "import { a } from './a';\nexport function b(): number { return a(); }\n",
};

// ---------------------------------------------------------------- A9-01 extractor version

describe('SG25 extractor version (A9-01)', () => {
  it('records the extractor version; a fresh index reports no upgrade', async () => {
    const { root, db } = repo(TWO_FILES);
    const s = await index(db, root);
    expect(s.extractorUpgrade).toBeUndefined();
    expect(s.filesIndexed).toBe(2);
    expect((getLastRunStats(db).state as { extractorVersion: number }).extractorVersion).toBe(
      EXTRACTOR_VERSION,
    );
  });

  it('an index written by an older extractor version is re-parsed and re-resolved once', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root);
    // Stale rows the older extractor wrote: `a` missing, a leaked symbol present.
    const aId = getAllFiles(db).find((f) => f.path === 'a.ts')!.id;
    db.prepare("DELETE FROM symbols WHERE file_id = ? AND name = 'a'").run(aId);
    db.prepare(
      `INSERT INTO symbols (file_id, kind, name, signature, start_line, end_line, docstring, qualified_name, exported)
       VALUES (?, 'variable', 'leaked', 'leaked', 1, 1, NULL, 'leaked', 0)`,
    ).run(aId);
    setState(db, { extractorVersion: EXTRACTOR_VERSION - 1 });

    const s = await index(db, root);
    expect(s.extractorUpgrade).toEqual({ from: EXTRACTOR_VERSION - 1, to: EXTRACTOR_VERSION });
    expect(s.filesIndexed).toBe(2);
    expect(s.filesSkipped).toBe(0);
    expect(s.resolveReason).toBe('files changed');
    const names = getAllSymbols(db).map((x) => x.name);
    expect(names).toContain('a');
    expect(names).not.toContain('leaked');
    expect(strong(db)).toContain('b.ts::b -calls-> a.ts::a');

    expectNoop(await index(db, root));
  });

  it('an index from before versioning (no recorded state) is re-parsed; `from` is null', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root);
    setState(db, null);
    const s = await index(db, root);
    expect(s.extractorUpgrade).toEqual({ from: null, to: EXTRACTOR_VERSION });
    expect(s.filesIndexed).toBe(2);
    expectNoop(await index(db, root));
  });

  it('a newer recorded version (downgrade) also re-parses', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root);
    setState(db, { extractorVersion: EXTRACTOR_VERSION + 1 });
    expect((await index(db, root)).filesIndexed).toBe(2);
  });

  it('--force on an old index re-parses without the upgrade notice and records the version', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root);
    setState(db, { extractorVersion: 0 });
    const s = await index(db, root, { force: true });
    expect(s.extractorUpgrade).toBeUndefined();
    expect(s.filesIndexed).toBe(2);
    expectNoop(await index(db, root));
  });

  it('only the last finished run counts: an interrupted run does not hide an upgrade', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root);
    setState(db, { extractorVersion: 0 });
    db.prepare("INSERT INTO runs (commit_sha, started_at) VALUES (NULL, '2026-01-01')").run();
    expect((await index(db, root)).extractorUpgrade?.from).toBe(0);
  });

  it('`atlas index` says it re-parsed because of the upgrade', async () => {
    const { root } = repo(TWO_FILES);
    await cli(['index', root]);
    const db = openDatabase(join(root, '.atlas', 'index.db'));
    try {
      setState(db, { extractorVersion: 0 });
    } finally {
      closeDatabase(db);
    }
    const out = await cli(['index', root]);
    expect(out).toContain(
      `index was written by extractor v0; re-parsed every file with extractor v${EXTRACTOR_VERSION}`,
    );
    expect(out).toContain('indexed 2, skipped 0');
    const again = await cli(['index', root]);
    expect(again).not.toContain('re-parsed');
    expect(again).toContain('(graph unchanged)');
  });
});

// ---------------------------------------------------------------- A9-03 resolver fingerprint

describe('SG25 resolver config fingerprint (A9-03)', () => {
  it('no-op re-index stays a no-op (no parse, no resolve)', async () => {
    const { root, db } = repo({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      'package.json': '{ "name": "r" }',
      'src/u.ts': 'export function u(): void {}\n',
      'src/p.ts': "import { u } from '@/u';\nexport function p(): void { u(); }\n",
    });
    expect((await index(db, root)).resolveReason).toBe('files changed');
    expectNoop(await index(db, root));
    expectNoop(await index(db, root));
  });

  it('a change in a tsconfig `extends` parent outside indexed dirs re-resolves', async () => {
    const { root, db } = repo({
      'configs/base.json': '{ "compilerOptions": { "paths": { "@lib/*": ["../src/one/*"] } } }',
      'tsconfig.json': '{ "extends": "./configs/base.json" }',
      'src/one/x.ts': 'export function x(): void {}\n',
      'src/two/x.ts': 'export function x(): void {}\n',
      'src/app.ts': "import { x } from '@lib/x';\nexport function app(): void { x(); }\n",
    });
    await index(db, root);
    expect(strong(db)).toContain('src/app.ts::app -calls-> src/one/x.ts::x');
    const state = getLastRunStats(db).state as { resolverInputs: string[] };
    expect(state.resolverInputs).toEqual(['configs/base.json']);
    write(root, {
      'configs/base.json': '{ "compilerOptions": { "paths": { "@lib/*": ["../src/two/*"] } } }',
    });
    const s = await index(db, root);
    expect(s.filesIndexed).toBe(0);
    expect(s.resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('src/app.ts::app -calls-> src/two/x.ts::x');
    expect(strong(db)).not.toContain('src/app.ts::app -calls-> src/one/x.ts::x');
    expectNoop(await index(db, root));
  });

  it('adding, then removing, a nested jsconfig.json re-resolves each time', async () => {
    const { root, db } = repo({
      'web/lib/h.js': 'export function h() {}\n',
      'web/app.js': "import { h } from 'lib/h';\nexport function app() { h(); }\n",
    });
    await index(db, root);
    expect(strong(db)).not.toContain('web/app.js::app -calls-> web/lib/h.js::h');
    write(root, { 'web/jsconfig.json': '{ "compilerOptions": { "baseUrl": "." } }' });
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('web/app.js::app -calls-> web/lib/h.js::h');
    rmSync(join(root, 'web/jsconfig.json'));
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).not.toContain('web/app.js::app -calls-> web/lib/h.js::h');
  });

  it("a workspace package's `main` change re-resolves; a version bump does not", async () => {
    const { root, db } = repo({
      'package.json': '{ "name": "root", "workspaces": ["packages/*"] }',
      'packages/w/package.json': '{ "name": "@acme/w", "version": "1.0.0", "main": "./src/a.ts" }',
      'packages/w/src/a.ts': 'export function w(): void {}\n',
      'packages/w/src/b.ts': 'export function w(): void {}\n',
      'apps/m.ts': "import { w } from '@acme/w';\nexport function m(): void { w(); }\n",
    });
    await index(db, root);
    expect(strong(db)).toContain('apps/m.ts::m -calls-> packages/w/src/a.ts::w');
    write(root, {
      'packages/w/package.json':
        '{ "name": "@acme/w", "version": "1.0.1", "scripts": { "t": "x" }, "main": "./src/a.ts" }',
    });
    expectNoop(await index(db, root));
    write(root, {
      'packages/w/package.json': '{ "name": "@acme/w", "version": "1.0.1", "main": "./src/b.ts" }',
    });
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('apps/m.ts::m -calls-> packages/w/src/b.ts::w');
    write(root, {
      'packages/w/package.json':
        '{ "name": "@acme/w", "main": "./src/b.ts", "exports": { ".": "./src/a.ts" } }',
    });
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('apps/m.ts::m -calls-> packages/w/src/a.ts::w');
  });

  it('adding pnpm-workspace.yaml re-resolves workspace imports', async () => {
    const { root, db } = repo({
      'package.json': '{ "name": "root" }',
      'libs/k/package.json': '{ "name": "k", "main": "index.ts" }',
      'libs/k/index.ts': 'export function k(): void {}\n',
      'main.ts': "import { k } from 'k';\nexport function main(): void { k(); }\n",
    });
    await index(db, root);
    expect(strong(db)).not.toContain('main.ts::main -calls-> libs/k/index.ts::k');
    write(root, { 'pnpm-workspace.yaml': 'packages:\n  - "libs/*"\n' });
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('main.ts::main -calls-> libs/k/index.ts::k');
  });

  it('pyproject.toml package roots: adding and retargeting `where` re-resolves', async () => {
    const pkg = 'def f():\n    return 1\n';
    const { root, db } = repo({
      'lib/pkg/__init__.py': '',
      'lib/pkg/mod.py': pkg,
      'vendor/pkg/__init__.py': '',
      'vendor/pkg/mod.py': pkg,
      'app/main.py': 'from pkg.mod import f\n\ndef main():\n    return f()\n',
    });
    await index(db, root);
    expect(strong(db).filter((e) => e.startsWith('app/main.py::main -calls->'))).toEqual([]);
    write(root, { 'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n' });
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('app/main.py::main -calls-> lib/pkg/mod.py::f');
    write(root, { 'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["vendor"]\n' });
    expect((await index(db, root)).resolveReason).toBe('resolver config changed');
    expect(strong(db)).toContain('app/main.py::main -calls-> vendor/pkg/mod.py::f');
    expectNoop(await index(db, root));
  });

  it('a config change and a source change in the same run resolve once, against the new config', async () => {
    const { root, db } = repo({
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": "a" } }',
      'a/m.ts': 'export function m(): void {}\n',
      'b/m.ts': 'export function m(): void {}\n',
      'x.ts': "import { m } from 'm';\nexport function x(): void { m(); }\n",
    });
    await index(db, root);
    write(root, {
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": "b" } }',
      'x.ts': "import { m } from 'm';\nexport function x(): void { m(); }\n// edited\n",
    });
    expect((await index(db, root)).resolveReason).toBe('files changed');
    expect(strong(db)).toContain('x.ts::x -calls-> b/m.ts::m');
    expectNoop(await index(db, root));
  });

  it('an index without a recorded fingerprint re-resolves once', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root);
    setState(db, { resolverFingerprint: null });
    const s = await index(db, root);
    expect(s.filesIndexed).toBe(0);
    expect(s.resolveReason).toBe('resolver config changed');
    expectNoop(await index(db, root));
  });

  it('resolverFingerprint covers the version, config files near indexed files and extra inputs', () => {
    const { root } = repo({
      'package.json': '{ "name": "r", "version": "1" }',
      'pkg/src/a.ts': '',
      'elsewhere/tsconfig.json': '{}',
      'unrelated/tsconfig.json': '{}',
      'base.json': '{}',
    });
    const paths = ['pkg/src/a.ts'];
    const fp = () => resolverFingerprint(root, paths, ['base.json']);
    const h0 = fp();
    expect(h0.extraInputs).toEqual(['base.json']);
    expect(resolverFingerprint(root, paths, ['package.json']).extraInputs).toEqual([]);
    expect(resolverFingerprint(root, paths, ['../outside.json']).extraInputs).toEqual([]);
    write(root, { 'unrelated/tsconfig.json': '{ "x": 1 }' });
    expect(fp().hash).toBe(h0.hash);
    write(root, { 'package.json': '{ "version": "2", "name": "r" }' });
    expect(fp().hash).toBe(h0.hash);
    write(root, { 'base.json': '{ "compilerOptions": {} }' });
    const h1 = fp().hash;
    expect(h1).not.toBe(h0.hash);
    write(root, { 'pkg/setup.py': 'print(1)\n' });
    const h2 = fp().hash;
    expect(h2).not.toBe(h1);
    write(root, { 'pkg/setup.py': 'print(2)\n' });
    expect(fp().hash).toBe(h2);
    write(root, { 'pkg/src/tsconfig.json': '{}' });
    expect(fp().hash).not.toBe(h2);
    write(root, { 'package.json': '{ not json' });
    const h3 = fp().hash;
    write(root, { 'package.json': '{ not json either' });
    expect(fp().hash).not.toBe(h3);
    expect(RESOLVER_VERSION).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- A9-10 size cap

describe('SG25 size cap (A9-10)', () => {
  it('oversized files are counted, reported per file and kept out of the index', async () => {
    const { root, db } = repo({
      ...TWO_FILES,
      'big.ts': `export const big = '${'x'.repeat(300)}';\n`,
    });
    const events: string[] = [];
    const s = await index(db, root, {
      maxBytes: 200,
      onFile: (f) => events.push(`${f.path} ${f.status} ${f.reason ?? ''}`),
    });
    expect(s.filesTooLarge).toBe(1);
    expect(s.filesSkipped).toBe(1);
    expect(s.filesIndexed).toBe(2);
    expect(events).toContain('big.ts skipped too large: 323 bytes > 200');
    expect(getAllFiles(db).map((f) => f.path)).not.toContain('big.ts');
    // Unchanged on re-run: still reported every time.
    const again = await index(db, root, { maxBytes: 200 });
    expect(again.filesTooLarge).toBe(1);
    expect(again.filesSkipped).toBe(3);
  });

  it('a file that grows past the cap is pruned and reported as too large', async () => {
    const { root, db } = repo(TWO_FILES);
    await index(db, root, { maxBytes: 200 });
    write(root, { 'a.ts': `export function a(): number { return 1; }\n// ${'y'.repeat(300)}\n` });
    const s = await index(db, root, { maxBytes: 200 });
    expect(s.filesTooLarge).toBe(1);
    expect(s.filesRemoved).toBe(1);
    expect(getAllFiles(db).map((f) => f.path)).toEqual(['b.ts']);
  });

  it('`maxFileBytes` is an optional positive config key, absent from the default config', () => {
    expect(ConfigSchema.parse({ version: 1 }).maxFileBytes).toBeUndefined();
    expect(ConfigSchema.parse({ version: 1, maxFileBytes: 4096 }).maxFileBytes).toBe(4096);
    expect(ConfigSchema.safeParse({ version: 1, maxFileBytes: 0 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ version: 1, maxFileBytes: 1.5 }).success).toBe(false);
  });

  it('`atlas index` honours maxFileBytes and reports the count; MCP returns it', async () => {
    const { root } = repo({ ...TWO_FILES, 'big.ts': `export const big = '${'x'.repeat(300)}';\n` });
    write(root, { '.atlas/config.json': JSON.stringify({ version: 1, maxFileBytes: 200 }) });
    const out = await cli(['index', root, '--verbose']);
    expect(out).toContain('[skipped] big.ts (too large: 323 bytes > 200)');
    expect(out).toContain('indexed 2, skipped 1, failed 0');
    expect(out).toContain('1 file over the 200-byte cap not indexed');
    const ctx: McpContext = createMcpContext({ root, offline: true });
    try {
      const r = await handleIndexTool(ctx, {});
      expect(r.filesTooLarge).toBe(1);
    } finally {
      closeDatabase(ctx.db);
    }
  });

  it('the default cap is 1 MiB and the CLI says so', async () => {
    let big = '';
    for (let i = 0; big.length <= 1024 * 1024; i++) big += `export const v${i} = ${i};\n`;
    const { root } = repo({ 'big.ts': big, 'small.ts': 'export const s = 1;\n' });
    const out = await cli(['index', root]);
    expect(out).toContain('1 file over the 1048576-byte cap not indexed');
  });
});

// ---------------------------------------------------------------- A9-13 resolver diagnostics

describe('SG25 resolver diagnostics (A9-13)', () => {
  const AMBIGUOUS = {
    'package.json': '{ "name": "root", "workspaces": ["examples/*"] }',
    'examples/one/package.json': '{ "name": "example" }',
    'examples/one/index.ts': 'export function one(): void {}\n',
    'examples/two/package.json': '{ "name": "example" }',
    'examples/two/index.ts':
      "import { one } from 'example';\nexport function two(): void { one(); }\n",
  };
  const MSG = 'workspace package "example" is declared in examples/one and examples/two';

  it('reach the index result and survive a no-op re-index', async () => {
    const { root, db } = repo(AMBIGUOUS);
    const s = await index(db, root);
    expect(s.resolverDiagnostics).toEqual([MSG]);
    expect(s.resolverDiagnosticCount).toBe(1);
    const again = await index(db, root);
    expectNoop(again);
    expect(again.resolverDiagnostics).toEqual([MSG]);
  });

  it('clear once the config is fixed', async () => {
    const { root, db } = repo(AMBIGUOUS);
    await index(db, root);
    write(root, { 'examples/two/package.json': '{ "name": "example-two" }' });
    const s = await index(db, root);
    expect(s.resolveReason).toBe('resolver config changed');
    expect(s.resolverDiagnostics).toEqual([]);
    expect(s.resolverDiagnosticCount).toBe(0);
  });

  it('a malformed tsconfig is reported in the CLI output and the MCP result', async () => {
    const { root } = repo({
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", } oops }',
      'a.ts': "import { b } from 'b';\nexport function a(): void { b(); }\n",
      'b.ts': 'export function b(): void {}\n',
    });
    const out = await cli(['index', root]);
    expect(out).toMatch(/resolver diagnostics \(1\):\n {2}- tsconfig\.json: /);
    const ctx: McpContext = createMcpContext({ root, offline: true });
    try {
      const r = await handleIndexTool(ctx, { force: true });
      expect(r.resolverDiagnostics[0]).toMatch(/^tsconfig\.json: /);
      expect(JSON.stringify(r)).toContain('resolverDiagnosticCount');
    } finally {
      closeDatabase(ctx.db);
    }
  });

  it('the stored list is capped and the CLI shows at most 10 with a remainder', async () => {
    const files: Record<string, string> = {};
    const n = MAX_RESOLVER_DIAGNOSTICS + 5;
    for (let i = 0; i < n; i++) {
      files[`p${String(i).padStart(2, '0')}/tsconfig.json`] = '{ broken';
      files[`p${String(i).padStart(2, '0')}/a.ts`] =
        "import { z } from 'z';\nexport const a = z;\n";
    }
    const { root, db } = repo(files);
    const s = await index(db, root);
    expect(s.resolverDiagnosticCount).toBe(n);
    expect(s.resolverDiagnostics).toHaveLength(MAX_RESOLVER_DIAGNOSTICS);
    closeDatabase(db);
    dbs.splice(dbs.indexOf(db), 1);
    const out = await cli(['index', root]);
    expect(out).toContain(`resolver diagnostics (${n}):`);
    expect(out.match(/^ {2}- p\d\d\/tsconfig\.json: /gm)).toHaveLength(10);
    expect(out).toContain(`  … ${n - 10} more`);
  });

  it('a clean repo prints no diagnostics section', async () => {
    const { root } = repo(TWO_FILES);
    expect(await cli(['index', root])).not.toContain('resolver diagnostics');
  });
});
