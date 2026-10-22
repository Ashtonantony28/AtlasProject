// SG19: tsconfig/jsconfig `paths` + `baseUrl` (with `extends`), workspace packages and Python
// roots resolve to the right indexed file; anything else stays weak, and bad configs never throw.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { resolveGraph } from '../../src/core/graph/index.js';
import { parseJsonc } from '../../src/core/graph/modules.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Result {
  strong: Set<string>;
  /** `importer -> module` for weak import edges. */
  weakImports: string[];
  diagnostics: string[];
  root: string;
}

const json = (v: unknown): string => JSON.stringify(v);

async function resolve(files: Record<string, string>): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-modules-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const db = openDatabase(join(dir, 'index.db'));
  try {
    await indexRepo(db, root, { skipEmbeddings: true });
    const { diagnostics } = resolveGraph(db, { root });
    const paths = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
    const label = new Map(
      getAllSymbols(db).map((s) => [
        s.id,
        `${paths.get(s.file_id)}::${s.kind === 'module' ? '<module>' : (s.qualified_name ?? s.name)}`,
      ]),
    );
    const strong = new Set<string>();
    const weakImports: string[] = [];
    for (const e of getAllEdges(db)) {
      const src = label.get(e.src_symbol!)!;
      if (e.weak === 0 && e.dst_symbol !== null)
        strong.add(`${src} -${e.kind}-> ${label.get(e.dst_symbol)!}`);
      else if (e.kind === 'imports')
        weakImports.push(
          `${src.split('::')[0]} -> ${(JSON.parse(e.meta!) as { module: string }).module}`,
        );
    }
    return { strong, weakImports, diagnostics, root };
  } finally {
    closeDatabase(db);
  }
}

const USE = (spec: string, name = 'foo'): string =>
  `import { ${name} } from '${spec}';\nexport function use(): number {\n  return ${name}();\n}\n`;
const FOO = 'export function foo(): number {\n  return 1;\n}\n';

describe('tsconfig / jsconfig paths and baseUrl', () => {
  it('resolves a wildcard alias through baseUrl', async () => {
    const r = await resolve({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/util.ts': FOO,
      'src/app/page.tsx': USE('@/lib/util'),
    });
    expect(r.strong).toContain('src/app/page.tsx::use -calls-> src/lib/util.ts::foo');
    expect(r.weakImports).toEqual([]);
  });

  it('resolves paths relative to the tsconfig when baseUrl is absent', async () => {
    const r = await resolve({
      'web/tsconfig.json': json({ compilerOptions: { paths: { '~/*': ['./app/*'] } } }),
      'web/app/util.ts': FOO,
      'web/app/routes/home.ts': USE('~/util'),
    });
    expect(r.strong).toContain('web/app/routes/home.ts::use -calls-> web/app/util.ts::foo');
  });

  it('resolves bare specifiers against baseUrl alone', async () => {
    const r = await resolve({
      'tsconfig.json': json({ compilerOptions: { baseUrl: 'src' } }),
      'src/lib/util.ts': FOO,
      'src/main.ts': USE('lib/util') + "import React from 'react';\n",
    });
    expect(r.strong).toContain('src/main.ts::use -calls-> src/lib/util.ts::foo');
    expect(r.weakImports).toEqual(['src/main.ts -> react']);
  });

  it('follows extends chains (with and without .json, arrays) and keeps paths relative to their config', async () => {
    const r = await resolve({
      'tsconfig.base.json': json({
        compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['packages/shared/src/*'] } },
      }),
      'configs/strict.json': json({
        extends: '../tsconfig.base',
        compilerOptions: { strict: true },
      }),
      'packages/app/tsconfig.json': json({
        extends: ['../../configs/strict.json', '@tsconfig/node20/tsconfig.json'],
      }),
      'packages/shared/src/math.ts': FOO,
      'packages/app/src/main.ts': USE('@shared/math'),
    });
    expect(r.strong).toContain(
      'packages/app/src/main.ts::use -calls-> packages/shared/src/math.ts::foo',
    );
    expect(r.diagnostics).toEqual([]);
  });

  it('a child config overrides inherited paths; nearest config wins', async () => {
    const r = await resolve({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/util.ts': FOO,
      'pkg/tsconfig.json': json({
        extends: '../tsconfig.json',
        compilerOptions: { paths: { '@/*': ['./lib/*'] } },
      }),
      'pkg/lib/util.ts': FOO,
      'pkg/main.ts': USE('@/util'),
      'src/main.ts': USE('@/util'),
    });
    // Inherited baseUrl ('.') makes the child's paths relative to the repo root: pkg/lib is not there.
    expect([...r.strong].filter((e) => e.startsWith('pkg/main.ts::use -calls->'))).toEqual([]);
    expect(r.weakImports).toContain('pkg/main.ts -> @/util');
    expect(r.strong).toContain('src/main.ts::use -calls-> src/util.ts::foo');
  });

  it('picks the longest wildcard prefix, exact patterns first, and falls through targets', async () => {
    const r = await resolve({
      'tsconfig.json': json({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@app/*': ['src/*'],
            '@app/core/*': ['missing/*', 'core/*'],
            config: ['src/config'],
            '*.svc': ['services/*'],
          },
        },
      }),
      'src/core/a.ts': 'export function wrong(): void {}\n',
      'core/a.ts': FOO,
      'src/config/index.ts': 'export function cfg(): number {\n  return 1;\n}\n',
      'services/auth.ts': 'export function login(): number {\n  return 1;\n}\n',
      'main.ts':
        USE('@app/core/a') +
        "import { cfg } from 'config';\nimport { login } from 'auth.svc';\nexport function m(): number {\n  return cfg() + login();\n}\n",
    });
    expect(r.strong).toContain('main.ts::use -calls-> core/a.ts::foo');
    expect(r.strong).toContain('main.ts::m -calls-> src/config/index.ts::cfg');
    expect(r.strong).toContain('main.ts::m -calls-> services/auth.ts::login');
  });

  it('reads JSONC (comments, trailing commas) and jsconfig.json', async () => {
    const r = await resolve({
      'jsconfig.json':
        '{\n  // aliases\n  "compilerOptions": {\n    /* root */ "baseUrl": ".",\n    "paths": { "#lib/*": ["lib/*",], },\n  },\n}\n',
      'lib/util.js': 'export function foo() {\n  return "http://x//y";\n}\n',
      'app.js': "import { foo } from '#lib/util';\nexport function use() {\n  return foo();\n}\n",
    });
    expect(r.strong).toContain('app.js::use -calls-> lib/util.js::foo');
  });

  it('uses the first referenced config with aliases for a solution-style tsconfig', async () => {
    const r = await resolve({
      'tsconfig.json': json({
        files: [],
        references: [{ path: './tsconfig.node.json' }, { path: './tsconfig.app.json' }],
      }),
      'tsconfig.node.json': json({ include: ['vite.config.ts'] }),
      'tsconfig.app.json': json({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
      'src/util.ts': FOO,
      'src/App.tsx': USE('@/util'),
    });
    expect(r.strong).toContain('src/App.tsx::use -calls-> src/util.ts::foo');
  });

  it('leaves unresolvable aliases weak and never points them elsewhere', async () => {
    const r = await resolve({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/util.ts': FOO,
      'main.ts': USE('@/missing') + "import { x } from '@/util/deeper';\n",
    });
    expect(r.weakImports.sort()).toEqual(['main.ts -> @/missing', 'main.ts -> @/util/deeper']);
    expect([...r.strong].filter((e) => e.startsWith('main.ts::use'))).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{ "compilerOptions": { "paths": '],
    ['a non-object', '[1, 2]'],
    [
      'wrong shapes',
      json({ compilerOptions: { baseUrl: 3, paths: { '@/*': 'src/*' } }, extends: 7 }),
    ],
  ])('does not throw on %s: imports stay weak', async (_, text) => {
    const r = await resolve({
      'tsconfig.json': text,
      'src/util.ts': FOO,
      'main.ts': USE('@/util'),
    });
    expect(r.weakImports).toEqual(['main.ts -> @/util']);
  });

  it('reports a malformed tsconfig and a circular extends as diagnostics', async () => {
    const bad = await resolve({ 'tsconfig.json': '{ nope', 'main.ts': USE('x') });
    expect(bad.diagnostics).toEqual([expect.stringMatching(/^tsconfig\.json: /)]);
    const loop = await resolve({
      'tsconfig.json': json({ extends: './b.json' }),
      'b.json': json({ extends: './tsconfig.json' }),
      'main.ts': USE('x'),
    });
    expect(loop.diagnostics).toEqual([expect.stringMatching(/circular "extends"/)]);
  });

  it('parseJsonc keeps comment-like text inside strings and rejects garbage', () => {
    expect(parseJsonc('﻿{"a": "//not", /* c */ "b": ["/*x*/",],}')).toEqual({
      a: '//not',
      b: ['/*x*/'],
    });
    expect(() => parseJsonc('{ a: 1 }')).toThrow();
  });
});

describe('workspace packages', () => {
  const app = (spec: string, name = 'fmt'): string =>
    `import { ${name} } from '${spec}';\nexport function main(): string {\n  return ${name}();\n}\n`;
  const FMT = 'export function fmt(): string {\n  return "";\n}\n';

  it('npm workspaces: `main`, scoped name', async () => {
    const r = await resolve({
      'package.json': json({ private: true, workspaces: ['packages/*'] }),
      'packages/utils/package.json': json({ name: '@acme/utils', main: 'src/index.ts' }),
      'packages/utils/src/index.ts': FMT,
      'packages/app/src/main.ts': app('@acme/utils'),
    });
    expect(r.strong).toContain(
      'packages/app/src/main.ts::main -calls-> packages/utils/src/index.ts::fmt',
    );
  });

  it('yarn `workspaces.packages`, `exports` conditions with dist → src, and src/index fallback', async () => {
    const r = await resolve({
      'package.json': json({ workspaces: { packages: ['libs/**'] } }),
      'libs/a/package.json': json({
        name: 'a',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
      }),
      'libs/a/src/index.ts': FMT,
      'libs/group/b/package.json': json({ name: 'b', main: 'dist/cjs/main.js' }),
      'libs/group/b/src/index.ts': 'export function bee(): string {\n  return "";\n}\n',
      'app.ts': app('a') + app('b', 'bee').replace('main()', 'm2()'),
    });
    expect(r.strong).toContain('app.ts::main -calls-> libs/a/src/index.ts::fmt');
    expect(r.strong).toContain('app.ts::m2 -calls-> libs/group/b/src/index.ts::bee');
  });

  it('pnpm-workspace.yaml with exclusions; subpath exports and subpaths without exports', async () => {
    const r = await resolve({
      'pnpm-workspace.yaml': 'packages:\n  - \'packages/*\'\n  - "!packages/legacy"\n# end\n',
      'packages/ui/package.json': json({
        name: '@acme/ui',
        exports: {
          '.': './src/index.ts',
          './button': './src/button.tsx',
          './icons/*': './src/icons/*.tsx',
        },
      }),
      'packages/ui/src/index.ts': FMT,
      'packages/ui/src/button.tsx': 'export function Button(): string {\n  return "";\n}\n',
      'packages/ui/src/icons/star.tsx': 'export function Star(): string {\n  return "";\n}\n',
      'packages/core/package.json': json({ name: 'core' }),
      'packages/core/src/deep/thing.ts': 'export function thing(): string {\n  return "";\n}\n',
      'packages/legacy/package.json': json({ name: 'legacy', main: 'index.ts' }),
      'packages/legacy/index.ts': FMT,
      'apps/web/main.ts':
        "import { Button } from '@acme/ui/button';\nimport { Star } from '@acme/ui/icons/star';\n" +
        "import { thing } from 'core/deep/thing';\nimport { fmt } from 'legacy';\n" +
        'export function main(): string {\n  return Button() + Star() + thing() + fmt();\n}\n',
    });
    expect(r.strong).toContain(
      'apps/web/main.ts::main -calls-> packages/ui/src/button.tsx::Button',
    );
    expect(r.strong).toContain(
      'apps/web/main.ts::main -calls-> packages/ui/src/icons/star.tsx::Star',
    );
    expect(r.strong).toContain(
      'apps/web/main.ts::main -calls-> packages/core/src/deep/thing.ts::thing',
    );
    expect(r.weakImports).toEqual(['apps/web/main.ts -> legacy']);
  });

  it('a package name declared twice, a non-member package and a bad package.json stay weak', async () => {
    const r = await resolve({
      'package.json': json({ workspaces: ['a', 'b', 'c'] }),
      'a/package.json': json({ name: 'dup', main: 'index.ts' }),
      'a/index.ts': FMT,
      'b/package.json': json({ name: 'dup', main: 'index.ts' }),
      'b/index.ts': FMT,
      'c/package.json': '{ "name": ',
      'c/index.ts': FMT,
      'fixtures/other/package.json': json({ name: 'other', main: 'index.ts' }),
      'fixtures/other/index.ts': FMT,
      'main.ts': app('dup') + "import 'other';\nimport 'c';\n",
    });
    expect(r.weakImports.sort()).toEqual(['main.ts -> c', 'main.ts -> dup', 'main.ts -> other']);
    expect([...r.diagnostics].sort()).toEqual([
      expect.stringMatching(/^c\/package\.json: /),
      'workspace package "dup" is declared in a and b',
    ]);
  });

  it('tsconfig paths win over a workspace package of the same name', async () => {
    const r = await resolve({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/utils/package.json': json({ name: '@acme/utils', main: 'index.ts' }),
      'packages/utils/index.ts': 'export function fmt(): string {\n  return "ws";\n}\n',
      'tsconfig.json': json({ compilerOptions: { paths: { '@acme/utils': ['./shim.ts'] } } }),
      'shim.ts': FMT,
      'main.ts': app('@acme/utils'),
    });
    expect(r.strong).toContain('main.ts::main -calls-> shim.ts::fmt');
  });
});

describe('Python roots', () => {
  const HELPER = 'def helper():\n    return 1\n';
  const TEST = (mod: string): string =>
    `from ${mod} import helper\n\ndef test_it():\n    helper()\n`;

  it('src layout without config', async () => {
    const r = await resolve({
      'src/mypkg/__init__.py': '',
      'src/mypkg/core.py': HELPER,
      'tests/test_core.py': TEST('mypkg.core'),
      'scripts/run.py': 'import mypkg.core\n',
    });
    expect(r.strong).toContain('tests/test_core.py::test_it -calls-> src/mypkg/core.py::helper');
    expect(r.strong).toContain('scripts/run.py::<module> -imports-> src/mypkg/core.py::<module>');
  });

  it.each([
    [
      'setup.cfg package_dir',
      'setup.cfg',
      '[options]\npackage_dir =\n    = lib\npackages = find:\n',
    ],
    ['setup.cfg find where', 'setup.cfg', '[options.packages.find]\nwhere = lib\n'],
    [
      'pyproject setuptools where',
      'pyproject.toml',
      '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
    ],
    ['pyproject package-dir', 'pyproject.toml', '[tool.setuptools.package-dir]\n"" = "lib"\n'],
    [
      'poetry from',
      'pyproject.toml',
      '[tool.poetry]\npackages = [{ include = "nspkg", from = "lib" }]\n',
    ],
  ])('configured package dir (%s), namespace package without __init__', async (_, name, text) => {
    const r = await resolve({
      [name]: text,
      'lib/nspkg/core.py': HELPER,
      'tests/test_core.py': TEST('nspkg.core'),
    });
    expect(r.strong).toContain('tests/test_core.py::test_it -calls-> lib/nspkg/core.py::helper');
  });

  it('a nested project with its own src/ and a uniquely discovered package root', async () => {
    const r = await resolve({
      'services/api/pyproject.toml': '[project]\nname = "api"\n',
      'services/api/src/api/__init__.py': '',
      'services/api/src/api/core.py': HELPER,
      'libs/shared/sharedpkg/__init__.py': 'def helper():\n    return 2\n',
      'tools/check.py':
        'from api.core import helper\nfrom sharedpkg import helper as h2\n\ndef run():\n    helper()\n    h2()\n',
    });
    expect(r.strong).toContain('tools/check.py::run -calls-> services/api/src/api/core.py::helper');
    expect(r.strong).toContain(
      'tools/check.py::run -calls-> libs/shared/sharedpkg/__init__.py::helper',
    );
  });

  it('an ambiguous discovered package stays weak; existing roots still win', async () => {
    const r = await resolve({
      'one/dup/__init__.py': HELPER,
      'two/dup/__init__.py': HELPER,
      'tools/check.py': 'from dup import helper\n',
      'pkg/__init__.py': '',
      'pkg/mod.py': HELPER,
      'src/pkg/mod.py': 'def other():\n    pass\n',
      'pkg/use.py': TEST('pkg.mod'),
    });
    expect(r.weakImports).toEqual(['tools/check.py -> dup']);
    expect(r.strong).toContain('pkg/use.py::test_it -calls-> pkg/mod.py::helper');
  });
});

describe('read-only and bounded', () => {
  it('indexing leaves the repo untouched', async () => {
    const files = {
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/u/package.json': json({ name: 'u', main: 'index.ts' }),
      'packages/u/index.ts': FOO,
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": "." }, }',
      'main.ts': USE('u'),
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["src"]\n',
    };
    const r = await resolve(files);
    const snapshot = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
    for (const [rel, text] of Object.entries(files))
      expect(readFileSync(join(r.root, rel), 'utf8')).toBe(text);
    const dirsOf = Object.keys(files).flatMap((f) => (f.includes('/') ? [dirname(f)] : []));
    expect(snapshot(r.root)).toEqual(
      [...new Set([...Object.keys(files), ...dirsOf, 'packages'])].sort(),
    );
  });
});
