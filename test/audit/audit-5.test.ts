// AUDIT-5: graph and drift soundness, round 2. Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-5.md (IDs A5-xx). When a finding is
// fixed, its test starts passing, `it.fails` turns red, and it should become a plain `it`.
import { afterEach, describe, expect, it } from 'vitest';
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
import {
  createOfflineClient,
  exportDocs,
  readPersistedDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift, pageDriftReport } from '../../src/core/drift/index.js';
import { renderComment } from '../../src/cli/commands/ciCommentCmd.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function newRepo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit5-'));
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
  /** `path kind qualifiedName` for every non-module symbol. */
  symbols: string[];
  files: string[];
}

async function graphOf(files: Record<string, string | Buffer>): Promise<Graph> {
  const root = newRepo(files);
  const db = openDatabase(join(root, '..', 'index.db'));
  try {
    await indexRepo(db, root, { skipEmbeddings: true });
    const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
    const all = getAllSymbols(db);
    const label = new Map(
      all.map((s) => [
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
    const symbols = all
      .filter((s) => s.kind !== 'module')
      .map((s) => `${paths.get(s.file_id)} ${s.kind} ${s.qualified_name ?? s.name}`);
    return { strong, any, symbols, files: [...paths.values()] };
  } finally {
    closeDatabase(db);
  }
}

const strongTo = (g: Graph, prefix: string): string[] =>
  [...g.strong].filter((e) => e.includes(` -> ${prefix}`) || e.split('-> ')[1]?.startsWith(prefix));

// ---------------------------------------------------------------- graph

describe('AUDIT-5 graph', () => {
  // Express's own lib/response.js, lib/application.js and lib/request.js use this shape for
  // every public method (`res.send = function send(body) {...}`).
  const EXPRESS_STYLE = {
    'response.js':
      'var res = {};\n' +
      'res.send = function send(body) {\n  var chunk = body;\n  return this.json(chunk);\n};\n' +
      'res.json = function json(obj) {\n  return obj;\n};\n' +
      'module.exports = res;\n',
    'app.js':
      "const res = require('./response');\n" +
      "function handle() {\n  return res.send('x');\n}\nmodule.exports = handle;\n",
  };

  it.fails(
    'A5-01 `obj.m = function m() {}` defines a symbol and does not leak its locals',
    async () => {
      const g = await graphOf(EXPRESS_STYLE);
      expect(g.symbols.some((s) => /^response\.js (function|method) (res\.)?send$/.test(s))).toBe(
        true,
      );
      expect(g.symbols).not.toContain('response.js variable chunk');
    },
  );

  it.fails('A5-01 a call to an assigned method resolves across files', async () => {
    const g = await graphOf(EXPRESS_STYLE);
    expect(
      [...g.strong].some((e) => /^app\.js::handle -calls-> response\.js::(res\.)?send$/.test(e)),
    ).toBe(true);
  });

  it.fails(
    'A5-01 anonymous `exports.x = function () {}` defines `x` and keeps its locals local',
    async () => {
      const g = await graphOf({
        'user.js':
          'exports.list = function (req, res) {\n  var page = 1;\n  res.render(page);\n};\n',
      });
      expect(g.symbols.some((s) => / list$/.test(s))).toBe(true);
      expect(g.symbols).not.toContain('user.js variable page');
    },
  );

  const ALIASED = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }),
    'src/lib/util.ts':
      'export function foo(): number {\n  return 1;\n}\nexport function other(): number {\n  return 2;\n}\n',
    'src/app/page.ts':
      "import { foo } from '@/lib/util';\nexport function page(): number {\n  return foo();\n}\n",
  };

  it.fails('A5-02 tsconfig `paths` aliases (`@/lib/util`) resolve', async () => {
    const g = await graphOf(ALIASED);
    expect(g.strong).toContain('src/app/page.ts::page -calls-> src/lib/util.ts::foo');
  });

  it.fails(
    'A5-02 workspace package imports (`@acme/utils`) resolve to the package source',
    async () => {
      const g = await graphOf({
        'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
        'packages/utils/package.json': JSON.stringify({
          name: '@acme/utils',
          main: 'src/index.ts',
        }),
        'packages/utils/src/index.ts': 'export function fmt(): string {\n  return "";\n}\n',
        'packages/app/src/main.ts':
          "import { fmt } from '@acme/utils';\nexport function main(): string {\n  return fmt();\n}\n",
      });
      expect(g.strong).toContain(
        'packages/app/src/main.ts::main -calls-> packages/utils/src/index.ts::fmt',
      );
    },
  );

  it(
    'A5-03 source directories named `build` (or `dist`, `coverage`) below the root are indexed',
    async () => {
      const g = await graphOf({
        'src/build/compile.ts': 'export function compile(): void {}\n',
        'src/index.ts':
          "import { compile } from './build/compile';\nexport function run(): void {\n  compile();\n}\n",
      });
      expect(g.files).toContain('src/build/compile.ts');
      expect(g.strong).toContain('src/index.ts::run -calls-> src/build/compile.ts::compile');
    },
  );

  it.fails('A5-04 a function passed as a value through a module binding gets an edge', async () => {
    const g = await graphOf({
      'users.js':
        'function list(req, res) {}\nfunction view(req, res) {}\nmodule.exports = { list, view };\n',
      'app.js':
        "const users = require('./users');\nconst app = {};\napp.get('/users', users.list);\nfunction routes(r) {\n  r.get('/u/:id', users.view);\n}\nmodule.exports = routes;\n",
    });
    expect(strongTo(g, 'users.js::list')).not.toHaveLength(0);
    expect(strongTo(g, 'users.js::view')).not.toHaveLength(0);
  });

  it.fails('A5-05 TS namespace members are qualified and `NS.f()` resolves', async () => {
    const g = await graphOf({
      'geo.ts':
        'export namespace Circle {\n  export function area(): number { return 1; }\n}\n' +
        'export namespace Square {\n  export function area(): number { return 2; }\n}\n',
      'use.ts':
        "import { Circle } from './geo';\nexport function u(): number {\n  return Circle.area();\n}\n",
    });
    expect(g.symbols).not.toContain('geo.ts function area');
    expect(g.strong).toContain('use.ts::u -calls-> geo.ts::Circle.area');
  });

  it.fails(
    'A5-06 anonymous `export default class extends Base` keeps its heritage and members',
    async () => {
      const g = await graphOf({
        'base.ts': 'export class Base {\n  helper(): void {}\n}\n',
        'shape.ts':
          "import { Base } from './base';\nexport default class extends Base {\n  area(): number { return 1; }\n}\n",
        'use.ts': "import Shape from './shape';\nexport function u(): void {\n  new Shape();\n}\n",
      });
      expect(g.symbols).not.toContain('shape.ts method area'); // not a top-level member
      expect(
        [...g.strong].some(
          (e) => e.startsWith('shape.ts::') && e.endsWith('-extends-> base.ts::Base'),
        ),
      ).toBe(true);
      expect([...g.strong].some((e) => e.startsWith('use.ts::u -calls-> shape.ts::'))).toBe(true);
    },
  );

  it.fails('A5-07 Python src layout: tests importing the package resolve', async () => {
    const g = await graphOf({
      'pyproject.toml': '[project]\nname = "mypkg"\n',
      'src/mypkg/__init__.py': '',
      'src/mypkg/core.py': 'def helper():\n    return 1\n',
      'tests/test_core.py': 'from mypkg.core import helper\n\ndef test_it():\n    helper()\n',
    });
    expect(g.strong).toContain('tests/test_core.py::test_it -calls-> src/mypkg/core.py::helper');
  });

  it.fails(
    'A5-12 `f.call()` / `f.apply()` / `super()` resolve to the function and parent',
    async () => {
      const g = await graphOf({
        'a.ts': 'export function foo(): void {}\nexport class Base {\n  constructor() {}\n}\n',
        'b.ts':
          "import { foo, Base } from './a';\n" +
          'export function viaCall(): void {\n  foo.call(null);\n}\n' +
          'export class Sub extends Base {\n  constructor() {\n    super();\n  }\n}\n',
      });
      expect(g.strong).toContain('b.ts::viaCall -calls-> a.ts::foo');
      expect(
        [...g.strong].some((e) => e.startsWith('b.ts::Sub.constructor -calls-> a.ts::Base')),
      ).toBe(true);
    },
  );

  it.fails('A5-13 `from . import sub` in a package `__init__` does not import itself', async () => {
    const g = await graphOf({
      'pkg/__init__.py': 'from . import sub\n',
      'pkg/sub.py': 'def f():\n    return 1\n',
    });
    expect(g.any).not.toContain('pkg/__init__.py::<module> -imports-> pkg/__init__.py::<module>');
  });
});

// ---------------------------------------------------------------- drift

/** Index + offline docs + export to `.atlas/docs`, run `mutate`, then re-index unless `reindex` is false. */
async function driftAfter(
  files: Record<string, string | Buffer>,
  mutate: (root: string) => void,
  reindex = true,
): Promise<{ db: DB; root: string; docsDir: string }> {
  const root = newRepo(files);
  const docsDir = join(root, '.atlas', 'docs');
  const db = openDatabase(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
  exportDocs(db, docsDir);
  mutate(root);
  if (reindex) await indexRepo(db, root, { skipEmbeddings: true });
  return { db, root, docsDir };
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

describe('AUDIT-5 drift', () => {
  it.fails("A5-02 an aliased caller switching callee marks the callee's doc stale", async () => {
    const files: Record<string, string> = {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/lib/util.ts':
        'export function foo(): number {\n  return 1;\n}\nexport function other(): number {\n  return 2;\n}\n',
      'src/app/page.ts':
        "import { foo, other } from '@/lib/util';\nexport function page(): number {\n  return foo();\n}\n",
    };
    const { db, root, docsDir } = await driftAfter(files, (r) =>
      writeFileSync(
        join(r, 'src/app/page.ts'),
        "import { foo, other } from '@/lib/util';\nexport function page(): number {\n  return other();\n}\n",
      ),
    );
    try {
      // Only page.ts (its own content) and nothing about util.ts's incoming calls.
      expect(staleOf(db, root, docsDir, true)).toContain('src/lib/util.ts');
    } finally {
      closeDatabase(db);
    }
  });

  it('A5-03 an edit under `src/build/` is reported by drift', async () => {
    const { db, root, docsDir } = await driftAfter(
      {
        ...BASE,
        'src/build/compile.ts': 'export function compile(): void {}\n',
      },
      (r) =>
        writeFileSync(join(r, 'src/build/compile.ts'), 'export function compile2(): void {}\n'),
    );
    try {
      const report = detectDrift(db, { root, docs: readPersistedDocs(docsDir) });
      expect(
        report.failing || report.undocumented.some((u) => u.file === 'src/build/compile.ts'),
      ).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it('A5-08 a persisted doc saved with a UTF-8 BOM is still checked', async () => {
    const { db, root, docsDir } = await driftAfter(BASE, (r) =>
      writeFileSync(join(r, 'a.ts'), 'export function foo(): number { return 42; }\n'),
    );
    try {
      const p = join(docsDir, 'files', 'a.ts.md');
      writeFileSync(p, `﻿${readFileSync(p, 'utf8')}`);
      expect(staleOf(db, root, docsDir, true)).toContain('a.ts');
    } finally {
      closeDatabase(db);
    }
  });

  it(
    'A5-09 the CI comment counts every stale doc, not just the page it was given',
    async () => {
      const { db, root } = await driftAfter(BASE, (r) => {
        writeFileSync(join(r, 'a.ts'), 'export function foo(): number { return 42; }\n');
        writeFileSync(join(r, 'c.py'), 'def util():\n    return 2\n');
      });
      try {
        const full = detectDrift(db, { root });
        expect(full.totals.stale).toBeGreaterThanOrEqual(3); // a.ts, c.py, architecture
        const md = renderComment(pageDriftReport(full, { offset: 0, limit: 1 }));
        expect(md).toContain(`${full.totals.stale} stale doc(s)`);
      } finally {
        closeDatabase(db);
      }
    },
  );

  it.fails('A5-10 an edit to a non-UTF-8 byte in a Latin-1 file is not invisible', async () => {
    const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1');
    const { db, root, docsDir } = await driftAfter(
      { ...BASE, 'legacy.py': latin1('GREETING = "café"\n\ndef greet():\n    return GREETING\n') },
      (r) =>
        writeFileSync(
          join(r, 'legacy.py'),
          latin1('GREETING = "cafè"\n\ndef greet():\n    return GREETING\n'),
        ),
    );
    try {
      expect(staleOf(db, root)).toContain('legacy.py');
      expect(staleOf(db, root, docsDir)).toContain('legacy.py');
    } finally {
      closeDatabase(db);
    }
  });

  it.fails('A5-11 deleting a symbol-less file is stale in DB mode before re-indexing', async () => {
    const { db, root } = await driftAfter(
      { ...BASE, 'barrel.ts': "export * from './a';\n" },
      (r) => rmSync(join(r, 'barrel.ts')),
      false,
    );
    try {
      expect(staleOf(db, root, undefined, true)).toContain('barrel.ts');
    } finally {
      closeDatabase(db);
    }
  });
});
