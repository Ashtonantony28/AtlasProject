import { describe, expect, it } from 'vitest';
import { parseSource } from '../../src/core/parse/index.js';
import type { LanguageId } from '../../src/core/ingest/language.js';
import type { ParsedSymbol, ParseResult } from '../../src/core/parse/index.js';

// SG18 (A5-01, A5-04, A5-05, A5-06): property-assigned and anonymous functions, namespaces,
// and functions used as values.

const sym = (r: ParseResult, q: string): ParsedSymbol | undefined =>
  r.symbols.find((s) => (s.qualifiedName ?? s.name) === q);
const qnames = (r: ParseResult): string[] => r.symbols.map((s) => s.qualifiedName ?? s.name);
const values = (r: ParseResult): string[] =>
  r.references
    .filter((x) => x.kind === 'references')
    .map((x) => {
      const target =
        x.receiver === 'none'
          ? x.name
          : `${x.receiver === 'member' ? x.object : x.receiver}.${x.name}`;
      return `${x.fromQualifiedName ?? '<module>'} -> ${target}`;
    });

describe('property-assigned functions (A5-01)', () => {
  const EXPRESS = `var res = {};

/** Send a body. */
res.send = function send(body) {
  var chunk = body;
  function inner() {}
  return this.json(chunk);
};

res.json = (obj) => obj;

module.exports = res;
`;

  it('`obj.m = function` is a method with span, signature, docstring and export flag', async () => {
    const r = await parseSource(EXPRESS, 'javascript');
    expect(sym(r, 'res.send')).toEqual({
      kind: 'method',
      name: 'send',
      signature: 'res.send = function send(body) {',
      startLine: 4,
      endLine: 8,
      docstring: '/** Send a body. */',
      qualifiedName: 'res.send',
      exported: true,
    });
    expect(sym(r, 'res.json')).toMatchObject({ kind: 'method', startLine: 10, endLine: 10 });
    expect(r.references).toContainEqual(
      expect.objectContaining({ fromQualifiedName: 'res.send', name: 'json', receiver: 'this' }),
    );
  });

  it('keeps the locals of assigned functions out of module scope', async () => {
    const r = await parseSource(EXPRESS, 'javascript');
    expect(qnames(r).sort()).toEqual(['res', 'res.json', 'res.send']);
  });

  it('an object that is not exported gives unexported methods', async () => {
    const r = await parseSource('const o = {};\no.m = function () {};\n', 'javascript');
    expect(sym(r, 'o.m')).toMatchObject({ kind: 'method', exported: false });
  });

  it('`exports.x =` and `module.exports.x =` anonymous functions are exported functions', async () => {
    const r = await parseSource(
      'exports.list = function (req, res) {\n  var page = 1;\n  res.render(page);\n};\n' +
        'module.exports.view = async (req) => {\n  const id = req.id;\n};\n',
      'javascript',
    );
    expect(r.symbols).toEqual([
      expect.objectContaining({
        kind: 'function',
        name: 'list',
        qualifiedName: 'list',
        signature: 'exports.list = function (req, res) {',
        startLine: 1,
        endLine: 4,
        exported: true,
      }),
      expect.objectContaining({
        kind: 'function',
        qualifiedName: 'view',
        startLine: 5,
        exported: true,
      }),
    ]);
    expect(r.references).toContainEqual(
      expect.objectContaining({ fromQualifiedName: 'list', name: 'render', kind: 'calls' }),
    );
  });

  it('`C.prototype.m =` and `C.prototype = { … }` qualify methods by the constructor', async () => {
    const r = await parseSource(
      'function Store() {}\n' +
        'Store.prototype.get = function (k) { return this.has(k); };\n' +
        'Store.prototype = {\n  has(k) { return !!k; },\n  size: function () { return 0; },\n};\n' +
        'Store.create = function () { return new Store(); };\n' +
        'module.exports = Store;\n',
      'javascript',
    );
    expect(qnames(r)).toEqual(['Store', 'Store.get', 'Store.has', 'Store.size', 'Store.create']);
    expect(r.symbols.filter((s) => s.kind === 'method')).toHaveLength(4);
    expect(r.symbols.every((s) => s.exported)).toBe(true);
  });

  it('TS: works the same and follows `export const`', async () => {
    const r = await parseSource(
      'export const api: Record<string, unknown> = {};\napi.get = function get(): number {\n  const x = 1;\n  return x;\n};\n',
      'typescript',
    );
    expect(qnames(r)).toEqual(['api', 'api.get']);
    expect(sym(r, 'api.get')).toMatchObject({ kind: 'method', exported: true, endLine: 5 });
  });

  it('`exports.X = class` is a class with qualified members', async () => {
    const r = await parseSource(
      'exports.Model = class extends Base {\n  save() {\n    return 1;\n  }\n};\n',
      'javascript',
    );
    expect(qnames(r)).toEqual(['Model', 'Model.save']);
    expect(r.references).toContainEqual(
      expect.objectContaining({ fromQualifiedName: 'Model', name: 'Base', kind: 'extends' }),
    );
  });

  it('assignments inside a callback are not symbols; inside an IIFE they are', async () => {
    const r = await parseSource(
      "app.get('/', function (req, res) {\n  res.locals.f = function () {};\n});\n" +
        '(function () {\n  lib.a = function () {};\n})();\n' +
        '(function () {\n  lib.b = function () {};\n}).call(this);\n',
      'javascript',
    );
    expect(qnames(r)).toEqual(['lib.a', 'lib.b']);
  });

  it('ignores computed, `this` and non-function assignments', async () => {
    const r = await parseSource(
      "o['x'] = function () {};\nthis.y = function () {};\no.z = 1;\nexports.n = 2;\n",
      'javascript',
    );
    expect(r.symbols).toEqual([]);
  });
});

describe('anonymous default exports (A5-06)', () => {
  it.each([
    ['typescript', 'export default function () {\n  util();\n}\n', 'function'],
    ['javascript', 'export default async () => {\n  util();\n};\n', 'function'],
    ['javascript', 'export default function* () {\n  util();\n}\n', 'function'],
    ['javascript', 'module.exports = function () {\n  util();\n};\n', 'function'],
  ] as Array<[LanguageId, string, string]>)('%s %j is a `default` %s', async (lang, src, kind) => {
    const r = await parseSource(src, lang);
    expect(r.symbols).toEqual([
      expect.objectContaining({ kind, name: 'default', startLine: 1, endLine: 3, exported: true }),
    ]);
    expect(r.references).toEqual([
      expect.objectContaining({ fromQualifiedName: 'default', name: 'util', kind: 'calls' }),
    ]);
    expect(r.imports).toContainEqual({
      module: '',
      imported: 'default',
      alias: 'default',
      line: 1,
      reexport: true,
    });
  });

  it('`export default class extends Base` keeps heritage and qualifies its members', async () => {
    const r = await parseSource(
      "import { Base } from './base';\n/** A shape. */\nexport default class extends Base {\n  area(): number {\n    return 1;\n  }\n}\n",
      'typescript',
    );
    expect(r.symbols).toEqual([
      {
        kind: 'class',
        name: 'default',
        signature: 'export default class extends Base {',
        startLine: 3,
        endLine: 7,
        docstring: '/** A shape. */',
        qualifiedName: 'default',
        exported: true,
      },
      expect.objectContaining({ kind: 'method', qualifiedName: 'default.area', exported: true }),
    ]);
    expect(r.references).toContainEqual(
      expect.objectContaining({ fromQualifiedName: 'default', name: 'Base', kind: 'extends' }),
    );
  });

  it('named default function expressions keep their name', async () => {
    const r = await parseSource('module.exports = function app() {};\n', 'javascript');
    expect(qnames(r)).toEqual(['app']);
  });
});

describe('TS namespaces (A5-05)', () => {
  it('qualifies members, exports only `export`ed ones and keeps locals out', async () => {
    const r = await parseSource(
      'export namespace Circle {\n' +
        '  export function area(): number {\n    const r = 1;\n    return r;\n  }\n' +
        '  function hidden(): void {}\n' +
        '  export const unit = 1;\n' +
        '  export class Arc {\n    len(): number { return 1; }\n  }\n' +
        '  export namespace Inner {\n    export type T = number;\n  }\n' +
        '}\n' +
        'namespace Local {\n  export function f(): void {}\n}\n',
      'typescript',
    );
    expect(r.symbols.map((s) => `${s.kind} ${s.qualifiedName} ${s.exported}`)).toEqual([
      'variable Circle true',
      'function Circle.area true',
      'function Circle.hidden false',
      'variable Circle.unit true',
      'class Circle.Arc true',
      'method Circle.Arc.len true',
      'variable Circle.Inner true',
      'type Circle.Inner.T true',
      'variable Local false',
      'function Local.f false',
    ]);
    expect(sym(r, 'Circle')).toMatchObject({
      signature: 'namespace Circle {',
      startLine: 1,
      endLine: 14,
    });
  });

  it('`declare module` and `module` bodies are qualified by the module name', async () => {
    const r = await parseSource(
      "declare module 'lib-x' {\n  export function f(): void;\n  interface Opts {}\n}\nmodule M {\n  export const v = 1;\n}\n",
      'typescript',
    );
    expect(qnames(r)).toEqual(['lib-x', 'lib-x.f', 'lib-x.Opts', 'M', 'M.v']);
  });
});

describe('functions used as values (A5-04)', () => {
  it('records callbacks, arrays, object values, shorthands, JSX props, returns and assignments', async () => {
    const r = await parseSource(
      "import { Button } from './ui';\nimport * as users from './users';\n" +
        'function fmt(x: number): string { return String(x); }\n' +
        'export function run(app: App, xs: number[]): unknown {\n' +
        "  app.get('/u', users.list);\n" +
        '  xs.map(fmt);\n' +
        '  const table = [fmt, users.view];\n' +
        '  const h = { handler: fmt, Button };\n' +
        '  let cb;\n  cb = users.edit;\n' +
        '  return fmt;\n' +
        '}\n' +
        'export const el = <Comp component={Button} />;\n' +
        'export const alias = fmt;\n' +
        'module.exports = { run };\n',
      'typescript',
      'a.tsx',
    );
    expect(values(r)).toEqual([
      'run -> users.list',
      'run -> fmt',
      'run -> users.view',
      'run -> Button',
      'run -> users.edit',
      'el -> Button',
      'alias -> fmt',
      'default -> run',
    ]);
  });

  it('drops values bound only locally (parameters, locals, globals)', async () => {
    const r = await parseSource(
      'function f(req, res) {\n  const page = 1;\n  res.render(page, req.query);\n  return console.log;\n}\n',
      'javascript',
    );
    expect(values(r)).toEqual([]);
  });

  it('keeps `this.m` values for the resolver', async () => {
    const r = await parseSource(
      "class C {\n  start() {\n    emitter.on('x', this.onX);\n  }\n  onX() {}\n}\n",
      'typescript',
    );
    expect(values(r)).toEqual(['C.start -> this.onX']);
  });

  it('Python: arguments, keyword arguments, collections, returns and assignments', async () => {
    const r = await parseSource(
      'from .util import helper\nimport pkg.hooks\n\n' +
        'def on_start():\n    pass\n\n' +
        'HOOKS = [on_start, pkg.hooks.later]\n' +
        'TABLE = {"start": on_start}\n' +
        'ALIAS = helper\n\n' +
        'def register(app, local):\n' +
        '    app.add(on_start, callback=helper)\n' +
        '    app.add(local)\n' +
        '    pair = (helper, on_start)\n' +
        '    return on_start\n\n' +
        'class Svc:\n' +
        '    def start(self):\n        bus.on(self.stop)\n' +
        '    def stop(self):\n        pass\n',
      'python',
    );
    expect(values(r)).toEqual([
      'HOOKS -> on_start',
      'HOOKS -> pkg.hooks.later',
      'TABLE -> on_start',
      'ALIAS -> helper',
      'register -> on_start',
      'register -> helper',
      'Svc.start -> this.stop',
    ]);
  });

  it('Python: a star import keeps every value for the resolver', async () => {
    const r = await parseSource('from x import *\n\ndef f():\n    run(job)\n', 'python');
    expect(values(r)).toEqual(['f -> job']);
  });
});

describe('never throws on broken input around these constructs', () => {
  it.each([
    ['javascript', 'obj. = function (\nexports.x = function ( {\nFoo.prototype. = class extends {'],
    ['javascript', 'module.exports = function (\nexport default (\n'],
    [
      'typescript',
      'namespace {\n  export function (\n}\ndeclare module {\nexport default class extends {',
    ],
    ['typescript', 'f(a, , b.);\nconst x = [y, ;\n<X y={} />'],
    ['python', 'f(a, k=, *)\nx = [y, \nreturn'],
  ] as Array<[LanguageId, string]>)('%s %j', async (lang, src) => {
    const r = await parseSource(src, lang);
    expect(r.diagnostics.some((d) => d.message.startsWith('internal parser failure'))).toBe(false);
  });
});
