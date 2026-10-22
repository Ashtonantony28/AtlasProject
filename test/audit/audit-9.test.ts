// AUDIT-9: encoding soundness, round 3 (no false negatives). Each `it.fails` asserts the
// CORRECT behaviour and currently fails, reproducing one finding in AUDIT-9.md (IDs A9-xx).
// When a finding is fixed, its test starts passing, `it.fails` turns red, and it should become
// a plain `it`. Plain `it` blocks pin behaviour that was checked and found sound.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  MIGRATIONS,
  openDatabase,
} from '../../src/core/db/index.js';
import { indexRepo, walkRepo } from '../../src/core/ingest/index.js';
import { ModuleResolver } from '../../src/core/graph/modules.js';
import { parseSource } from '../../src/core/parse/index.js';
import { createOfflineClient, synthesizeDocs } from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';

const dirs: string[] = [];
afterEach(() => {
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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit9-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  writeTree(root, files);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

interface Graph {
  /** `src -kind-> dst` for resolved edges; labels are `path::qualifiedName` (`<module>` for files). */
  strong: Set<string>;
  /** Like `strong`, with the destination's kind and start line: `src -kind-> dst(kind@line)`. */
  typed: string[];
  /** Every edge, resolved or weak, as `src -kind-> dst|null`. */
  any: string[];
  /** `path kind qualifiedName` for every non-module symbol. */
  symbols: string[];
  /** `path qualifiedName` for every exported non-module symbol. */
  exported: string[];
}

type DB = ReturnType<typeof openDatabase>;

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
  const typed: string[] = [];
  const any: string[] = [];
  for (const e of getAllEdges(db)) {
    any.push(`${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}`);
    if (e.weak === 0 && e.dst_symbol !== null) {
      strong.add(`${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}`);
      const d = byId.get(e.dst_symbol)!;
      typed.push(
        `${label(e.src_symbol)} -${e.kind}-> ${label(e.dst_symbol)}(${d.kind}@${d.start_line})`,
      );
    }
  }
  const named = all.filter((s) => s.kind !== 'module');
  return {
    strong,
    typed,
    any,
    symbols: named.map((s) => `${paths.get(s.file_id)} ${s.kind} ${s.qualified_name ?? s.name}`),
    exported: named
      .filter((s) => s.exported === 1)
      .map((s) => `${paths.get(s.file_id)} ${s.qualified_name ?? s.name}`),
  };
}

async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = newRepo(files);
  const db = openDatabase(join(root, '..', 'index.db'));
  try {
    await indexRepo(db, root, { skipEmbeddings: true });
    return graphFrom(db);
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------- incremental indexing

describe('AUDIT-9 incremental indexing', () => {
  it.fails(
    'A9-01 an index written by an older extractor is re-parsed after an upgrade, without --force',
    async () => {
      const root = newRepo({
        'lib.js':
          'var obj = {};\nobj.m = function m() {\n  var local = 1;\n  return local;\n};\nmodule.exports = obj;\n',
      });
      const dbPath = join(root, '..', 'index.db');
      let db = openDatabase(dbPath);
      await indexRepo(db, root, { skipEmbeddings: true });
      expect(graphFrom(db).symbols).toContain('lib.js method obj.m');

      // Rewrite the file's rows as the pre-SG18 extractor (schema v5, the latest when SG18
      // merged) stored them: no `obj.m`, and the method's local leaked as a top-level variable.
      // The content hash is untouched, exactly as after `npm update` of Atlas.
      const fileId = getAllFiles(db)[0]!.id;
      db.prepare("DELETE FROM symbols WHERE file_id = ? AND qualified_name = 'obj.m'").run(fileId);
      db.prepare(
        `INSERT INTO symbols (file_id, kind, name, signature, start_line, end_line, docstring, qualified_name, exported)
         VALUES (?, 'variable', 'local', 'var local = 1;', 3, 3, NULL, 'local', 0)`,
      ).run(fileId);
      // Roll the bookkeeping back to v5: drop migration records and tables added after it.
      const v5 = new Database(':memory:');
      sqliteVec.load(v5);
      for (const m of MIGRATIONS.filter((x) => x.version <= 5)) v5.exec(m.sql);
      const v5Tables = new Set(
        v5.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[],
      );
      v5.close();
      db.prepare('DELETE FROM _migrations WHERE version > 5').run();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .all() as string[];
      for (const t of tables)
        if (t !== '_migrations' && !v5Tables.has(t)) db.exec(`DROP TABLE IF EXISTS "${t}"`);
      closeDatabase(db);

      // The upgraded Atlas opens the same index and runs a plain `atlas index`.
      db = openDatabase(dbPath);
      try {
        await indexRepo(db, root, { skipEmbeddings: true });
        const g = graphFrom(db);
        expect(g.symbols).toContain('lib.js method obj.m');
        expect(g.symbols).not.toContain('lib.js variable local');
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails(
    'A9-03 a tsconfig `paths` change alone re-resolves edges on the next plain re-index',
    async () => {
      const root = newRepo({
        'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
        'src/lib/util.ts': 'export function util(): number { return 1; }\n',
        'src/lib/other.ts': 'export function util(): number { return 2; }\n',
        'src/app/page.ts':
          "import { util } from '@/lib/util';\nexport function page(): number { return util(); }\n",
      });
      const db = openDatabase(join(root, '..', 'index.db'));
      try {
        await indexRepo(db, root, { skipEmbeddings: true });
        expect(graphFrom(db).strong).toContain(
          'src/app/page.ts::page -calls-> src/lib/util.ts::util',
        );
        writeFileSync(
          join(root, 'tsconfig.json'),
          '{ "compilerOptions": { "paths": { "@/lib/util": ["./src/lib/other.ts"], "@/*": ["./src/*"] } } }',
        );
        await indexRepo(db, root, { skipEmbeddings: true });
        const g = graphFrom(db);
        expect(g.strong).toContain('src/app/page.ts::page -calls-> src/lib/other.ts::util');
        expect(g.strong).not.toContain('src/app/page.ts::page -calls-> src/lib/util.ts::util');
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails(
    'A9-03 adding `workspaces` to package.json alone resolves workspace imports on re-index',
    async () => {
      const root = newRepo({
        'package.json': '{ "name": "root" }',
        'packages/w/package.json': '{ "name": "@acme/w", "main": "./src/index.ts" }',
        'packages/w/src/index.ts': 'export function w(): void {}\n',
        'apps/a/main.ts': "import { w } from '@acme/w';\nexport function main(): void { w(); }\n",
      });
      const db = openDatabase(join(root, '..', 'index.db'));
      try {
        await indexRepo(db, root, { skipEmbeddings: true });
        writeFileSync(
          join(root, 'package.json'),
          '{ "name": "root", "workspaces": ["packages/*"] }',
        );
        await indexRepo(db, root, { skipEmbeddings: true });
        expect(graphFrom(db).strong).toContain(
          'apps/a/main.ts::main -calls-> packages/w/src/index.ts::w',
        );
      } finally {
        closeDatabase(db);
      }
    },
  );

  it('consistency: a plain re-index after renaming a target re-resolves its unchanged importers', async () => {
    const root = newRepo({
      'a.ts': 'export function a(): void {}\n',
      'b.ts': "import { a } from './a';\nexport function b(): void { a(); }\n",
    });
    const db = openDatabase(join(root, '..', 'index.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      expect(graphFrom(db).strong).toContain('b.ts::b -calls-> a.ts::a');
      rmSync(join(root, 'a.ts'));
      writeTree(root, { 'a/index.ts': 'export function a(): void {}\n' });
      await indexRepo(db, root, { skipEmbeddings: true });
      expect(graphFrom(db).strong).toContain('b.ts::b -calls-> a/index.ts::a');
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------------------------------------------------------------- symbol extraction

describe('AUDIT-9 symbols', () => {
  it(
    'A9-02 locals of a callback passed at module level are not top-level symbols',
    async () => {
      const g = await graphOf({
        // express lib/request.js defines its getters this way (`req.protocol`, `req.ip`, ...).
        'request.js':
          'var req = {};\n' +
          "defineGetter(req, 'protocol', function protocol() {\n  var proto = 'http';\n  var trust = this.app.get('trust');\n  return trust ? proto : 'https';\n});\n" +
          'function defineGetter(obj, name, getter) {}\nmodule.exports = req;\n',
        // A test file and a route handler.
        'spec.js':
          "describe('x', () => {\n  const fixture = 1;\n  function helper() { return fixture; }\n  it('y', () => helper());\n});\n",
      });
      expect(g.symbols).not.toContain('request.js variable proto');
      expect(g.symbols).not.toContain('request.js variable trust');
      expect(g.symbols).not.toContain('spec.js variable fixture');
      expect(g.symbols).not.toContain('spec.js function helper');
    },
  );

  it(
    'A9-02 a callback local that shares a top-level name does not capture its incoming edges',
    async () => {
      const g = await graphOf({
        'lib.js':
          'function render(x) { return x; }\nmodule.exports = { render };\n' +
          "app.get('/', function (req, res) {\n  var render = req.query.r;\n  res.send(render);\n});\n",
        'use.js':
          "const { render } = require('./lib');\nfunction page() { return render(1); }\nmodule.exports = page;\n",
      });
      expect(g.typed).toContain('use.js::page -calls-> lib.js::render(function@1)');
    },
  );

  it(
    'A9-07 members of `as const` / `satisfies` objects are qualified symbols that resolve',
    async () => {
      const g = await graphOf({
        'cfg.ts':
          'export const routes = {\n  home() { return 1; },\n  about: () => 2,\n} as const;\n' +
          'export function go(): number { return routes.home() + routes.about(); }\n',
        'worker.ts':
          "import { handle } from './h';\n" +
          'export default {\n  async fetch(req: Request): Promise<unknown> { return handle(req); },\n} satisfies Record<string, unknown>;\n',
        'h.ts': 'export function handle(r: unknown): unknown { return r; }\n',
      });
      expect(g.symbols).toContain('cfg.ts method routes.home');
      expect(g.symbols).toContain('cfg.ts method routes.about');
      expect(g.strong).toContain('cfg.ts::go -calls-> cfg.ts::routes.home');
      // Today `fetch` is a top-level, unexported method, as if the object were not there.
      expect(g.symbols).not.toContain('worker.ts method fetch');
      expect(g.symbols).toContain('worker.ts method default.fetch');
    },
  );

  it(
    'A9-11 public API declared through `module.exports` aliases, `export declare` and `__all__ +=` is exported',
    async () => {
      const g = await graphOf({
        // express lib/application.js: none of the 34 `app.*` symbols is exported today.
        'application.js':
          'var app = exports = module.exports = {};\napp.use = function use(fn) {};\n',
        'types.d.ts':
          'export declare function f(): void;\nexport declare class C {}\nexport declare const k: number;\n',
        'm.py': '__all__ = ["a"]\n__all__ += ["b"]\n\ndef a():\n    pass\n\ndef b():\n    pass\n',
      });
      expect(g.exported).toContain('application.js app.use');
      expect(g.exported).toContain('types.d.ts f');
      expect(g.exported).toContain('types.d.ts C');
      expect(g.exported).toContain('types.d.ts k');
      expect(g.exported).toContain('m.py b');
    },
  );

  it(
    'A9-12 every name of a chained method assignment is a symbol (`req.get = req.header = fn`)',
    async () => {
      const g = await graphOf({
        'request.js':
          'var req = {};\nreq.get =\nreq.header = function header(name) { return name; };\nmodule.exports = req;\n',
        'use.js':
          "const req = require('./request');\nfunction host() { return req.get('host'); }\nmodule.exports = host;\n",
      });
      expect(g.symbols).toContain('request.js method req.header');
      expect(g.symbols).toContain('request.js method req.get');
      expect(g.strong).toContain('use.js::host -calls-> request.js::req.get');
    },
  );

  it('consistency: chunked parsing keeps every symbol after >8 KB of astral-plane text', async () => {
    let src = '';
    for (let i = 0; i < 1500; i++)
      src += `// ${'😀'.repeat(5)} ${i}\nexport function f${i}(): string { return '中'; }\n`;
    const r = await parseSource(src, 'typescript', 'x.ts');
    expect(r.symbols).toHaveLength(1500);
    expect(r.symbols.at(-1)).toMatchObject({ name: 'f1499', startLine: 3000 });
    expect(r.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------- edges

describe('AUDIT-9 edges', () => {
  it.fails('A9-04 a relative import of a `.d.ts` module resolves (as tsc does)', async () => {
    const g = await graphOf({
      'src/types.d.ts':
        'export interface Shape { area(): number }\nexport declare function helper(): void;\n',
      'src/use.ts':
        "import { Shape, helper } from './types';\nexport class Sq implements Shape { area(): number { helper(); return 1; } }\n",
    });
    expect(g.strong).toContain('src/use.ts::Sq -implements-> src/types.d.ts::Shape');
    expect(g.strong).toContain('src/use.ts::Sq.area -calls-> src/types.d.ts::helper');
  });

  it.fails(
    'A9-05 package.json `imports` (#subpath) and a package importing itself by name resolve',
    async () => {
      const g = await graphOf({
        'package.json':
          '{ "name": "mylib", "type": "module", "exports": { ".": "./src/index.ts" }, "imports": { "#util/*": "./src/util/*.ts" } }',
        'src/index.ts':
          "import { fmt } from '#util/fmt';\nexport function lib(): number { return fmt(); }\n",
        'src/util/fmt.ts': 'export function fmt(): number { return 1; }\n',
        'test/lib.test.ts':
          "import { lib } from 'mylib';\nexport function t(): number { return lib(); }\n",
      });
      expect(g.strong).toContain('src/index.ts::lib -calls-> src/util/fmt.ts::fmt');
      expect(g.strong).toContain('test/lib.test.ts::t -calls-> src/index.ts::lib');
    },
  );

  it.fails(
    'A9-05 pnpm-workspace.yaml with a flow-style `packages` list resolves members',
    async () => {
      const g = await graphOf({
        'pnpm-workspace.yaml': "packages: ['pk/*']\n",
        'pk/a/package.json': '{ "name": "a", "main": "index.ts" }',
        'pk/a/index.ts': 'export function fa(): void {}\n',
        'pk/b/index.ts': "import { fa } from 'a';\nexport function fb(): void { fa(); }\n",
      });
      expect(g.strong).toContain('pk/b/index.ts::fb -calls-> pk/a/index.ts::fa');
    },
  );

  it.fails(
    'A9-08 function values wrapped in `as`, a ternary, `||`, parentheses or a default get references edges',
    async () => {
      const g = await graphOf({
        'h.ts':
          'export function h1(): void {}\nexport function h2(): void {}\nexport function h3(): void {}\nexport function h4(): void {}\nexport function h5(): void {}\n',
        'u.ts':
          "import { h1, h2, h3, h4, h5 } from './h';\ndeclare const app: { get(p: string, f: unknown): void };\ndeclare const cond: boolean;\n" +
          "export function cast(): void { app.get('/', h1 as unknown); }\n" +
          'export function tern(): unknown { return cond ? h2 : null; }\n' +
          "export function logic(): void { app.get('/', h3 || null); }\n" +
          "export function paren(): void { app.get('/', (h4)); }\n" +
          'export function dflt(cb: unknown = h5): unknown { return cb; }\n',
        'p/h.py': 'def g1():\n    pass\n\ndef g2():\n    pass\n',
        'p/u.py':
          'from p.h import g1, g2\n\ndef tern(c):\n    return g1 if c else None\n\ndef logic(app):\n    app.add(g2 or None)\n',
      });
      for (const e of [
        'u.ts::cast -references-> h.ts::h1',
        'u.ts::tern -references-> h.ts::h2',
        'u.ts::logic -references-> h.ts::h3',
        'u.ts::paren -references-> h.ts::h4',
        'u.ts::dflt -references-> h.ts::h5',
        'p/u.py::tern -references-> p/h.py::g1',
        'p/u.py::logic -references-> p/h.py::g2',
      ])
        expect(g.strong).toContain(e);
    },
  );

  it.fails(
    'A9-09 `module.Class.method()` through a module binding resolves (TS and Python)',
    async () => {
      const g = await graphOf({
        'web/util.ts': 'export class Timer { static start(): void {} }\n',
        'web/use.ts':
          "import * as util from './util';\nexport function go(): void { util.Timer.start(); }\n",
        'app/__init__.py': '',
        'app/models.py':
          'class User:\n    @classmethod\n    def create(cls):\n        return cls()\n',
        'app/views.py':
          'from app import models\nimport app.models\n\ndef view():\n    models.User.create()\n\ndef view2():\n    app.models.User.create()\n',
      });
      expect(g.strong).toContain('web/use.ts::go -calls-> web/util.ts::Timer.start');
      expect(g.strong).toContain('app/views.py::view -calls-> app/models.py::User.create');
      expect(g.strong).toContain('app/views.py::view2 -calls-> app/models.py::User.create');
    },
  );

  it.fails(
    'A5-04 (still open, partial) a type annotation through a namespace import gets an edge',
    async () => {
      const g = await graphOf({
        'types.ts': 'export class Model {}\n',
        'use.ts':
          "import * as T from './types';\nexport function g(m: T.Model): T.Model { return m; }\n",
      });
      expect(g.strong).toContain('use.ts::g -references-> types.ts::Model');
    },
  );

  it('consistency: `import json` in a package with a `json` subpackage is the stdlib, not the subpackage', () => {
    const byPath = new Map(
      ['src/flask/__init__.py', 'src/flask/json/__init__.py', 'src/flask/config.py'].map((p) => [
        p,
        { filePath: p, language: 'python' },
      ]),
    );
    const mr = new ModuleResolver(newRepo({}), byPath);
    expect(mr.resolve(byPath.get('src/flask/config.py')!, 'json')).toBeNull();
    expect(mr.resolve(byPath.get('src/flask/config.py')!, '.json')?.filePath).toBe(
      'src/flask/json/__init__.py',
    );
  });
});

// ---------------------------------------------------------------- walker

describe('AUDIT-9 walker', () => {
  it.fails(
    'A9-06 a tracked file that matches .gitignore is indexed (it is in `git ls-files`)',
    async () => {
      const root = newRepo({
        '.gitignore': 'next-env.d.ts\nvendor/\n',
        'next-env.d.ts': 'export declare const env: string;\n',
        'vendor/lib.js': 'function vendored() {}\nmodule.exports = vendored;\n',
        'src/a.ts': 'export const a = 1;\n',
      });
      git(root, 'init', '-q', '.');
      git(root, 'add', '-f', '.');
      git(root, 'commit', '-qm', 'init');
      const tracked = git(root, 'ls-files')
        .trim()
        .split('\n')
        .filter((p) => /\.(ts|js)$/.test(p));
      expect(
        walkRepo(root)
          .map((f) => f.relativePath)
          .sort(),
      ).toEqual(tracked.sort());
    },
  );

  it.fails('A9-10 a source file over the 1 MiB cap is reported, not silently dropped', async () => {
    let big = '';
    for (let i = 0; big.length <= 1024 * 1024; i++)
      big += `export function f${i}(): number { return ${i}; }\n`;
    const root = newRepo({
      'checker.ts': big,
      'use.ts': "import { f1 } from './checker';\nexport function u(): number { return f1(); }\n",
    });
    const db = openDatabase(join(root, '..', 'index.db'));
    try {
      const events: string[] = [];
      const stats = await indexRepo(db, root, {
        skipEmbeddings: true,
        onFile: (f) => events.push(`${f.path} ${f.status}`),
      });
      expect(events.some((e) => e.startsWith('checker.ts '))).toBe(true);
      expect(stats.filesSkipped + stats.filesFailed).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('consistency: the walker agrees with `git ls-files -o --exclude-standard` on nested negations', () => {
    const root = newRepo({
      '.gitignore':
        '*.gen.ts\n/lib/\n!lib/keep.ts\nlogs\n**/tmp/**\nsrc/gen/*\n!src/gen/keep.ts\n*.py[cod]\n',
      'pkg/a/.gitignore': 'dist/\n',
      'a/.gitignore': '*.ts\n!b/\n',
      'a/b/.gitignore': '!*.ts\n',
    });
    for (const f of [
      'src/x.ts',
      'src/y.gen.ts',
      'src/gen/z.ts',
      'src/gen/keep.ts',
      'src/build/b.ts',
      'lib/keep.ts',
      'pkg/a/dist/o.js',
      'pkg/a/src/i.ts',
      'a/top.ts',
      'a/b/mid.ts',
      'a/b/c/deep.ts',
      'logs/l.py',
      'docs/tmp/t.py',
      'x.pyc',
    ])
      writeTree(root, { [f]: 'export const v = 1;\n' });
    git(root, 'init', '-q', '.');
    const expected = git(root, 'ls-files', '-o', '--exclude-standard')
      .trim()
      .split('\n')
      .filter((p) => /\.(ts|js|py)$/.test(p))
      .sort();
    expect(
      walkRepo(root)
        .map((f) => f.relativePath)
        .sort(),
    ).toEqual(expected);
  });
});

// ---------------------------------------------------------------- resolver diagnostics

describe('AUDIT-9 diagnostics', () => {
  it.fails(
    'A9-13 resolver diagnostics (ambiguous workspace package) reach the index result',
    async () => {
      const root = newRepo({
        'package.json': '{ "name": "root", "workspaces": ["examples/*"] }',
        'examples/one/package.json': '{ "name": "example" }',
        'examples/one/index.ts': 'export function one(): void {}\n',
        'examples/two/package.json': '{ "name": "example" }',
        'examples/two/index.ts':
          "import { one } from 'example';\nexport function two(): void { one(); }\n",
      });
      const db = openDatabase(join(root, '..', 'index.db'));
      try {
        const stats = await indexRepo(db, root, { skipEmbeddings: true });
        expect(JSON.stringify(stats)).toContain('workspace package "example"');
      } finally {
        closeDatabase(db);
      }
    },
  );
});

// ---------------------------------------------------------------- mutation kills
// Plain `it`s for behaviour that is correct today but that a surviving mutant (AUDIT-9.md,
// Mutation results) showed no test pins. Each fails against its mutant.

describe('AUDIT-9 mutation kills', () => {
  it('M06 a workspace package whose `main` is in an unindexed `dist/` resolves to its `src/`', async () => {
    const g = await graphOf({
      'package.json': '{ "name": "root", "workspaces": ["packages/*"] }',
      'packages/core/package.json': '{ "name": "@acme/core", "main": "./dist/esm/lib.js" }',
      'packages/core/src/esm/lib.ts': 'export function core(): void {}\n',
      'packages/core/src/index.ts': 'export function decoy(): void {}\n',
      'apps/web/main.ts':
        "import { core } from '@acme/core';\nexport function main(): void { core(); }\n",
    });
    expect(g.strong).toContain(
      'apps/web/main.ts::main -calls-> packages/core/src/esm/lib.ts::core',
    );
  });

  it('M11 a `src/` layout resolves even when another dir holds a package of the same name', async () => {
    const g = await graphOf({
      'pyproject.toml': '[project]\nname = "mypkg"\n',
      'src/mypkg/__init__.py': '',
      'src/mypkg/core.py': 'def helper():\n    return 1\n',
      'examples/vendored/mypkg/__init__.py': '',
      'examples/vendored/mypkg/core.py': 'def helper():\n    return 2\n',
      'tests/test_core.py': 'from mypkg.core import helper\n\ndef test_it():\n    helper()\n',
    });
    expect(g.strong).toContain('tests/test_core.py::test_it -calls-> src/mypkg/core.py::helper');
  });

  it('M14 moving an imported module marks the unchanged importer stale (outgoing neighbourhood)', async () => {
    const root = newRepo({
      'lib.ts': 'export function a(): number { return 1; }\n',
      'use.ts': "export { a } from './lib';\nexport const n = 1;\n",
    });
    const db = openDatabase(join(root, '..', 'index.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
      rmSync(join(root, 'lib.ts'));
      writeTree(root, { 'lib/index.ts': 'export function a(): number { return 1; }\n' });
      await indexRepo(db, root, { skipEmbeddings: true });
      const stale = detectDrift(db, { root, skipArchitecture: true }).stale.map(
        (s) => s.targetPath,
      );
      expect(stale).toContain('use.ts');
    } finally {
      closeDatabase(db);
    }
  });

  it('M18 `from pkg.fast import f` resolves to a stub-only `fast.pyi` (compiled extension)', async () => {
    const g = await graphOf({
      'pkg/__init__.py': '',
      'pkg/fast.pyi': 'def f() -> int: ...\n',
      'app.py': 'from pkg.fast import f\n\ndef main():\n    f()\n',
    });
    expect(g.strong).toContain('app.py::main -calls-> pkg/fast.pyi::f');
  });

  it('M19 `exports` conditions prefer `import` over `require`', async () => {
    const g = await graphOf({
      'package.json': '{ "name": "root", "workspaces": ["packages/*"] }',
      'packages/dual/package.json':
        '{ "name": "dual", "exports": { ".": { "require": "./src/cjs.ts", "import": "./src/esm.ts" } } }',
      'packages/dual/src/esm.ts': 'export function d(): void {}\n',
      'packages/dual/src/cjs.ts': 'export function d(): void {}\n',
      'app.ts': "import { d } from 'dual';\nexport function main(): void { d(); }\n",
    });
    expect(g.strong).toContain('app.ts::main -calls-> packages/dual/src/esm.ts::d');
  });

  it('M21 an exact `paths` pattern wins over a wildcard with an equally long prefix (as in tsc)', async () => {
    const g = await graphOf({
      'tsconfig.json':
        '{ "compilerOptions": { "paths": { "@/utils*": ["./src/utils*"], "@/utils": ["./src/utils-main.ts"] } } }',
      'src/utils.ts': 'export function u(): void {}\n',
      'src/utils-main.ts': 'export function u(): void {}\n',
      'app.ts': "import { u } from '@/utils';\nexport function main(): void { u(); }\n",
    });
    expect(g.strong).toContain('app.ts::main -calls-> src/utils-main.ts::u');
  });
});
