// AUDIT-13: soundness, round 4 (no false negatives). Each `it.fails` asserts the CORRECT
// behaviour and currently fails, reproducing one finding in AUDIT-13.md (IDs A13-xx); when it is
// fixed it turns red and should become a plain `it`. Plain `it` blocks pin behaviour of SG25–SG29
// that was checked against an oracle (tsc, python `ast`, the pre-SG27 resolver) and found sound.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  counts,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { ModuleResolver, PathsMatcher, type ModuleFile } from '../../src/core/graph/modules.js';
import { parseSource } from '../../src/core/parse/index.js';
import { budgeted, TokenBudget } from '../../src/core/synth/budget.js';
import type { LLMClient } from '../../src/core/synth/llmClient.js';

// Fault injection for A13-03: the next `resolveGraph` call throws, as if the process were killed
// after the parse loop committed and before the resolver ran.
const crash = vi.hoisted(() => ({ nextResolve: false }));
vi.mock('../../src/core/graph/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/graph/resolver.js')>();
  return {
    ...real,
    resolveGraph: (...args: Parameters<typeof real.resolveGraph>) => {
      if (crash.nextResolve) {
        crash.nextResolve = false;
        throw new Error('killed before resolve');
      }
      return real.resolveGraph(...args);
    },
  };
});

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  crash.nextResolve = false;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function newRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit13-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  writeTree(root, files);
  return root;
}

function open(path: string): DB {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

interface Graph {
  /** `src -kind-> dst` for resolved edges; labels are `path::qualifiedName` (`<module>` for files). */
  strong: Set<string>;
  /** Every edge, resolved or weak, as `src -kind-> dst|null`. */
  any: string[];
  /** `path kind qualifiedName` for every non-module symbol. */
  symbols: string[];
  /** `path qualifiedName` for every exported non-module symbol. */
  exported: string[];
}

function graphFrom(db: DB): Graph {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const all = getAllSymbols(db);
  const byId = new Map(all.map((s) => [s.id, s]));
  const label = (id: number | null): string => {
    if (id === null) return 'null';
    const s = byId.get(id)!;
    return `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`;
  };
  const strong = new Set<string>();
  const any: string[] = [];
  for (const e of getAllEdges(db)) {
    any.push(`${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}`);
    if (e.weak === 0 && e.dst_symbol !== null)
      strong.add(`${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}`);
  }
  const named = all.filter((s) => s.kind !== 'module');
  return {
    strong,
    any,
    symbols: named.map((s) => `${paths.get(s.file_id)} ${s.kind} ${s.qualified_name ?? s.name}`),
    exported: named
      .filter((s) => s.exported === 1)
      .map((s) => `${paths.get(s.file_id)} ${s.qualified_name ?? s.name}`),
  };
}

async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = newRepo(files);
  const db = open(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  return graphFrom(db);
}

async function symbolsOf(
  source: string,
  lang: 'javascript' | 'typescript' | 'python',
  path: string,
): Promise<string[]> {
  const r = await parseSource(source, lang, path);
  return r.symbols.map(
    (s) => `${s.kind} ${s.qualifiedName ?? s.name}${s.exported ? ' (exported)' : ''}`,
  );
}

// ---------------------------------------------------------------- high

describe('AUDIT-13 high', () => {
  it('A13-01 destructured top-level declarations define symbols, so their importers resolve', async () => {
    const g = await graphOf({
      'src/server/auth.ts':
        "import NextAuth from 'next-auth';\nexport const { auth, handlers: h, signIn } = NextAuth({});\n",
      'src/app/page.ts':
        "import { auth, signIn } from '../server/auth';\nexport async function Page() { await auth(); signIn(); }\n",
      'app/conf.py': 'release, version = get_version()\n',
      'app/use.py': 'from app.conf import version\n\ndef show():\n    return version\n',
    });
    expect(g.exported).toEqual(
      expect.arrayContaining([
        'src/server/auth.ts auth',
        'src/server/auth.ts h',
        'src/server/auth.ts signIn',
        'app/conf.py version',
      ]),
    );
    expect(g.strong).toContain('src/app/page.ts::<module> -imports-> src/server/auth.ts::auth');
    expect(g.strong).toContain('src/app/page.ts::Page -calls-> src/server/auth.ts::auth');
    expect(g.strong).toContain('app/use.py::<module> -imports-> app/conf.py::version');
  });

  it(
    'A13-02 two index runs on one DB file that do not share the in-process queue (another process; here a symlinked path) do not duplicate symbols',
    async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 6; i++)
        files[`src/m${i}.ts`] = `export function f${i}(): number { return ${i}; }\n`;
      const root = newRepo(files);
      const base = dirname(root);
      mkdirSync(join(base, 'state'));
      symlinkSync(join(base, 'state'), join(base, 'alias'));
      const a = open(join(base, 'state', 'index.db'));
      const b = open(join(base, 'alias', 'index.db'));
      await Promise.all([
        indexRepo(a, root, { skipEmbeddings: true }),
        indexRepo(b, root, { skipEmbeddings: true }),
      ]);
      // 6 functions + 6 module symbols, once each; the next plain run would keep any duplicate.
      expect(counts(a).symbols).toBe(12);
    },
  );

  it(
    'A13-03 an index run interrupted after parsing (before the resolver ran) is re-resolved by the next plain run',
    async () => {
      const root = newRepo({
        'src/util/index.ts': 'export function f(): number { return 1; }\n',
        'src/a.ts': "import { f } from './util';\nexport function a(): number { return f(); }\n",
      });
      const db = open(join(root, '..', 'index.db'));
      await indexRepo(db, root, { skipEmbeddings: true });
      expect(graphFrom(db).strong).toContain('src/a.ts::a -calls-> src/util/index.ts::f');

      // `./util` now means `src/util.ts` (tried before `util/index.ts`, as tsc does).
      writeTree(root, { 'src/util.ts': 'export function f(): number { return 2; }\n' });
      crash.nextResolve = true;
      await expect(indexRepo(db, root, { skipEmbeddings: true })).rejects.toThrow(
        'killed before resolve',
      );

      const stats = await indexRepo(db, root, { skipEmbeddings: true });
      const g = graphFrom(db);
      expect(g.strong).not.toContain('src/a.ts::a -calls-> src/util/index.ts::f');
      expect(g.strong).toContain('src/a.ts::a -calls-> src/util.ts::f');
      expect(stats.resolveReason).not.toBeNull();
    },
  );
});

// ---------------------------------------------------------------- medium

describe('AUDIT-13 medium', () => {
  it.fails(
    'A13-04 a CommonJS export of a non-function value (`exports.x = make()`) is a symbol, like `export const x = make()`',
    async () => {
      const g = await graphOf({
        'lib/utils.js':
          "exports.wetag = createETag({ weak: true });\nexports.methods = ['get', 'put'];\nexports.json = parser.json;\nfunction createETag() { return function () {}; }\nvar parser = { json: function () {} };\n",
        'use.js':
          "var utils = require('./lib/utils');\nfunction main() { utils.wetag(); return utils.methods; }\nmodule.exports = main;\n",
      });
      expect(g.exported).toEqual(
        expect.arrayContaining(['lib/utils.js wetag', 'lib/utils.js methods', 'lib/utils.js json']),
      );
      expect(g.strong).toContain('use.js::main -calls-> lib/utils.js::wetag');
    },
  );

  it.fails(
    "A13-05 a call through a default `require` binding with no resolvable default is not resolved to the importer's own binding variable",
    async () => {
      const g = await graphOf({
        'lib/f.js': 'function make() { return function () {}; }\nmodule.exports = make();\n',
        'use.js':
          "const debug = require('debug');\nconst made = require('./lib/f');\nfunction main() { debug('x'); made(); }\nmodule.exports = main;\n",
      });
      // Both calls leave the file: external package, and a module whose default is a call result.
      expect(g.strong).not.toContain('use.js::main -calls-> use.js::debug');
      expect(g.strong).not.toContain('use.js::main -calls-> use.js::made');
      expect(g.any).toContain('use.js::main -calls-> null');
    },
  );

  it.fails(
    'A13-06 CommonJS exports made inside an IIFE wrapper or a top-level `if` are exported (tsc agrees)',
    async () => {
      const g = await graphOf({
        'lib/iife.js':
          ';(function () {\n  function format() {}\n  exports.format = format;\n  exports.direct = function direct() {};\n})();\n',
        'lib/guard.js':
          "function g() {}\nif (typeof module !== 'undefined') module.exports.g = g;\n",
      });
      expect(g.exported).toEqual(
        expect.arrayContaining(['lib/iife.js format', 'lib/iife.js direct', 'lib/guard.js g']),
      );
    },
  );
});

// ---------------------------------------------------------------- low

describe('AUDIT-13 low', () => {
  it.fails('A13-07 `export default <expression>` defines a `default` symbol', async () => {
    const g = await graphOf({
      'src/g.ts': 'function make(): () => number { return () => 1; }\nexport default make();\n',
      'src/use.ts': "import d from './g';\nexport function u(): number { return d(); }\n",
    });
    expect(g.exported).toContain('src/g.ts default');
    expect(g.strong).toContain('src/use.ts::u -calls-> src/g.ts::default');
  });

  it.fails(
    'A13-08 a class declared in a callback keeps its `extends` edge (SG26 regression)',
    async () => {
      const g = await graphOf({
        'src/base.ts': 'export class BaseError extends Error {}\n',
        'test/err.test.ts':
          "import { BaseError } from '../src/base';\ndescribe('e', () => {\n  class MyError extends BaseError {}\n  it('x', () => new MyError());\n});\n",
      });
      expect(g.any.some((e) => e.endsWith('-extends-> src/base.ts::BaseError'))).toBe(true);
    },
  );

  it.fails(
    'A13-09 a 3-argument call `f(obj, "name", fn)` that is not a property definition defines no method',
    async () => {
      const syms = await symbolsOf(
        "var req = Object.create(null);\nmodule.exports = req;\nemitter.on(req, 'data', function onData() {});\n",
        'javascript',
        'lib/request.js',
      );
      expect(syms).not.toContain('method req.data (exported)');
    },
  );

  it.fails('A13-10 `__all__.extend([...])` / `.append(...)` names are exported', async () => {
    const syms = await symbolsOf(
      "__all__ = ['a']\n__all__.extend(['b'])\n__all__.append('c')\ndef a(): pass\ndef b(): pass\ndef c(): pass\n",
      'python',
      'pkg/mod.py',
    );
    expect(syms).toEqual(
      expect.arrayContaining(['function b (exported)', 'function c (exported)']),
    );
  });

  it.fails(
    'A13-11 a method assigned in a declarator chain (`const s = res.s = function () {}`) is defined',
    async () => {
      const syms = await symbolsOf(
        'var res = {};\nmodule.exports = res;\nconst s1 = res.s1 = function () {};\n',
        'javascript',
        'lib/response.js',
      );
      expect(syms).toContain('method res.s1 (exported)');
    },
  );

  it.fails(
    'A13-12 a run never spends more than its token budget when the prompt is denser than 3 chars/token',
    async () => {
      // Chinese prose (docstrings, comments) is ~1.2 chars/token; the estimate assumes 3.
      const inner: LLMClient = {
        model: 'fake',
        complete: (params) => {
          const chars =
            (params.system?.length ?? 0) +
            params.messages.reduce((n, m) => n + m.content.length, 0);
          return Promise.resolve({
            content: 'ok',
            inputTokens: Math.ceil(chars / 1.2),
            outputTokens: params.maxTokens,
            stopReason: 'end_turn',
          });
        },
      };
      const budget = new TokenBudget(8000);
      const llm = budgeted(inner, budget);
      await llm.complete({
        system: '',
        messages: [{ role: 'user', content: '文'.repeat(6000) }],
        maxTokens: 16000,
      });
      expect(budget.total().spent).toBeLessThanOrEqual(budget.cap);
    },
  );
});

// ---------------------------------------------------------------- holds (pins)

describe('AUDIT-13 holds', () => {
  it('SG26 module wrappers keep their declarations; callbacks, nested IIFEs and getters do not leak locals', async () => {
    const syms = await symbolsOf(
      [
        '(function (global, factory) {',
        "  typeof exports === 'object' ? module.exports = factory() : global.Lib = factory();",
        "}(this, (function () { 'use strict'; function umdFn() {} var umdVar = 2; return umdFn; })));",
        '!function () { function bangFn() {} }();',
        '(function () { function callFn() {} }).call(this);',
        "define('m', ['dep'], function (dep) { function amdFn() {} return amdFn; });",
        "describe('x', function () { var testLocal = 1; function testFn() {} (function () { var nested = 1; })(); });",
        "require(['dep'], function (dep) { var amdReqLocal = 1; });",
        'foo.define(function () { var memberDefine = 1; });',
        'var init = function () { var assignedThenCalled = 1; };',
        'init();',
        'var req = Object.create(null);',
        "defineGetter(req, 'protocol', function protocol() { var proto = 1; return proto; });",
        "Object.defineProperty(req, 'host', { get() { var h = 1; return h; } });",
        "Object.defineProperty(req, 'hostname', { get: function () { var hn = 1; return hn; } });",
      ].join('\n'),
      'javascript',
      'lib/x.js',
    );
    for (const s of [
      'function umdFn',
      'variable umdVar',
      'function bangFn',
      'function callFn',
      'function amdFn',
      'method req.protocol',
      'method req.host',
      'method req.hostname',
    ])
      expect(syms).toContain(s);
    for (const local of [
      'testLocal',
      'testFn',
      'nested',
      'amdReqLocal',
      'memberDefine',
      'assignedThenCalled',
      'proto',
      'h',
      'hn',
    ])
      expect(syms.some((s) => s.split(' ')[1] === local)).toBe(false);
  });

  it('SG26 chained aliases, `as const` / `satisfies` members and CommonJS export chains', async () => {
    const js = await symbolsOf(
      'var res = Object.create(null);\nvar app = exports = module.exports = res;\nres.contentType = res.type = function contentType(t) { return t; };\nres.a = res.b = res.c = function () {};\nres.K = res.K2 = class K {};\nexports.x = exports.y = function () {};\n',
      'javascript',
      'lib/response.js',
    );
    expect(js).toEqual(
      expect.arrayContaining([
        'variable res (exported)',
        'variable app (exported)',
        'method res.type (exported)',
        'method res.contentType (exported)',
        'method res.a (exported)',
        'method res.b (exported)',
        'method res.c (exported)',
        'class res.K (exported)',
        'class res.K2 (exported)',
        'function x (exported)',
        'function y (exported)',
      ]),
    );
    const ts = await symbolsOf(
      'export const routes = { home() { return 1; }, about: () => 2 } as const;\nexport default { async fetch(r: Request) { return r; } } satisfies Handler;\nexport const cfg = { a() {} } as const satisfies Cfg;\n',
      'typescript',
      'src/routes.ts',
    );
    expect(ts).toEqual(
      expect.arrayContaining([
        'method routes.home (exported)',
        'method routes.about (exported)',
        'method default.fetch (exported)',
        'method cfg.a (exported)',
      ]),
    );
    expect(ts).not.toContain('method fetch');
  });

  it('SG26 `__all__ +=` (list and tuple) extends a literal `__all__`; a non-literal one falls back to the naming rule', async () => {
    const py = await symbolsOf(
      "__all__ = ['a']\n__all__ += ['b']\n__all__ += ('c',)\ndef a(): pass\ndef b(): pass\ndef c(): pass\ndef d(): pass\n",
      'python',
      'pkg/m.py',
    );
    expect(py).toEqual(
      expect.arrayContaining([
        'function a (exported)',
        'function b (exported)',
        'function c (exported)',
        'function d',
      ]),
    );
    const dyn = await symbolsOf(
      "__all__ = ['a'] + other.__all__\ndef a(): pass\ndef b(): pass\ndef _c(): pass\n",
      'python',
      'pkg/n.py',
    );
    expect(dyn).toEqual(
      expect.arrayContaining(['function a (exported)', 'function b (exported)', 'function _c']),
    );
  });

  it('SG27 Python root index: first configured root wins, `.pyi` stubs, src layout, a stdlib name is not a subpackage', () => {
    const root = newRepo({
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
      'svc/pyproject.toml': '',
      'lib/core/__init__.py': '',
      'lib/core/util.py': '',
      'svc/src/core/__init__.py': '',
      'svc/src/core/util.py': '',
      'svc/src/core/fast.pyi': '',
      'svc/src/app/main.py': '',
      'flask/json/__init__.py': '',
      'flask/__init__.py': '',
      'flask/app.py': '',
      'tools/run.py': '',
    });
    const files = [
      'lib/core/__init__.py',
      'lib/core/util.py',
      'svc/src/core/__init__.py',
      'svc/src/core/util.py',
      'svc/src/core/fast.pyi',
      'svc/src/app/main.py',
      'flask/json/__init__.py',
      'flask/__init__.py',
      'flask/app.py',
      'tools/run.py',
    ];
    const byPath = new Map<string, ModuleFile>(
      files.map((p) => [p, { filePath: p, language: 'python' }]),
    );
    const r = new ModuleResolver(root, byPath);
    const at = (from: string, spec: string): string | null =>
      r.resolve(byPath.get(from)!, spec)?.filePath ?? null;
    // `lib` is configured before `svc/src` (scan order), as the pre-SG27 resolver chose.
    expect(at('tools/run.py', 'core.util')).toBe('lib/core/util.py');
    expect(at('svc/src/app/main.py', 'core.fast')).toBe('svc/src/core/fast.pyi');
    expect(at('flask/app.py', 'json')).toBeNull();
    expect(at('flask/app.py', '.json')).toBe('flask/json/__init__.py');
    expect(at('tools/run.py', 'os.path')).toBeNull();
  });

  it('SG27 PathsMatcher follows tsc precedence: exact key, then longest prefix, first declared on a tie, suffix must match', () => {
    const m = new PathsMatcher([
      { pattern: '@/*', targets: ['src/*'], base: '' },
      { pattern: '@/lib/*', targets: ['lib/*'], base: '' },
      { pattern: '@/lib/*.css', targets: ['styles/*'], base: '' },
      { pattern: '@/lib/x', targets: ['exact/x'], base: '' },
      { pattern: '~/*', targets: ['first/*'], base: '' },
      { pattern: '~/*', targets: ['dup/*'], base: '' },
      { pattern: '#*/util', targets: ['u/*'], base: '' },
    ]);
    expect(m.match('@/lib/x')?.targets).toEqual(['exact/x']);
    expect(m.match('@/lib/y')?.targets).toEqual(['lib/*']);
    expect(m.match('@/lib/a.css')?.targets).toEqual(['lib/*']); // same prefix: first declared
    expect(m.match('@/other')?.targets).toEqual(['src/*']);
    expect(m.match('~/z')?.targets).toEqual(['first/*']);
    expect(m.match('#a/util')?.targets).toEqual(['u/*']);
    expect(m.match('#a/other')).toBeNull();
  });

  it('SG25 an `extends` target outside every indexed directory is a resolver input: editing it re-resolves', async () => {
    const root = newRepo({
      'configs/base.json': '{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }',
      'tsconfig.json': '{ "extends": "./configs/base.json" }',
      'src/one.ts': 'export function f(): number { return 1; }\n',
      'src/two.ts': 'export function f(): number { return 2; }\n',
      'src/use.ts': "import { f } from '@/one';\nexport function u(): number { return f(); }\n",
    });
    const db = open(join(root, '..', 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
    expect(graphFrom(db).strong).toContain('src/use.ts::u -calls-> src/one.ts::f');
    writeTree(root, {
      'configs/base.json':
        '{ "compilerOptions": { "paths": { "@/one": ["../src/two.ts"], "@/*": ["../src/*"] } } }',
    });
    const stats = await indexRepo(db, root, { skipEmbeddings: true });
    expect(stats.resolveReason).toBe('resolver config changed');
    expect(graphFrom(db).strong).toContain('src/use.ts::u -calls-> src/two.ts::f');
  });

  it('SG29 parallel runs through the same DB path queue and leave one copy of each symbol', async () => {
    const root = newRepo({
      'src/a.ts': 'export function a(): number { return 1; }\n',
      'src/b.ts': 'export function b(): number { return 2; }\n',
    });
    const dbPath = join(root, '..', 'index.db');
    const a = open(dbPath);
    const b = open(dbPath);
    await Promise.all([
      indexRepo(a, root, { skipEmbeddings: true }),
      indexRepo(b, root, { skipEmbeddings: true }),
    ]);
    expect(counts(a).symbols).toBe(4);
  });

  it('SG28 the budget wrapper caps max_tokens and refuses a call it cannot pay when prompts are ~3 chars/token', async () => {
    const seen: number[] = [];
    const inner: LLMClient = {
      model: 'fake',
      complete: (params) => {
        seen.push(params.maxTokens);
        return Promise.resolve({
          content: 'ok',
          inputTokens: Math.ceil(params.messages[0]!.content.length / 4),
          outputTokens: params.maxTokens,
          stopReason: 'end_turn',
        });
      },
    };
    const budget = new TokenBudget(5000);
    const llm = budgeted(inner, budget);
    await llm.complete({
      messages: [{ role: 'user', content: 'x'.repeat(3000) }],
      maxTokens: 16000,
    });
    expect(seen[0]).toBe(4000);
    expect(budget.total().spent).toBeLessThanOrEqual(budget.cap);
    await expect(
      llm.complete({ messages: [{ role: 'user', content: 'x'.repeat(300) }], maxTokens: 16000 }),
    ).rejects.toThrow('token budget exhausted');
  });
});
