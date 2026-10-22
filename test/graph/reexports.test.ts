// SG10: re-exports, default/CJS exports, generic Python bases and the cheap mediums
// (JSX, dynamic/nested imports, Python star imports). Edges print as `path::qname`.
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
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { parseSource } from '../../src/core/parse/parser.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function graphOf(
  files: Record<string, string>,
): Promise<{ strong: Set<string>; any: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sg10-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const db = openDatabase(join(dir, 'index.db'));
  try {
    await indexRepo(db, root, { skipEmbeddings: true });
    const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
    const label = new Map(
      getAllSymbols(db).map((s) => [
        s.id,
        `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`,
      ]),
    );
    const strong = new Set<string>();
    const any: string[] = [];
    for (const e of getAllEdges(db)) {
      const src = label.get(e.src_symbol!)!;
      const dst = e.dst_symbol === null ? 'null' : label.get(e.dst_symbol)!;
      any.push(`${e.weak ? 'WEAK ' : ''}${src} -${e.kind}-> ${dst}`);
      if (e.weak === 0 && e.dst_symbol !== null) strong.add(`${src} -${e.kind}-> ${dst}`);
    }
    return { strong, any };
  } finally {
    closeDatabase(db);
  }
}

describe('SG10 re-exports', () => {
  it('terminates on an export * cycle and leaves unknown names weak', async () => {
    const g = await graphOf({
      'a.ts': "export * from './b';\n",
      'b.ts': "export * from './a';\n",
      'use.ts': "import { nope } from './a';\nexport function u(): void { nope(); }\n",
    });
    expect(g.any).toContain('WEAK use.ts::<module> -imports-> a.ts::<module>');
    expect(g.any).toContain('WEAK use.ts::u -calls-> null');
    expect(g.strong).toContain('a.ts::<module> -imports-> b.ts::<module>');
    expect(g.strong).toContain('b.ts::<module> -imports-> a.ts::<module>');
  });

  it('follows `export * as ns`, local aliases and `export { default as x }`', async () => {
    const g = await graphOf({
      'm.ts': 'export function f(): number { return 1; }\n',
      'impl.ts': 'function impl(): number { return 2; }\nexport { impl as api };\n',
      'd.ts': 'export default function dflt(): number { return 3; }\n',
      'barrel.ts':
        "export * as ns from './m';\nexport { api } from './impl';\nexport { default as named } from './d';\n",
      'use.ts':
        "import { ns, api, named } from './barrel';\n" +
        'export function u(): number { return ns.f() + api() + named(); }\n',
    });
    expect(g.strong).toContain('barrel.ts::<module> -imports-> m.ts::<module>');
    expect(g.strong).toContain('use.ts::u -calls-> m.ts::f');
    expect(g.strong).toContain('use.ts::u -calls-> impl.ts::impl');
    expect(g.strong).toContain('use.ts::u -calls-> d.ts::dflt');
    expect(g.strong).toContain('use.ts::<module> -imports-> barrel.ts::<module>');
  });

  it('a namespace import of a barrel resolves members through it', async () => {
    const g = await graphOf({
      'lib/foo.ts': 'export function foo(): number { return 1; }\n',
      'lib/index.ts': "export * from './foo';\n",
      'use.ts':
        "import * as lib from './lib';\nexport function u(): number { return lib.foo(); }\n",
    });
    expect(g.strong).toContain('use.ts::u -calls-> lib/foo.ts::foo');
  });
});

describe('SG10 default and CJS exports', () => {
  it('TS `export = X` with `import X = require()` resolves the call', async () => {
    const g = await graphOf({
      'x.ts': 'function X(): number { return 1; }\nexport = X;\n',
      'use.ts': "import X = require('./x');\nexport function u(): number { return X(); }\n",
    });
    expect(g.strong).toContain('use.ts::u -calls-> x.ts::X');
  });

  it('member calls on a default class do not fall back to module functions', async () => {
    const g = await graphOf({
      'v.ts': 'export default class View {}\nexport function render(): void {}\n',
      'use.ts': "import View from './v';\nexport function u(): void { View.render(); }\n",
    });
    expect([...g.strong].filter((e) => e.startsWith('use.ts::u'))).toEqual([]);
    expect(g.any).toContain('WEAK use.ts::u -calls-> null');
  });

  it('calling a require binding with no known default goes through the local variable', async () => {
    const g = await graphOf({
      'obj.js': 'module.exports = { a() { return 1; } };\n',
      'use.js':
        "const obj = require('./obj');\nconst pkg = require('pkg');\n" +
        'function u() { return obj() + pkg(); }\nmodule.exports = { u };\n',
    });
    expect(g.strong).toContain('use.js::u -calls-> use.js::obj');
    expect(g.strong).toContain('use.js::u -calls-> use.js::pkg');
  });

  it('`module.exports = class` and `= function name` define symbols and defaults', async () => {
    const r = await parseSource(
      'module.exports = class Model extends Base { save() { return go(); } };\n',
      'javascript',
      'm.js',
    );
    expect(r.symbols.map((s) => [s.qualifiedName, s.exported])).toEqual([
      ['Model', true],
      ['Model.save', true],
    ]);
    expect(r.references.map((x) => `${x.fromQualifiedName} ${x.kind} ${x.name}`)).toEqual([
      'Model extends Base',
      'Model.save calls go',
    ]);
    expect(r.imports).toEqual([
      { module: '', imported: 'Model', alias: 'default', line: 1, reexport: true },
    ]);
    const f = await parseSource('module.exports = function make() { return 1; };\n', 'javascript');
    expect(f.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(['function make']);
  });

  it('CJS re-exports through a required variable reach the definition', async () => {
    const g = await graphOf({
      'impl.js':
        'function make() { return 1; }\nfunction aux() { return 2; }\nmodule.exports = make;\nmodule.exports.aux = aux;\n',
      'mid.js':
        "const make = require('./impl');\nexports.tools = require('./impl');\nmodule.exports = make;\n",
      'use.js':
        "const m = require('./mid');\nfunction u() { return m() + m.aux(); }\nmodule.exports = { u };\n",
    });
    expect(g.strong).toContain('use.js::u -calls-> impl.js::make');
    expect(g.strong).toContain('use.js::u -calls-> impl.js::aux');
  });

  it('anonymous default exports are a `default` symbol that imports and calls resolve to (A5-06)', async () => {
    const g = await graphOf({
      'anon.ts': 'export default function () { return 1; }\n',
      'use.ts': "import anon from './anon';\nexport function u(): number { return anon(); }\n",
    });
    expect(g.strong).toContain('use.ts::<module> -imports-> anon.ts::default');
    expect(g.strong).toContain('use.ts::u -calls-> anon.ts::default');
  });
});

describe('SG10 JSX, nested imports, Python', () => {
  it('JSX member tags resolve; intrinsic tags give no reference', async () => {
    const g = await graphOf({
      'ui.tsx': 'export function Button() { return <button />; }\n',
      'App.tsx':
        "import * as UI from './ui';\nexport function App() { return <div><UI.Button></UI.Button></div>; }\n",
    });
    expect(g.strong).toContain('App.tsx::App -calls-> ui.tsx::Button');
    const r = await parseSource('const x = <div><span /></div>;\n', 'typescript', 'a.tsx');
    expect(r.references).toEqual([]);
  });

  it('records a string-literal require/import only once and ignores computed ones', async () => {
    const r = await parseSource(
      "const a = require('./a');\nfunction f() { require('./a'); require(name); return import('./b'); }\n",
      'javascript',
    );
    expect(r.imports.map((i) => `${i.module} ${i.imported}`)).toEqual(['./a default', './b null']);
  });

  it('Python star imports: unresolved modules give weak calls, builtins none', async () => {
    const g = await graphOf({
      'lib.py': 'def known():\n    return 1\n',
      'a.py': 'from lib import *\ndef f():\n    print(1)\n    return known()\n',
      'b.py': 'from somewhere import *\ndef g():\n    return thing()\n',
    });
    expect(g.strong).toContain('a.py::f -calls-> lib.py::known');
    expect(g.any.filter((e) => e.startsWith('a.py::f -calls->'))).toHaveLength(1);
    expect(g.any).toContain('WEAK b.py::g -calls-> null');
  });

  it('Python `typing.Generic[T]` gives a weak extends edge', async () => {
    const g = await graphOf({
      'r.py': 'import typing\nT = typing.TypeVar("T")\nclass R(typing.Generic[T]):\n    pass\n',
    });
    expect(g.any).toContain('WEAK r.py::R -extends-> null');
  });
});
