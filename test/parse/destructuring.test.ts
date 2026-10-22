// SG31 (A13-01): names bound by top-level destructuring declarations and Python tuple/list
// assignment targets are variable symbols.
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
import { parseSource } from '../../src/core/parse/index.js';
import type { LanguageId } from '../../src/core/ingest/language.js';
import type { ParseResult } from '../../src/core/parse/index.js';

const parse = (src: string, lang: LanguageId = 'typescript'): Promise<ParseResult> =>
  parseSource(src, lang, lang === 'python' ? 'm.py' : lang === 'typescript' ? 'm.ts' : 'm.js');
const rows = (r: ParseResult): string[] =>
  r.symbols.map(
    (s) =>
      `${s.kind} ${s.qualifiedName ?? s.name} ${s.startLine}-${s.endLine}${s.exported ? ' exported' : ''}`,
  );

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function strongEdges(files: Record<string, string>): Promise<Set<string>> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sg31-'));
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
    for (const e of getAllEdges(db))
      if (e.weak === 0 && e.dst_symbol !== null)
        strong.add(`${label.get(e.src_symbol!)} -${e.kind}-> ${label.get(e.dst_symbol)}`);
    return strong;
  } finally {
    closeDatabase(db);
  }
}

describe('TS/JS destructuring declarations (A13-01)', () => {
  it('object patterns: shorthand, renames, defaults, nested patterns and rest', async () => {
    const r = await parse('const { a, b: c, d = 1, e: { f, g: [h] }, ...rest } = make();\n');
    expect(rows(r)).toEqual([
      'variable a 1-1',
      'variable c 1-1',
      'variable d 1-1',
      'variable f 1-1',
      'variable h 1-1',
      'variable rest 1-1',
    ]);
  });

  it('array patterns: holes, defaults, nested patterns and rest; spans cover the declarator', async () => {
    const r = await parse(
      'let [i, , j = 2, [k, { l }], ...m] = n,\n  o = 1;\nvar [p] = [\n  1,\n];\n',
      'javascript',
    );
    expect(rows(r)).toEqual([
      'variable i 1-1',
      'variable j 1-1',
      'variable k 1-1',
      'variable l 1-1',
      'variable m 1-1',
      'variable o 2-2',
      'variable p 3-5',
    ]);
  });

  it('exported when the declaration is, by `export const` or a later `export { }`', async () => {
    const r = await parse(
      'export const { auth, handlers: h } = NextAuth({});\nconst [x, y] = pair();\nexport { y };\n',
    );
    expect(rows(r)).toEqual([
      'variable auth 1-1 exported',
      'variable h 1-1 exported',
      'variable x 2-2',
      'variable y 2-2 exported',
    ]);
  });

  it('namespace members are qualified and exported by `export`', async () => {
    const r = await parse('export namespace N {\n  export const { a } = o;\n  const [b] = l;\n}\n');
    expect(rows(r)).toEqual([
      'variable N 1-4 exported',
      'variable N.a 2-2 exported',
      'variable N.b 3-3',
    ]);
  });

  it('initializer calls stay the module’s; defaults are not bound names', async () => {
    const r = await parse('const { a = fallback } = create(build());\n');
    expect(rows(r)).toEqual(['variable a 1-1']);
    const calls = r.references.filter((x) => x.kind === 'calls');
    expect(calls.map((c) => `${c.fromQualifiedName}:${c.name}`).sort()).toEqual([
      'null:build',
      'null:create',
    ]);
  });

  it('destructuring in functions and callbacks stays local', async () => {
    const r = await parse(
      'export function f() { const { a } = g(); const [b] = h(); }\n' +
        'run(() => { const { c } = d; });\n' +
        'const k = () => { const [e] = l; };\n',
      'javascript',
    );
    expect(rows(r)).toEqual(['function f 1-1 exported', 'function k 3-3']);
  });

  it('broken patterns do not throw', async () => {
    const r = await parse('export const { a, b: = c;\nconst [ = ;\nconst { ...{ } } = x;\n');
    expect(Array.isArray(r.symbols)).toBe(true);
    expect(r.diagnostics.every((d) => !/internal/i.test(d.message))).toBe(true);
  });
});

describe('Python tuple/list assignment targets (A13-01)', () => {
  it('pattern lists, parenthesized tuples, lists, splats and nesting', async () => {
    const r = await parse(
      'a, b = f()\n(c, d) = x\n[e, *rest] = y\ng, (h, [i]) = z\nif cond:\n    j, k = 1, 2\n',
      'python',
    );
    expect(rows(r)).toEqual([
      'variable a 1-1 exported',
      'variable b 1-1 exported',
      'variable c 2-2 exported',
      'variable d 2-2 exported',
      'variable e 3-3 exported',
      'variable rest 3-3 exported',
      'variable g 4-4 exported',
      'variable h 4-4 exported',
      'variable i 4-4 exported',
      'variable j 6-6 exported',
      'variable k 6-6 exported',
    ]);
    expect(r.references.filter((x) => x.kind === 'calls').map((c) => c.fromQualifiedName)).toEqual([
      null,
    ]);
  });

  it('honours `__all__` and the underscore convention', async () => {
    const r = await parse('_p, q = f()\n', 'python');
    expect(rows(r)).toEqual(['variable _p 1-1', 'variable q 1-1 exported']);
    const all = await parse('__all__ = ["s"]\ns, t = f()\n', 'python');
    expect(rows(all).filter((x) => !x.includes('__all__'))).toEqual([
      'variable s 2-2 exported',
      'variable t 2-2',
    ]);
  });

  it('targets in functions and classes, attributes and subscripts are no module symbols', async () => {
    const r = await parse(
      'def f():\n    a, b = g()\n\nclass C:\n    def m(self):\n        self.x, y = 1, 2\n\no.p, q[0] = 1, 2\n',
      'python',
    );
    expect(rows(r)).toEqual([
      'function f 1-2 exported',
      'class C 4-6 exported',
      'method C.m 5-6 exported',
    ]);
  });

  it('broken targets do not throw', async () => {
    const r = await parse('a, = \n(b, c = d\n[*] = e\n', 'python');
    expect(Array.isArray(r.symbols)).toBe(true);
    expect(r.diagnostics.every((d) => !/internal/i.test(d.message))).toBe(true);
  });
});

describe('importers of destructured names resolve (A13-01)', () => {
  it('tRPC-style `export const { TRPCProvider, useTRPC } = createTRPCContext()`', async () => {
    const g = await strongEdges({
      'src/trpc/react.tsx':
        "import { createTRPCContext } from '@trpc/tanstack-react-query';\nexport const { TRPCProvider, useTRPC } = createTRPCContext();\n",
      'src/app/page.tsx':
        "import { TRPCProvider, useTRPC } from '../trpc/react';\nexport function Page() { const t = useTRPC(); return <TRPCProvider />; }\n",
      'pkg/conf.py': 'release, version = get_version()\n',
      'pkg/use.py': 'from pkg.conf import release\n\ndef show():\n    return release\n',
    });
    expect([...g]).toEqual(
      expect.arrayContaining([
        'src/app/page.tsx::<module> -imports-> src/trpc/react.tsx::TRPCProvider',
        'src/app/page.tsx::<module> -imports-> src/trpc/react.tsx::useTRPC',
        'src/app/page.tsx::Page -calls-> src/trpc/react.tsx::useTRPC',
        'src/app/page.tsx::Page -calls-> src/trpc/react.tsx::TRPCProvider',
        'pkg/use.py::<module> -imports-> pkg/conf.py::release',
      ]),
    );
  });
});
