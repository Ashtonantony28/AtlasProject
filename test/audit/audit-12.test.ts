// AUDIT-12: test coverage, round 3 (SG18–SG27). Plain `it` tests pin behaviour that is correct
// today but that a surviving mutation showed no other test checks (the mutant is named in each
// test; AUDIT-12.md has the diff). Each `it.fails` asserts the correct behaviour and currently
// fails, reproducing one finding in AUDIT-12.md (IDs A12-xx); when it is fixed it turns red and
// should become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { walkRepo, walkRepoReport } from '../../src/core/ingest/walker.js';
import { parseSource, type ParseResult } from '../../src/core/parse/index.js';
import { parseDriftReport, renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { runCli } from '../cli/helpers.js';
import {
  ModuleResolver,
  PathsMatcher,
  RESOLVER_VERSION,
  resolverFingerprint,
  type ModuleFile,
} from '../../src/core/graph/modules.js';

// Fault injection, off unless a test sets it: `statSync` / `readFileSync` of this absolute path
// fail, and tree-sitter throws (as in R1) on any source containing `parse`.
const fault = vi.hoisted(() => ({
  stat: null as string | null,
  read: null as string | null,
  parse: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const failing = <F extends (...a: never[]) => unknown>(fn: F, key: 'stat' | 'read'): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (fault[key] !== null && String(path) === fault[key]) {
        throw Object.assign(new Error(`EACCES: injected, '${String(path)}'`), { code: 'EACCES' });
      }
      return (fn as unknown as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as F;
  const patched = {
    statSync: failing(real.statSync, 'stat'),
    readFileSync: failing(real.readFileSync, 'read'),
  };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

vi.mock('tree-sitter', async (importOriginal) => {
  const real = await importOriginal<{
    default: new () => { parse(...a: unknown[]): unknown };
  }>();
  class FaultyParser extends real.default {
    parse(input: unknown, ...rest: unknown[]): unknown {
      if (fault.parse !== null && typeof input === 'function') {
        if (String((input as (i: number) => string)(0)).includes(fault.parse)) {
          throw new Error('Invalid argument');
        }
      }
      return super.parse(input, ...rest);
    }
  }
  return { ...real, default: FaultyParser };
});

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  fault.stat = fault.read = fault.parse = null;
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'atlas-a12-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

function repo(files: Record<string, string>): { root: string; db: DB } {
  const dir = tmp();
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

/** A resolver over `paths` (no files on disk needed unless configs are read). */
function resolver(root: string, paths: string[]): ModuleResolver<ModuleFile> {
  const byPath = new Map<string, ModuleFile>();
  for (const p of paths)
    byPath.set(p, { filePath: p, language: p.endsWith('.py') ? 'python' : 'typescript' });
  return new ModuleResolver(root, byPath);
}

/** `git ls-files --others --exclude-standard` for source files: git's own .gitignore verdict. */
function gitWalk(root: string): string[] {
  execFileSync('git', ['init', '-q'], { cwd: root });
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root })
    .toString()
    .split('\n')
    .filter((p) => /\.(ts|js|py)$/.test(p))
    .sort();
}

// ---------------------------------------------------------------- module resolution (SG19/SG27)

describe('AUDIT-12 module resolution', () => {
  it.fails(
    'A12-07: `extends: "./base"` reads base.json, as tsc does, even when a base/ directory holds a tsconfig.json',
    async () => {
      const paths = (to: string) => JSON.stringify({ compilerOptions: { paths: { '@/*': [to] } } });
      const { root, db } = repo({
        'tsconfig.json': JSON.stringify({ extends: './base' }),
        'base.json': paths('src/*'),
        'base/tsconfig.json': paths('../lib/*'),
        'src/util.ts': 'export function foo(): number { return 1; }\n',
        'lib/util.ts': 'export function foo(): number { return 2; }\n',
        'app.ts':
          "import { foo } from '@/util';\nexport function use(): number { return foo(); }\n",
      });
      await index(db, root);
      // tsc: "./base" is not a file, so it tries "./base.json" (a directory is never searched).
      expect(strong(db)).toContain('app.ts::use -calls-> src/util.ts::foo');
    },
  );

  it('M02: a tsconfig `paths` pattern only matches a specifier at least as long as its prefix and suffix', () => {
    const m = new PathsMatcher([
      { pattern: 'a*', targets: ['short/*'], base: '' },
      { pattern: 'ab*b', targets: ['long/*'], base: '' },
    ]);
    // `ab` starts with `ab` and ends with `b`, but is shorter than `ab` + `b`: TypeScript's
    // isPatternMatch rejects it, so `a*` (shorter prefix) is the match.
    expect(m.match('ab')?.prefix).toBe('a');
    expect(m.match('abxb')?.prefix).toBe('ab');
    expect(m.match('abb')?.prefix).toBe('ab');
  });

  it('M14: a bare Python import prefers the repo root over the importer’s package root', () => {
    const r = resolver(tmp(), [
      'utils.py',
      'proj/utils.py',
      'proj/app/__init__.py',
      'proj/app/main.py',
    ]);
    const from = { filePath: 'proj/app/main.py', language: 'python' };
    expect(r.resolve(from, 'utils')?.filePath).toBe('utils.py');
    // Only the package root holds `helpers`: still found.
    const r2 = resolver(tmp(), ['proj/helpers.py', 'proj/app/__init__.py', 'proj/app/main.py']);
    expect(r2.resolve(from, 'helpers')?.filePath).toBe('proj/helpers.py');
  });

  it('M18: a root `src/` is a Python root even with no pyproject/setup.cfg at the root', () => {
    const root = tmp();
    const files = [
      'src/pkg/__init__.py',
      'src/pkg/core.py',
      'vendor/pkg/__init__.py',
      'vendor/pkg/core.py',
      'tests/test_core.py',
    ];
    write(root, Object.fromEntries(files.map((f) => [f, ''])));
    // `pkg` is discovered under both `src/` and `vendor/`, so only the root `src/` rule finds it.
    const r = resolver(root, files);
    const from = { filePath: 'tests/test_core.py', language: 'python' };
    expect(r.resolve(from, 'pkg.core')?.filePath).toBe('src/pkg/core.py');
  });

  it('M20: the resolver fingerprint includes RESOLVER_VERSION, so bumping it re-resolves', () => {
    const root = tmp();
    const expected = createHash('sha256').update(`resolver:${RESOLVER_VERSION}\n`).digest('hex');
    expect(resolverFingerprint(root, []).hash).toBe(expected);
    const other = createHash('sha256')
      .update(`resolver:${RESOLVER_VERSION + 1}\n`)
      .digest('hex');
    expect(resolverFingerprint(root, []).hash).not.toBe(other);
  });
});

// ---------------------------------------------------------------- walker vs git (SG20/SG27)

describe('AUDIT-12 walker', () => {
  it('A12-01: a directory ignored by a shallower .gitignore and re-included by a deeper one is walked, as git does', () => {
    const root = join(tmp(), 'repo');
    write(root, {
      '.gitignore': 'build/\n',
      'x/.gitignore': '!build/\n',
      'x/build/f.ts': 'export const f = 1;\n',
      'x/build/deep/h.ts': 'export const h = 1;\n',
      'y/build/g.ts': 'export const g = 1;\n',
    });
    const atlas = walkRepo(root).map((f) => f.relativePath);
    expect(gitWalk(root)).toEqual(['x/build/deep/h.ts', 'x/build/f.ts']);
    expect(atlas).toEqual(['x/build/deep/h.ts', 'x/build/f.ts']);
  });
  it('W07: `maxBytes` is inclusive: a file of exactly the cap is walked, one byte more is too large', () => {
    const root = join(tmp(), 'repo');
    const body = (n: number): string => `//${'x'.repeat(n - 3)}\n`;
    write(root, { 'at.ts': body(64), 'over.ts': body(65) });
    const report = walkRepoReport(root, { maxBytes: 64 });
    expect(report.files.map((f) => [f.relativePath, f.sizeBytes])).toEqual([['at.ts', 64]]);
    expect(report.tooLarge).toEqual([{ path: 'over.ts', sizeBytes: 65 }]);
  });
});

// ---------------------------------------------------------------- extractor upgrade (SG25)

/** Rewrite the last run's recorded state, as an older Atlas would have left it. */
function setState(db: DB, patch: Record<string, unknown>): void {
  const row = db
    .prepare(
      'SELECT id, stats_json FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get() as { id: number; stats_json: string };
  const stats = JSON.parse(row.stats_json) as Record<string, unknown>;
  stats.state = { ...(stats.state as object), ...patch };
  db.prepare('UPDATE runs SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), row.id);
}

describe('AUDIT-12 extractor upgrade with a failing file', () => {
  const FILES = {
    'a.ts': 'export function a(): number { return 1; }\n',
    'b.ts': "import { a } from './a';\nexport function b(): number { return a(); }\n",
  };

  /**
   * Index, then make `a.ts` look written by an older extractor (its `a` symbol replaced by a
   * leaked one) and record an older version. `fail` breaks a.ts for the upgrade run only.
   */
  async function upgradeWithFailure(fail: (root: string) => void) {
    const { root, db } = repo(FILES);
    await index(db, root);
    const aId = getAllFiles(db).find((f) => f.path === 'a.ts')!.id;
    db.prepare("DELETE FROM symbols WHERE file_id = ? AND name = 'a'").run(aId);
    db.prepare(
      `INSERT INTO symbols (file_id, kind, name, signature, start_line, end_line, docstring, qualified_name, exported)
       VALUES (?, 'variable', 'leaked', 'leaked', 1, 1, NULL, 'leaked', 0)`,
    ).run(aId);
    setState(db, { extractorVersion: 0 });
    fail(root);
    const upgrade = await index(db, root);
    fault.stat = fault.read = fault.parse = null;
    const retry = await index(db, root);
    const names = getAllSymbols(db).map((s) => s.name);
    return { upgrade, retry, names };
  }

  const expectRetried = (r: Awaited<ReturnType<typeof upgradeWithFailure>>): void => {
    expect(r.upgrade.extractorUpgrade).toEqual({ from: 0, to: expect.any(Number) });
    expect(r.upgrade.filesFailed).toBe(1);
    expect(r.upgrade.filesRemoved).toBe(0);
    // The next run re-parses the file the upgrade could not: old-extractor rows do not linger.
    expect(r.retry.filesIndexed).toBe(1);
    expect(r.names).toContain('a');
    expect(r.names).not.toContain('leaked');
  };

  it('I02: a file the walk cannot stat during an upgrade is re-parsed on the next run', async () => {
    expectRetried(await upgradeWithFailure((root) => (fault.stat = join(root, 'a.ts'))));
  });

  it('I03: a file that cannot be read during an upgrade is re-parsed on the next run', async () => {
    expectRetried(await upgradeWithFailure((root) => (fault.read = join(root, 'a.ts'))));
  });

  it('I04: a file whose parse fails during an upgrade is re-parsed on the next run', async () => {
    expectRetried(await upgradeWithFailure(() => (fault.parse = 'function a()')));
  });
});

describe('AUDIT-12 resolver state across runs', () => {
  it('X03: `--force` re-resolves even when no file is (re)indexed', async () => {
    const { root, db } = repo({});
    expect((await index(db, root)).resolveReason).toBe('no edges');
    expect((await index(db, root, { force: true })).resolveReason).toBe('forced');
  });

  it('X04: `atlas index` says it re-resolved after a resolver config change, not "graph unchanged"', async () => {
    const { root } = repo({
      'src/a.ts': "import { b } from '@/b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 1;\n',
    });
    const cli = async (args: string[]): Promise<string> => {
      const out: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await runCli(args);
      } finally {
        vi.restoreAllMocks();
      }
      return out.join('');
    };
    await cli(['index', root]);
    write(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
    });
    const out = await cli(['index', root]);
    expect(out).toContain('indexed 0,');
    expect(out).toMatch(/resolved \d+ edges \(\d+ weak\) after a resolver config change/);
    expect(out).not.toContain('graph unchanged');
  });

  it('I10: a run that keeps the graph reports the last resolve’s diagnostic count', async () => {
    const { root, db } = repo({
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", } broken',
      'a.ts': "import { b } from 'b';\nexport const a = b;\n",
      'b.ts': 'export const b = 1;\n',
    });
    const first = await index(db, root);
    expect(first.resolverDiagnosticCount).toBeGreaterThan(0);
    const again = await index(db, root);
    expect(again.resolveReason).toBeNull();
    expect(again.resolverDiagnostics).toEqual(first.resolverDiagnostics);
    expect(again.resolverDiagnosticCount).toBe(first.resolverDiagnosticCount);
  });
});

// ---------------------------------------------------------------- callback scopes (SG26)

const parseJs = (src: string): Promise<ParseResult> => parseSource(src, 'javascript', 'm.js');
const described = (r: ParseResult): string[] =>
  r.symbols.map((x) => `${x.kind}:${x.qualifiedName ?? x.name}:${x.exported}`);

describe('AUDIT-12 callback scopes', () => {
  it('T07: a property defined through `defineGetter(obj, …)` is exported only when `obj` is', async () => {
    const r = await parseJs(
      'const req = {};\nexport const res = {};\n' +
        "defineGetter(req, 'protocol', function () { return 1; });\n" +
        "defineGetter(res, 'status', function () { return 2; });\n",
    );
    expect(described(r)).toEqual([
      'variable:req:false',
      'variable:res:true',
      'method:req.protocol:false',
      'method:res.status:true',
    ]);
  });

  it('T04/T06: only `f(obj, "name", fn)` with exactly three arguments, or a descriptor passed to defineProperty, defines a property', async () => {
    const r = await parseJs(
      'const app = {};\n' +
        "wrap(app, 'handle', opts, function () { run(); });\n" +
        "register(app, 'name', { get() { return 1; } });\n",
    );
    expect(described(r)).toEqual(['variable:app:false']);
    // The callback's calls still count, for the module.
    expect(r.references.filter((x) => x.kind === 'calls').map((x) => x.name)).toContain('run');
  });

  it('T10: in a chain, an `exports.x` alias of a method is a function, not a method', async () => {
    const r = await parseJs(
      'const app = {};\nmodule.exports.handler = app.handler = function () { run(); };\n',
    );
    expect(described(r)).toEqual([
      'variable:app:false',
      'method:app.handler:false',
      'function:handler:true',
    ]);
  });

  it('T17: a chain whose targets name the same symbol defines it once', async () => {
    const r = await parseJs(
      'exports.handler = module.exports.handler = function () { run(); };\n' +
        'const a = {};\na.f = a.f = function () {};\n',
    );
    expect(described(r)).toEqual(['function:handler:true', 'variable:a:false', 'method:a.f:false']);
  });
});

// ---------------------------------------------------------------- ci-comment (SG20/SG22)

describe('AUDIT-12 ci-comment', () => {
  const undocumented = [{ file: 'a.ts', symbol: 'f', kind: 'function', startLine: 1 }];

  it('C01/C03: an older report with only undocumented symbols has drift, and fails only under --strict', () => {
    const old = { stale: [], undocumented, totals: { files: 1, docs: 1, publicSymbols: 1 } };
    const plain = parseDriftReport(JSON.stringify(old));
    expect(plain).toMatchObject({ hasDrift: true, failing: false, strict: false });
    const strict = parseDriftReport(JSON.stringify({ ...old, strict: true }));
    expect(strict).toMatchObject({ hasDrift: true, failing: true, strict: true });
    expect(renderComment(strict)).toContain(
      '**Drift check: failed** (1 undocumented public symbol(s) (--strict)).',
    );
  });

  it('C02: a report whose undocumented list is shorter than its total is truncated', () => {
    const r = parseDriftReport(
      JSON.stringify({
        stale: [],
        undocumented,
        totals: { files: 1, docs: 1, publicSymbols: 9, stale: 0, undocumented: 5 },
      }),
    );
    expect(r.truncated).toBe(true);
    expect(renderComment(r)).toContain('1 of 5 undocumented symbols listed');
  });

  it('C06: a strict page that lists no undocumented symbols still says why the gate failed', () => {
    const md = renderComment({
      stale: [],
      undocumented: [],
      totals: { files: 1, docs: 1, publicSymbols: 9, stale: 0, undocumented: 3 },
      hasDrift: true,
      failing: true,
      strict: true,
      truncated: true,
    });
    expect(md).toContain('**Drift check: failed** (3 undocumented public symbol(s) (--strict)).');
  });
});
