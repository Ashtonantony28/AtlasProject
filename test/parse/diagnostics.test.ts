import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../../src/core/parse/index.js';
import { MAX_SYNTAX_DIAGNOSTICS } from '../../src/core/parse/refs.js';
import { parseTsLike } from '../../src/core/parse/ts.js';
import { parsePython } from '../../src/core/parse/py.js';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { runCli } from '../cli/helpers.js';

type Lang = 'typescript' | 'javascript' | 'python';

const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const names = (r: { symbols: { name: string }[] }): string[] => r.symbols.map((s) => s.name);

describe('parse diagnostics', () => {
  it.each([
    ['typescript', 'g.ts', '}}}} ))) class { @@@\nexport function ok(): void {}\n'],
    ['javascript', 'g.js', '@@@ }}} ;;\nfunction ok() {}\n'],
    ['python', 'g.py', 'def (:\n    return ]\n\ndef ok():\n    pass\n'],
  ] as const)(
    'reports syntax errors in garbage %s and keeps good symbols',
    async (lang, file, src) => {
      const r = await parseSource(src, lang, file);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      for (const d of r.diagnostics) {
        expect(d.severity).toBe('error');
        expect(d.line).toBeGreaterThanOrEqual(1);
        expect(d.message).toMatch(/syntax error|missing/);
      }
      expect(names(r)).toContain('ok');
    },
  );

  it('reports a MISSING token with its line', async () => {
    const r = await parseSource('const a = 1;\nconst b = foo(1, 2;\n', 'typescript', 'm.ts');
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.line === 2)).toBe(true);
  });

  it.each([
    [
      'typescript',
      'c.ts',
      'import { x } from "./x";\nexport class A extends B { m(): number { return x(); } }\n',
    ],
    [
      'javascript',
      'c.js',
      'const { x } = require("./x");\nmodule.exports = { f() { return x(); } };\n',
    ],
    ['python', 'c.py', 'from x import y\n\nclass A(B):\n    def m(self):\n        return y()\n'],
  ] as const)('is empty for clean %s', async (lang, file, src) => {
    const r = await parseSource(src, lang, file);
    expect(r.diagnostics).toEqual([]);
    expect(r.symbols.length).toBeGreaterThan(0);
  });

  it('is empty for empty input', async () => {
    expect((await parseSource('', 'typescript', 'e.ts')).diagnostics).toEqual([]);
    expect((await parseSource('', 'python', 'e.py')).diagnostics).toEqual([]);
  });

  it('caps syntax errors and says how many were left out', async () => {
    const src = Array.from({ length: 50 }, (_, i) => `f(${i};`).join('\n');
    const r = await parseSource(src, 'javascript', 'many.js');
    expect(r.diagnostics).toHaveLength(MAX_SYNTAX_DIAGNOSTICS + 1);
    expect(r.diagnostics[0]).toEqual({ line: 1, message: 'missing ")"', severity: 'error' });
    expect(r.diagnostics[MAX_SYNTAX_DIAGNOSTICS]).toMatchObject({
      severity: 'warning',
      message: `${50 - MAX_SYNTAX_DIAGNOSTICS} more syntax errors not reported`,
    });
  });

  it('never throws on binary-ish input', async () => {
    const src = Array.from({ length: 4096 }, (_, i) =>
      String.fromCharCode((i * 7919) % 0xd7ff),
    ).join('');
    for (const lang of ['typescript', 'javascript', 'python'] as const) {
      const r = await parseSource(src, lang, `bin.${lang}`);
      expect(Array.isArray(r.diagnostics)).toBe(true);
    }
  });
});

describe('last-resort failure handling', () => {
  // The walk (the root's second read of `namedChildren`; the first collects export names) meets a
  // child that throws on access, standing in for any unexpected walker bug.
  function poisoned(grammar: unknown, src: string): Parser.SyntaxNode {
    const p = new Parser();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.setLanguage(grammar as any);
    const root = p.parse(src).rootNode;
    const bomb = {
      get type(): string {
        throw new Error('bomb');
      },
    } as unknown as Parser.SyntaxNode;
    const real = root.namedChildren;
    const children = [real[0], bomb, ...real.slice(1)];
    let reads = 0;
    return new Proxy(root, {
      get: (t, k) =>
        k === 'namedChildren' ? (++reads === 1 ? real : children) : Reflect.get(t, k),
    });
  }

  it('returns partial TS/JS results and an error diagnostic instead of throwing', () => {
    const r = parseTsLike(poisoned(JavaScript, 'function a() {}\nfunction b() {}\n'), 'javascript');
    expect(names(r)).toEqual(['a']);
    expect(r.diagnostics).toEqual([
      { line: 1, message: expect.stringContaining('internal parser failure'), severity: 'error' },
    ]);
    expect(r.diagnostics[0]?.message).toContain('bomb');
  });

  it('returns partial Python results and an error diagnostic instead of throwing', () => {
    const r = parsePython(poisoned(Python, 'def a():\n    pass\ndef b():\n    pass\n'));
    expect(names(r)).toEqual(['a']);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error' });
  });
});

describe('deep expressions do not overflow the stack', () => {
  const N = 20_000;
  const cases: [Lang, string, string][] = [
    [
      'typescript',
      'deep.ts',
      `console.log(${'"a" + '.repeat(N)}"b");\nexport function after(): void {}\n`,
    ],
    [
      'typescript',
      'deepm.ts',
      `export const t = ${'a.'.repeat(N)}b;\nexport function after(): void {}\n`,
    ],
    [
      'javascript',
      'deep.js',
      `x = ${'('.repeat(N)}1${')'.repeat(N)};\nfunction after() { return 1; }\n`,
    ],
    ['javascript', 'deepa.js', `module.exports = ${'a = '.repeat(N)}1;\nfunction after() {}\n`],
    ['python', 'deep.py', `print(${'"a" + '.repeat(N)}"b")\ndef after():\n    pass\n`],
    ['python', 'deepa.py', `x = ${'a = '.repeat(N)}1\ndef after():\n    pass\n`],
    ['python', 'deepm.py', `t = ${'a.'.repeat(N)}b\ndef after():\n    pass\n`],
  ];
  it.each(cases)(
    '%s %s: symbols after the expression are found',
    async (lang, file, src) => {
      const r = await parseSource(src, lang, file);
      expect(names(r)).toContain('after');
      expect(r.diagnostics.filter((d) => d.message.includes('internal'))).toEqual([]);
    },
    30_000,
  );

  it('a call inside a deeply nested class scope keeps its owner', async () => {
    const src = `class A {\n  m(): void { helper(${'1 + '.repeat(N)}1); }\n}\nexport function after(): void {}\n`;
    const r = await parseSource(src, 'typescript', 'nest.ts');
    expect(names(r)).toEqual(['A', 'm', 'after']);
    expect(r.references).toContainEqual(
      expect.objectContaining({ fromQualifiedName: 'A.m', name: 'helper', kind: 'calls' }),
    );
  }, 30_000);
});

describe('walk order is unchanged by the iterative walker', () => {
  it('keeps source order across sibling object scopes and declarators', async () => {
    const src = [
      'export const a = { x() {}, y: () => 1 }, b = 2, c = { z() {} };',
      'export class K { p(): void {} q(): void {} }',
      'module.exports.o = { w() {} };',
      'export function last(): void {}',
    ].join('\n');
    const r = await parseSource(src, 'typescript', 'order.ts');
    expect(r.symbols.map((s) => s.qualifiedName)).toEqual([
      'a',
      'a.x',
      'a.y',
      'b',
      'c',
      'c.z',
      'K',
      'K.p',
      'K.q',
      'o.w',
      'last',
    ]);
  });

  it('keeps nested Python class scopes and owners', async () => {
    const src =
      'class A:\n    class B:\n        def m(self):\n            f()\n    def n(self):\n        g()\nx = y = h()\n';
    const r = await parseSource(src, 'python', 'order.py');
    expect(r.symbols.map((s) => s.qualifiedName)).toEqual(['A', 'A.B', 'A.B.m', 'A.n', 'x', 'y']);
    const from = Object.fromEntries(r.references.map((ref) => [ref.name, ref.fromQualifiedName]));
    expect(from).toEqual({ f: 'A.B.m', g: 'A.n', h: 'y' });
  });
});

describe('index surfaces diagnostics', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-diag-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'ok.ts'), 'export function ok(): void {}\n');
    writeFileSync(join(dir, 'bad.ts'), '}}}} ))) class { @@@\nexport function fine(): void {}\n');
    writeFileSync(join(dir, 'bad.py'), 'def (:\n\ndef good():\n    pass\n');
    return dir;
  }

  it('counts files with diagnostics and still indexes them', async () => {
    const dir = repo();
    const db = openDatabase(join(dir, 'index.db'));
    try {
      const seen: string[] = [];
      const st = await indexRepo(db, dir, {
        skipEmbeddings: true,
        onFile: (e) => {
          if (e.reason) seen.push(`${e.path}: ${e.reason}`);
        },
      });
      expect(st.filesIndexed).toBe(3);
      expect(st.filesFailed).toBe(0);
      expect(st.filesWithDiagnostics).toBe(2);
      expect(seen.sort()).toEqual([
        expect.stringMatching(/^bad\.py: \d+ parse diagnostics?$/),
        expect.stringMatching(/^bad\.ts: \d+ parse diagnostics?$/),
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('prints the count in `atlas index`', async () => {
    const dir = repo();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    await runCli(['index', dir]);
    expect(out.join('')).toContain('2 files with parse diagnostics');
  });
});
