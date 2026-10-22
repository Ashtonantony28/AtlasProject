import { describe, expect, it } from 'vitest';
import { parseSource } from '../../src/core/parse/index.js';
import type { LanguageId } from '../../src/core/ingest/language.js';
import type { ParsedSymbol, ParseResult } from '../../src/core/parse/index.js';

// SG26 (A9-02, A9-07, A9-11, A9-12): callback bodies are local scopes, module wrappers are not;
// chained aliases, `as const`/`satisfies` members and CommonJS/ambient export flags.

const parse = (src: string, lang: LanguageId = 'javascript'): Promise<ParseResult> =>
  parseSource(src, lang, lang === 'python' ? 'm.py' : lang === 'typescript' ? 'm.ts' : 'm.js');
const qnames = (r: ParseResult): string[] => r.symbols.map((s) => s.qualifiedName ?? s.name);
const sym = (r: ParseResult, q: string): ParsedSymbol | undefined =>
  r.symbols.find((s) => (s.qualifiedName ?? s.name) === q);
const exported = (r: ParseResult): string[] =>
  r.symbols.filter((s) => s.exported).map((s) => s.qualifiedName ?? s.name);

describe('callback bodies are local scopes (A9-02)', () => {
  it('declarations in call arguments at module level are not symbols; their calls are the module’s', async () => {
    const r = await parse(
      "app.get('/', function (req, res) {\n  var x = make();\n  function helper() { run(); }\n  class K {}\n});\n" +
        'describe(() => { const y = 1; it(() => { let z = 2; }); });\n' +
        'promise.then((r) => { const v = r; });\n' +
        'new Promise(function (resolve) { var w = resolve; });\n' +
        'x = function () { var q = 1; };\n' +
        'defineGetter(req, "protocol", function protocol() { var proto = 1; });\n',
    );
    expect(qnames(r)).toEqual([]);
    const calls = r.references.filter((x) => x.kind === 'calls');
    expect(calls.map((c) => `${c.fromQualifiedName}:${c.name}`)).toEqual(
      expect.arrayContaining(['null:get', 'null:make', 'null:run', 'null:it', 'null:then']),
    );
  });

  it('IIFE, `.call(this)` and `!function(){}()` bodies are module scope', async () => {
    const r = await parse(
      '(function () { var a = 1; function f() {} })();\n' +
        '(function () { var b = 2; }).call(this);\n' +
        '!function () { var c = 3; }();\n' +
        '(() => { const d = 4; })();\n',
    );
    expect(qnames(r)).toEqual(['a', 'f', 'b', 'c', 'd']);
  });

  it('UMD factories and AMD `define` callbacks are module scope', async () => {
    const r = await parse(
      '(function (root, factory) {\n  var umd = 1;\n  if (typeof define === "function") define([], factory);\n  else root.Lib = factory();\n})(this, function () {\n  var Lib = {};\n  Lib.go = function go() {};\n  return Lib;\n});\n' +
        "define(['dep'], function (dep) { var amd = dep; function amdFn() {} });\n" +
        'define(function (require, exports, module) { exports.sugar = function () {}; });\n' +
        "(function (g, f) { f(g); }(this, (function (exports) { 'use strict'; var rolled = 1; })));\n",
    );
    expect(qnames(r)).toEqual(['umd', 'Lib', 'Lib.go', 'amd', 'amdFn', 'sugar', 'rolled']);
  });

  it('only the last argument of `define` and only bare `define` are wrappers', async () => {
    const r = await parse(
      'define(function () { var notLast = 1; }, function () { var last = 2; });\n' +
        'obj.define(function () { var member = 3; });\n',
    );
    expect(qnames(r)).toEqual(['last']);
  });

  it('`defineGetter(obj, "name", fn)` and `Object.defineProperty` getters define `obj.name`', async () => {
    const r = await parse(
      "var req = {};\n/** Protocol. */\ndefineGetter(req, 'protocol', function protocol() {\n  var proto = scheme();\n  return proto;\n});\n" +
        "Object.defineProperty(req, 'ip', { get() { return addr(); }, set(v) {} });\n" +
        "Object.defineProperty(req, 'ips', { enumerable: true, get: function () { var all = 1; return all; } });\n" +
        "Object.defineProperty(req, 'flag', { value: true });\n" +
        "defineGetter(req, 'bad name', function () {});\n" +
        "const fs = require('fs');\nstub(fs, 'readFile', function () {});\n" +
        "stub(unknown, 'x', function () { var u = 1; });\n" +
        "set(req, 'two', function () {}, extra);\n" +
        'module.exports = req;\n',
    );
    expect(qnames(r)).toEqual(['req', 'req.protocol', 'req.ip', 'req.ips', 'fs']);
    expect(sym(r, 'req.protocol')).toMatchObject({
      kind: 'method',
      startLine: 3,
      endLine: 6,
      exported: true,
      docstring: '/** Protocol. */',
    });
    expect(
      r.references
        .filter((x) => x.name === 'scheme' || x.name === 'addr')
        .map((x) => x.fromQualifiedName),
    ).toEqual(['req.protocol', 'req.ip']);
  });

  it('a callback local no longer shadows a top-level name', async () => {
    const r = await parse('function render() {}\napp.get("/", function () { var render = 1; });\n');
    expect(r.symbols.filter((s) => s.name === 'render').map((s) => s.kind)).toEqual(['function']);
  });

  it('assignments inside a callback define nothing', async () => {
    const r = await parse('var o = {};\nsetup(function () { o.m = function () {}; });\n');
    expect(qnames(r)).toEqual(['o']);
  });

  it('never throws on broken callbacks', async () => {
    const r = await parse('app.get("/", function (req, res {\n  var x = ;\n}\n(function ( {');
    expect(r.symbols).toBeDefined();
  });
});

describe('chained method assignments (A9-12)', () => {
  it('every member target of a chain is a symbol of the same kind', async () => {
    const r = await parse(
      'var res = {};\n/** Set type. */\nres.contentType =\nres.type = function contentType(t) { return go(t); };\n' +
        'exports.a = exports.b = function () {};\n' +
        'module.exports = res;\n',
    );
    expect(qnames(r)).toEqual(['res', 'res.type', 'res.contentType', 'b', 'a']);
    expect(sym(r, 'res.contentType')).toMatchObject({
      kind: 'method',
      startLine: 3,
      exported: true,
      docstring: '/** Set type. */',
    });
    expect(sym(r, 'res.type')).toMatchObject({ kind: 'method', startLine: 4, exported: true });
    expect(sym(r, 'res.type')?.docstring).toBe('/** Set type. */');
    // Calls belong to the defined (innermost) name only.
    expect(r.references.filter((x) => x.name === 'go').map((x) => x.fromQualifiedName)).toEqual([
      'res.type',
    ]);
    expect(exported(r)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('a chain ending in `module.exports` is defined once', async () => {
    const r = await parse('exports = module.exports = function main() {};\n');
    expect(qnames(r)).toEqual(['main']);
  });
});

describe('`as const` / `satisfies` objects (A9-07)', () => {
  it('members are qualified, and `export default {…} satisfies X` members sit under default', async () => {
    const r = await parse(
      'export const routes = { home() { return 1; }, about: () => 2 } as const;\n' +
        'const both = { m() {} } as const satisfies Record<string, unknown>;\n' +
        'export default { async fetch(req: Request) { return req; } } satisfies Handler;\n',
      'typescript',
    );
    expect(qnames(r)).toEqual([
      'routes',
      'routes.home',
      'routes.about',
      'both',
      'both.m',
      'default.fetch',
    ]);
    expect(sym(r, 'default.fetch')?.exported).toBe(true);
    expect(sym(r, 'routes.home')?.exported).toBe(true);
  });
});

describe('CommonJS and ambient export flags (A9-11)', () => {
  it('`var app = exports = module.exports = {}` exports app and its members', async () => {
    const r = await parse(
      'var app = exports = module.exports = {};\napp.use = function use() {};\napp.init = function () {};\n',
    );
    expect(exported(r)).toEqual(['app', 'app.use', 'app.init']);
    expect(r.imports).toContainEqual({
      module: '',
      imported: 'app',
      alias: 'default',
      line: 1,
      reexport: true,
    });
  });

  it('members of an object assigned through a declarator chain are scoped', async () => {
    const r = await parse('var api = module.exports = { get() {}, put: function () {} };\n');
    expect(qnames(r)).toEqual(['api', 'api.get', 'api.put']);
    expect(exported(r)).toEqual(['api', 'api.get', 'api.put']);
  });

  it('`var x = exports.y = …` exports both names', async () => {
    const r = await parse('var x = exports.y = 1;\nvar plain = other.y = 2;\n');
    expect(exported(r)).toEqual(['x']);
  });

  it('`export declare` functions, classes and constants are exported', async () => {
    const r = await parse(
      'export declare function f(): void;\nexport declare class C { m(): void }\nexport declare const k: number;\ndeclare function hidden(): void;\n' +
        'export declare namespace N { export declare function g(): void; function h(): void }\n',
      'typescript',
    );
    expect(exported(r)).toEqual(['f', 'C', 'C.m', 'k', 'N', 'N.g']);
  });

  it('Python `__all__ +=` extends the literal export list', async () => {
    const r = await parse(
      '__all__ = ["a"]\n__all__ += ["b"]\n\ndef a(): pass\ndef b(): pass\ndef c(): pass\n',
      'python',
    );
    expect(exported(r)).toEqual(['a', 'b']);
  });

  it('Python `__all__ +=` of a non-literal, or before any `=`, falls back to the convention', async () => {
    const dyn = await parse(
      '__all__ = ["a"]\n__all__ += other.__all__\n\ndef a(): pass\ndef c(): pass\ndef _p(): pass\n',
      'python',
    );
    expect(exported(dyn)).toEqual(['a', 'c']);
    const first = await parse('__all__ += ["a"]\n\ndef a(): pass\ndef c(): pass\n', 'python');
    expect(exported(first)).toEqual(['a', 'c']);
    const other = await parse('__all__ = ["a"]\n__all__ -= ["a"]\n\ndef a(): pass\n', 'python');
    expect(exported(other)).toEqual(['a']);
  });
});
