// SG18: edges for property-assigned and anonymous functions, namespaces, and `references` edges for
// functions used as values (A5-01, A5-04, A5-05, A5-06). Edges print as `path::qname`.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeDatabase,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { resolveGraph } from '../../src/core/graph/index.js';
import {
  createOfflineClient,
  exportDocs,
  readPersistedDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

function newRepo(files: Record<string, string>): { root: string; db: DB } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sg18-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  writeTree(root, files);
  return { root, db: openDatabase(join(dir, 'index.db')) };
}

function edgesOf(db: DB): string[] {
  const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
  const label = new Map(
    getAllSymbols(db).map((s) => [
      s.id,
      `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`,
    ]),
  );
  return getAllEdges(db).map(
    (e) =>
      `${e.weak ? 'WEAK ' : ''}${label.get(e.src_symbol!)} -${e.kind}-> ${e.dst_symbol === null ? 'null' : label.get(e.dst_symbol)}`,
  );
}

async function graphOf(files: Record<string, string>): Promise<string[]> {
  const { root, db } = newRepo(files);
  try {
    await indexRepo(db, root, { skipEmbeddings: true });
    return edgesOf(db);
  } finally {
    closeDatabase(db);
  }
}

const refs = (edges: string[]): string[] =>
  edges.filter((e) => e.includes(' -references-> ')).sort();

describe('SG18 property-assigned and anonymous functions', () => {
  it('prototype methods resolve through `this` and across files', async () => {
    const g = await graphOf({
      'store.js':
        'function Store() {}\nStore.prototype.get = function (k) {\n  return this.has(k);\n};\n' +
        'Store.prototype.has = function (k) {\n  return !!k;\n};\nmodule.exports = Store;\n',
      'use.js':
        "const Store = require('./store');\nfunction main() {\n  const s = new Store();\n  return Store.prototype.get;\n}\nmodule.exports = main;\n",
    });
    expect(g).toContain('store.js::Store.get -calls-> store.js::Store.has');
    expect(g).toContain('use.js::main -calls-> store.js::Store');
  });

  it('anonymous `exports.x = function` is importable by name and its locals stay local', async () => {
    const g = await graphOf({
      'user.js': 'exports.list = function (req, res) {\n  var page = 1;\n  return page;\n};\n',
      'site.js':
        "const { list } = require('./user');\nconst user = require('./user');\n" +
        'function a() {\n  return list();\n}\nfunction b() {\n  return user.list();\n}\nmodule.exports = { a, b };\n',
    });
    expect(g).toContain('site.js::a -calls-> user.js::list');
    expect(g).toContain('site.js::b -calls-> user.js::list');
    expect(g.some((e) => e.includes('user.js::page'))).toBe(false);
  });

  it('`export default class extends` resolves `new`, static members and heritage', async () => {
    const g = await graphOf({
      'base.ts': 'export class Base {\n  helper(): void {}\n}\n',
      'shape.ts':
        "import { Base } from './base';\nexport default class extends Base {\n  static make(): void {}\n  area(): number {\n    this.helper();\n    return 1;\n  }\n}\n",
      'use.ts':
        "import Shape from './shape';\nexport function u(): void {\n  new Shape();\n  Shape.make();\n}\n",
    });
    expect(g).toEqual(
      expect.arrayContaining([
        'shape.ts::default -extends-> base.ts::Base',
        'shape.ts::default.area -calls-> base.ts::Base.helper',
        'use.ts::<module> -imports-> shape.ts::default',
        'use.ts::u -calls-> shape.ts::default',
        'use.ts::u -calls-> shape.ts::default.make',
      ]),
    );
  });

  it('members of an anonymous default class are not importable by name', async () => {
    const g = await graphOf({
      'shape.ts': 'export default class {\n  area(): number {\n    return 1;\n  }\n}\n',
      'use.ts':
        "import { area } from './shape';\nexport function u(): number {\n  return area();\n}\n",
    });
    expect(g).toContain('WEAK use.ts::u -calls-> null');
    expect(g.some((e) => e.endsWith('shape.ts::default.area'))).toBe(false);
  });

  it('namespace members do not collide and resolve through the namespace', async () => {
    const g = await graphOf({
      'geo.ts':
        'export namespace Circle {\n  export function area(): number { return 1; }\n}\n' +
        'export namespace Square {\n  export function area(): number { return 2; }\n}\n',
      'use.ts':
        "import { Circle, Square } from './geo';\nexport function u(): number {\n  return Circle.area() + Square.area();\n}\n",
    });
    expect(g).toEqual(
      expect.arrayContaining([
        'use.ts::u -calls-> geo.ts::Circle.area',
        'use.ts::u -calls-> geo.ts::Square.area',
      ]),
    );
  });
});

describe('SG18 references edges (A5-04)', () => {
  it('callbacks, arrays, object values and JSX props through module, named and same-file bindings', async () => {
    const g = await graphOf({
      'users.js':
        'function list(req, res) {}\nfunction view(req, res) {}\nconst LIMIT = 10;\nmodule.exports = { list, view, LIMIT };\n',
      'app.js':
        "const users = require('./users');\nconst { view } = require('./users');\n" +
        'function fmt(x) {\n  return x;\n}\n' +
        "function routes(r, xs) {\n  r.get('/u', users.list);\n  r.all([view]);\n  r.use({ format: fmt, limit: users.LIMIT });\n  return xs.map(fmt);\n}\n" +
        'module.exports = routes;\n',
      'ui.tsx': 'export function Button() {\n  return null;\n}\n',
      'page.tsx':
        "import { Button } from './ui';\nexport function Page() {\n  return <Slot component={Button} />;\n}\n",
    });
    expect(refs(g)).toEqual([
      'app.js::<module> -references-> app.js::routes',
      'app.js::routes -references-> app.js::fmt',
      'app.js::routes -references-> users.js::list',
      'app.js::routes -references-> users.js::view',
      'page.tsx::Page -references-> ui.tsx::Button',
      'users.js::<module> -references-> users.js::list',
      'users.js::<module> -references-> users.js::view',
    ]);
  });

  it('`this.m` passed as a value resolves to the method; no weak or self references edges', async () => {
    const g = await graphOf({
      'c.ts':
        "import * as ext from 'events';\nexport class C {\n  start(): void {\n    ext.on('x', this.onX);\n    ext.on('y', ext.missing);\n    setTimeout(this.start);\n  }\n  onX(): void {}\n}\n",
    });
    expect(refs(g)).toEqual(['c.ts::C.start -references-> c.ts::C.onX']);
  });

  it('Python callbacks and registries resolve across modules', async () => {
    const g = await graphOf({
      'pkg/__init__.py': '',
      'pkg/util.py': 'def helper():\n    return 1\n\nCONST = 1\n',
      'pkg/hooks.py':
        'from . import util\nfrom .util import helper\n\n' +
        'def on_start():\n    pass\n\nHOOKS = [on_start]\n\n' +
        'def register(app):\n    app.add(callback=helper, other=util.helper, n=util.CONST)\n    return on_start\n',
    });
    expect(refs(g)).toEqual([
      'pkg/hooks.py::HOOKS -references-> pkg/hooks.py::on_start',
      'pkg/hooks.py::register -references-> pkg/hooks.py::on_start',
      'pkg/hooks.py::register -references-> pkg/util.py::helper',
    ]);
  });

  it('counts references edges in the resolve stats', async () => {
    const { root, db } = newRepo({
      'a.js': 'function f() {}\nfunction g(cb) {}\ng(f);\nmodule.exports = { f, g };\n',
    });
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const stats = resolveGraph(db, { root });
      expect(stats.references).toBe(2); // <module> -> f (from `g(f)` and the export, once), -> g
      expect(stats.heritage).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('SG18 drift sees references edges', () => {
  it("switching the callback a caller passes marks the callee's doc stale", async () => {
    const before =
      "const h = require('./handlers');\nfunction routes(r) {\n  r.get('/', h.list);\n}\nmodule.exports = routes;\n";
    const { root, db } = newRepo({
      'handlers.js':
        'exports.list = function (req, res) {};\nexports.view = function (req, res) {};\n',
      'routes.js': before,
    });
    try {
      const docsDir = join(root, '.atlas', 'docs');
      await indexRepo(db, root, { skipEmbeddings: true });
      await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
      exportDocs(db, docsDir);
      writeFileSync(join(root, 'routes.js'), before.replace('h.list', 'h.view'));
      await indexRepo(db, root, { skipEmbeddings: true });
      const stale = detectDrift(db, {
        root,
        skipArchitecture: true,
        docs: readPersistedDocs(docsDir),
      }).stale.map((s) => s.targetPath);
      expect(stale.sort()).toEqual(['handlers.js', 'routes.js']);
    } finally {
      closeDatabase(db);
    }
  });
});
