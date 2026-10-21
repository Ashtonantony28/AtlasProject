// AUDIT-1: graph and drift soundness. Each `it.fails` asserts the CORRECT behaviour and
// currently fails, reproducing one finding in AUDIT-1.md (IDs A1-xx). When a finding is
// fixed, its test starts passing, `it.fails` turns red, and it should become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { parseSource } from '../../src/core/parse/parser.js';
import {
  createOfflineClient,
  exportDocs,
  readPersistedDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { runCli } from '../cli/helpers.js';

const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit1-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  writeTree(root, files);
  return root;
}

interface Graph {
  /** `src -kind-> dst` for resolved edges. */
  strong: Set<string>;
  /** Every edge, resolved or weak, as `src -kind-> dst|null`. */
  any: string[];
}

async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = newRepo(files);
  const db = openDatabase(join(root, '..', 'index.db'));
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
      const src = e.src_symbol === null ? 'null' : label.get(e.src_symbol)!;
      const dst = e.dst_symbol === null ? 'null' : label.get(e.dst_symbol)!;
      any.push(`${src} -${e.kind}-> ${dst}`);
      if (e.weak === 0 && e.dst_symbol !== null) strong.add(`${src} -${e.kind}-> ${dst}`);
    }
    return { strong, any };
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------- graph

describe('AUDIT-1 graph', () => {
  it.fails('A1-01 TS barrel re-exports resolve to the defining module', async () => {
    const g = await graphOf({
      'lib/foo.ts': 'export function foo(): number { return 1; }\nexport class Base<T> {}\n',
      'lib/bar.ts': 'export function bar(): number { return 2; }\n',
      'lib/index.ts': "export { foo, Base } from './foo';\nexport * from './bar';\n",
      'use.ts':
        "import { foo, Base, bar } from './lib';\n" +
        'export function viaBarrel(): number { return foo() + bar(); }\n' +
        'export class Sub extends Base<string> {}\n',
    });
    expect(g.strong).toContain('use.ts::viaBarrel -calls-> lib/foo.ts::foo');
    expect(g.strong).toContain('use.ts::viaBarrel -calls-> lib/bar.ts::bar');
    expect(g.strong).toContain('use.ts::Sub -extends-> lib/foo.ts::Base');
  });

  it.fails(
    'A1-01 the barrel file itself has an edge (even weak) to each re-exported module',
    async () => {
      const g = await graphOf({
        'lib/foo.ts': 'export function foo(): number { return 1; }\n',
        'lib/bar.ts': 'export function bar(): number { return 2; }\n',
        'lib/index.ts': "export { foo } from './foo';\nexport * from './bar';\n",
      });
      expect(g.any.filter((e) => e.startsWith('lib/index.ts::<module> -imports->'))).toHaveLength(
        2,
      );
    },
  );

  it.fails(
    'A1-01 Python re-exports through __init__.py resolve to the defining module',
    async () => {
      const g = await graphOf({
        'app/__init__.py': '',
        'app/api/__init__.py': 'from .views import view\n',
        'app/api/views.py': 'def view():\n    return 1\n',
        'main.py': 'from app.api import view\ndef run():\n    return view()\n',
      });
      expect(g.strong).toContain('main.py::run -calls-> app/api/views.py::view');
    },
  );

  it.fails('A1-02 default imports resolve calls and heritage to the default export', async () => {
    const g = await graphOf({
      'def.ts': 'export default function makeThing(): number { return 3; }\n',
      'DefClass.ts': 'export default class DefClass {}\n',
      'use.ts':
        "import makeThing from './def';\nimport DefClass from './DefClass';\n" +
        'export function useDef(): number { return makeThing(); }\n' +
        'export class Child extends DefClass {}\n',
    });
    expect(g.strong).toContain('use.ts::useDef -calls-> def.ts::makeThing');
    expect(g.strong).toContain('use.ts::Child -extends-> DefClass.ts::DefClass');
  });

  it.fails(
    'A1-02 CJS `module.exports = fn` resolves calls to fn, not to the local require binding',
    async () => {
      const g = await graphOf({
        'app.js': 'function createApp() { return 1; }\nmodule.exports = createApp;\n',
        'main.js':
          "const app = require('./app');\nfunction main() { return app(); }\nmodule.exports = { main };\n",
      });
      expect(g.strong).not.toContain('main.js::main -calls-> main.js::app');
      expect(g.strong).toContain('main.js::main -calls-> app.js::createApp');
    },
  );

  it.fails('A1-03 Python subscripted base classes (generics) produce an extends edge', async () => {
    const g = await graphOf({
      'models.py':
        'from typing import Generic, TypeVar\nT = TypeVar("T")\n' +
        'class Repo(Generic[T]):\n    def get(self):\n        return 1\n',
      'users.py':
        'from models import Repo\nclass User:\n    pass\n' +
        'class UserRepo(Repo[User]):\n    def all(self):\n        return self.get()\n',
    });
    expect(g.strong).toContain('users.py::UserRepo -extends-> models.py::Repo');
    expect(g.strong).toContain('users.py::UserRepo.all -calls-> models.py::Repo.get');
  });

  it('A1-04 parser does not throw on a long top-level expression (TS)', async () => {
    const src = `console.log(${'"a" + '.repeat(4000)}"b");\nexport function after(): void {}\n`;
    const r = await parseSource(src, 'typescript', 'gen.ts');
    expect(r.symbols.map((s) => s.name)).toContain('after');
  });

  it('A1-04 parser does not throw on a long top-level expression (Python)', async () => {
    const src = `print(${'"a" + '.repeat(4000)}"b")\ndef after():\n    pass\n`;
    const r = await parseSource(src, 'python', 'gen.py');
    expect(r.symbols.map((s) => s.name)).toContain('after');
  });

  it.fails('A1-09 JSX component usage produces an edge to the component', async () => {
    const g = await graphOf({
      'Button.tsx': 'export function Button(): JSX.Element { return <button />; }\n',
      'App.tsx':
        "import { Button } from './Button';\n" +
        'export function App(): JSX.Element { return <div><Button /></div>; }\n',
    });
    expect(g.strong).toContain('App.tsx::App -calls-> Button.tsx::Button');
  });

  it.fails('A1-10 dynamic import() produces an import edge', async () => {
    const g = await graphOf({
      'bar.ts': 'export function bar(): number { return 2; }\n',
      'lazy.ts':
        "export async function lazy(): Promise<number> { const m = await import('./bar'); return m.bar(); }\n",
    });
    expect(g.any.some((e) => e.startsWith('lazy.ts::') && e.includes('bar.ts::'))).toBe(true);
  });

  it.fails('A1-10 require() inside a function produces an import edge', async () => {
    const g = await graphOf({
      'bar.js': 'function bar() { return 2; }\nmodule.exports = { bar };\n',
      'use.js':
        "function inner() { const b = require('./bar'); return b.bar(); }\nmodule.exports = { inner };\n",
    });
    expect(g.any.some((e) => e.startsWith('use.js::') && e.includes('bar.js::'))).toBe(true);
  });

  it.fails('A1-10 TS `import x = require()` produces an import edge', async () => {
    const g = await graphOf({
      'bar.ts': 'export function bar(): number { return 2; }\n',
      'req.ts': "import B = require('./bar');\nexport function r(): number { return B.bar(); }\n",
    });
    expect(g.any.some((e) => e.startsWith('req.ts::') && e.includes('bar.ts::'))).toBe(true);
  });

  it.fails('A1-10 Python function-local imports produce import and call edges', async () => {
    const g = await graphOf({
      'helpers.py': 'def helper():\n    return 1\n',
      'views.py': 'def view():\n    from helpers import helper\n    return helper()\n',
    });
    expect(g.strong).toContain('views.py::view -calls-> helpers.py::helper');
  });

  it.fails('A1-11 bare decorators produce a calls edge (TS)', async () => {
    const g = await graphOf({
      'log.ts': 'export function Log(t: unknown, k: string): void {}\n',
      'w.ts': "import { Log } from './log';\nexport class W {\n  @Log\n  m(): void {}\n}\n",
    });
    expect(g.any.some((e) => e.startsWith('w.ts::') && e.endsWith('-calls-> log.ts::Log'))).toBe(
      true,
    );
  });

  it.fails('A1-11 decorator call on a non-exported class produces a calls edge', async () => {
    const g = await graphOf({
      'dec.ts': 'export function Dec() { return (c: unknown) => c; }\n',
      'd.ts': "import { Dec } from './dec';\n@Dec()\nclass D {}\nexport { D };\n",
    });
    expect(g.any.some((e) => e.startsWith('d.ts::') && e.endsWith('-calls-> dec.ts::Dec'))).toBe(
      true,
    );
  });

  it.fails('A1-11 bare decorators produce a calls edge (Python)', async () => {
    const g = await graphOf({
      'reg.py': 'def register(fn):\n    return fn\n',
      'v.py': 'from reg import register\n@register\ndef view():\n    return 1\n',
    });
    expect(
      g.any.some((e) => e.startsWith('v.py::') && e.endsWith('-calls-> reg.py::register')),
    ).toBe(true);
  });

  it.fails('A1-12 Python star imports give calls an edge (resolved or weak)', async () => {
    const g = await graphOf({
      'pkg/__init__.py': '',
      'pkg/lib.py': 'def star_fn():\n    return 1\n',
      'pkg/use.py': 'from .lib import *\ndef use():\n    return star_fn()\n',
    });
    expect(g.any.some((e) => e.startsWith('pkg/use.py::use -calls->'))).toBe(true);
  });

  it.fails('A1-14 calls in non-function values of a default-export object are kept', async () => {
    const g = await graphOf({
      'lib.ts': 'export function compute(): number { return 1; }\n',
      'cfg.ts': "import { compute } from './lib';\nexport default { value: compute() };\n",
    });
    expect(
      g.any.some((e) => e.startsWith('cfg.ts::') && e.endsWith('-calls-> lib.ts::compute')),
    ).toBe(true);
  });

  it.fails('A1-15 `exports.x = function x() {}` defines an importable symbol', async () => {
    const g = await graphOf({
      'util.js': 'exports.helper = function helper() { return 1; };\n',
      'main.js':
        "const { helper } = require('./util');\nfunction main() { return helper(); }\nmodule.exports = { main };\n",
    });
    expect(g.strong).toContain('main.js::main -calls-> util.js::helper');
  });

  it.fails('A1-16 class expressions and mixin calls in heritage produce edges', async () => {
    const g = await graphOf({
      'a.ts': 'export class A {}\nexport function mixin<T>(b: T): T { return b; }\n',
      'b.ts':
        "import { A, mixin } from './a';\nexport const E = class extends A {};\nexport class F extends mixin(A) {}\n",
    });
    expect(g.any.some((e) => e.startsWith('b.ts::E') && e.includes('a.ts::A'))).toBe(true);
    expect(g.any.some((e) => e.startsWith('b.ts::F') && e.includes('a.ts::'))).toBe(true);
  });
});

// ---------------------------------------------------------------- drift

/** Index + offline docs + export to `.atlas/docs`, run `mutate`, re-index; returns the open DB. */
async function driftAfter(
  files: Record<string, string>,
  mutate: (root: string) => void,
): Promise<{ db: DB; root: string; docsDir: string; failed: number }> {
  const root = newRepo(files);
  const docsDir = join(root, '.atlas', 'docs');
  const db = openDatabase(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
  exportDocs(db, docsDir);
  mutate(root);
  const st = await indexRepo(db, root, { skipEmbeddings: true });
  return { db, root, docsDir, failed: st.filesFailed };
}

const staleOf = (db: DB, root: string, docsDir?: string, skipArchitecture = false): string[] =>
  detectDrift(db, {
    root,
    skipArchitecture,
    ...(docsDir ? { docs: readPersistedDocs(docsDir) } : {}),
  }).stale.map((s) => s.targetPath);

const BASE = {
  'a.ts':
    'export function foo(): number {\n  return 1;\n}\nexport function other(): number { return 2; }\n',
  'b.ts': "import { foo } from './a';\nexport function b(): number { return foo(); }\n",
  'c.py': 'def util():\n    return 1\n',
};

describe('AUDIT-1 drift', () => {
  it('A1-04 an edit that makes the parser throw still marks the doc stale', async () => {
    const { db, root, docsDir, failed } = await driftAfter(BASE, (r) =>
      writeFileSync(
        join(r, 'a.ts'),
        `${readFileSync(join(r, 'a.ts'), 'utf8')}console.log(${'"a" + '.repeat(4000)}"b");\nexport function added(): void {}\n`,
      ),
    );
    try {
      expect(failed).toBe(0); // the parser no longer throws, so the edit indexes (failed re-index: test/drift/unindexed.test.ts)
      expect(staleOf(db, root)).toContain('a.ts');
      expect(staleOf(db, root, docsDir)).toContain('a.ts');
    } finally {
      closeDatabase(db);
    }
  });

  // A hub with 13 cross-file callers: the 13th (alphabetically) is outside MAX_CALLS.
  const hub = (): Record<string, string> => {
    const files: Record<string, string> = { ...BASE };
    for (let i = 1; i <= 12; i++) {
      const n = String(i).padStart(2, '0');
      files[`k${n}.ts`] =
        `import { foo } from './a';\nexport function c${n}(): number { return foo(); }\n`;
    }
    files['zz.ts'] =
      "import { foo, other } from './a';\nexport function zz(): number { return foo(); }\n";
    return files;
  };

  it.fails(
    "A1-05 a change in a hub module's incoming calls beyond the 12-edge cap marks it stale",
    async () => {
      const { db, root, docsDir } = await driftAfter(hub(), (r) =>
        writeFileSync(
          join(r, 'zz.ts'),
          "import { foo, other } from './a';\nexport function zz(): number { return other(); }\n",
        ),
      );
      try {
        expect(staleOf(db, root)).toContain('a.ts');
        expect(staleOf(db, root, docsDir)).toContain('a.ts');
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails(
    'A1-06 an incoming-call change cut off by the 6,000-char prompt cap marks the doc stale',
    async () => {
      const D = 'packages/platform-services/src/modules/notifications/internal/handlers';
      const files: Record<string, string> = {};
      let hubSrc = '';
      for (let i = 1; i <= 30; i++) {
        const n = String(i).padStart(2, '0');
        hubSrc += `import { dependencyNumber${n} } from './${D}/dependency_module_number_${n}';\n`;
        files[`${D}/dependency_module_number_${n}.ts`] =
          `export function dependencyNumber${n}(): number { return ${i}; }\n`;
      }
      files['hub.ts'] =
        `${hubSrc}export function hubEntryPoint(): number { return dependencyNumber01(); }\n`;
      for (let i = 1; i <= 12; i++) {
        const n = String(i).padStart(2, '0');
        files[`${D}/caller_${n}.ts`] =
          "import { hubEntryPoint } from '../../../../../../../hub';\n" +
          `export function callerWithAVeryDescriptiveLongName${n}(): number { return hubEntryPoint(); }\n`;
      }
      const { db, root } = await driftAfter(files, (r) => {
        const p = join(r, D, 'caller_12.ts');
        writeFileSync(
          p,
          readFileSync(p, 'utf8').replace('callerWithAVeryDescriptiveLongName12', 'renamed12'),
        );
      });
      try {
        expect(staleOf(db, root, undefined, true)).toContain('hub.ts');
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails('A1-07 `drift --docs-dir` on a missing directory fails instead of passing', async () => {
    const { db, root } = await driftAfter(BASE, (r) =>
      writeFileSync(join(r, 'a.ts'), 'export function foo(): number { return 42; }\n'),
    );
    closeDatabase(db);
    // CLI reads `.atlas/index.db` under --cwd: build that index too.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', root]);
    await runCli(['drift', '--cwd', root, '--docs-dir', '.atlas/no-such-dir']);
    expect(process.exitCode ?? 0).not.toBe(0);
  });

  it.fails('A1-08 persisted docs with CRLF line endings are still checked', async () => {
    const { db, root, docsDir } = await driftAfter(BASE, (r) =>
      writeFileSync(join(r, 'a.ts'), 'export function foo(): number { return 42; }\n'),
    );
    try {
      for (const rel of ['files/a.ts.md', 'files/b.ts.md', 'files/c.py.md', 'architecture.md']) {
        const p = join(docsDir, rel);
        writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
      }
      expect(staleOf(db, root, docsDir)).toContain('a.ts');
    } finally {
      closeDatabase(db);
    }
  });

  it.fails(
    'A1-17 DB-mode drift reports the doc of a deleted file (with --skip-architecture)',
    async () => {
      const { db, root } = await driftAfter(BASE, (r) => rmSync(join(r, 'c.py')));
      try {
        expect(staleOf(db, root, undefined, true)).toContain('c.py');
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails(
    'A1-18 a member is not "documented" just because another class\'s member shares its name',
    async () => {
      const root = newRepo({
        'r.ts': 'export class Foo { render(): void {} }\nexport class Bar { render(): void {} }\n',
      });
      const db = openDatabase(join(root, '..', 'index.db'));
      try {
        await indexRepo(db, root, { skipEmbeddings: true });
        const report = detectDrift(db, {
          root,
          skipArchitecture: true,
          docs: [
            {
              kind: 'file',
              target: 'r.ts',
              sourceHash: 'x',
              content: 'Foo and Bar. Bar.render draws.',
            },
          ],
        });
        expect(report.undocumented.map((u) => u.symbol)).toContain('Foo.render');
      } finally {
        closeDatabase(db);
      }
    },
  );
});
