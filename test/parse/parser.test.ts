import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from '../../src/core/parse/index.js';
import type { ParsedSymbol } from '../../src/core/parse/index.js';
import { closeDatabase, getAllSymbols, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'sample');

function byQName(symbols: ParsedSymbol[]): Map<string, ParsedSymbol> {
  return new Map(symbols.map((s) => [s.qualifiedName ?? s.name, s]));
}

describe('TypeScript parser', () => {
  it('extracts top-level functions with docstrings', async () => {
    const src = `
/** add two numbers */
export function add(a: number, b: number): number {
  return a + b;
}

const x = 1;
`;
    const result = await parseSource(src, 'typescript');
    const add = result.symbols.find((s) => s.name === 'add');
    expect(add).toBeDefined();
    expect(add?.kind).toBe('function');
    expect(add?.docstring).toContain('add two numbers');
    const x = result.symbols.find((s) => s.name === 'x');
    expect(x?.kind).toBe('variable');
  });

  it('extracts classes, methods, and class qualifier', async () => {
    const src = `
class Foo {
  constructor(public bar: number) {}
  greet(): string { return "hi"; }
}
`;
    const result = await parseSource(src, 'typescript');
    const cls = result.symbols.find((s) => s.kind === 'class');
    expect(cls?.name).toBe('Foo');
    const greet = result.symbols.find((s) => s.name === 'greet');
    expect(greet?.kind).toBe('method');
    expect(greet?.qualifiedName).toBe('Foo.greet');
  });

  it('extracts named and namespace imports', async () => {
    const src = `
import { Foo, Bar as Baz } from './lib.js';
import * as X from './ns.js';
import Y from './default.js';
`;
    const result = await parseSource(src, 'typescript');
    const lib = result.imports.filter((i) => i.module === './lib.js');
    expect(lib).toHaveLength(2);
    const baz = lib.find((i) => i.imported === 'Bar');
    expect(baz?.alias).toBe('Baz');
    const star = result.imports.find((i) => i.module === './ns.js');
    expect(star?.imported).toBe('*');
    expect(star?.alias).toBe('X');
    const def = result.imports.find((i) => i.module === './default.js');
    expect(def?.imported).toBe('default');
  });

  it('does not emit local variables inside function bodies', async () => {
    const src = `
function outer() {
  const local = 1;
  let other = 2;
  return local + other;
}
`;
    const result = await parseSource(src, 'typescript');
    expect(result.symbols.find((s) => s.name === 'local')).toBeUndefined();
    expect(result.symbols.find((s) => s.name === 'other')).toBeUndefined();
    expect(result.symbols.find((s) => s.name === 'outer')?.kind).toBe('function');
  });

  it('extracts CommonJS require() imports', async () => {
    const src = `
const express = require('express');
const { Router, json } = require('express');
const renamed = require('foo').bar;
const { x: y } = require('baz');
`;
    const result = await parseSource(src, 'javascript');
    const def = result.imports.find((i) => i.module === 'express' && i.alias === 'express');
    expect(def?.imported).toBe('default');
    const router = result.imports.find((i) => i.module === 'express' && i.imported === 'Router');
    expect(router).toBeDefined();
    const renamed = result.imports.find((i) => i.module === 'foo' && i.alias === 'renamed');
    expect(renamed?.imported).toBe('bar');
    const aliased = result.imports.find((i) => i.module === 'baz' && i.imported === 'x');
    expect(aliased?.alias).toBe('y');
  });

  it('extracts interfaces and type aliases', async () => {
    const src = `
export interface Drawable { area(): number; }
export type Pair = [number, number];
`;
    const result = await parseSource(src, 'typescript');
    expect(result.symbols.find((s) => s.name === 'Drawable')?.kind).toBe('interface');
    expect(result.symbols.find((s) => s.name === 'Pair')?.kind).toBe('type');
  });
});

describe('Python parser', () => {
  it('extracts functions, classes, methods and docstrings', async () => {
    const src = `
"""Module docstring."""

def greet(name: str) -> str:
    """Say hi."""
    return f"Hello {name}"

class Counter:
    """A counter."""

    def __init__(self, start: int = 0) -> None:
        self.value = start

    def increment(self, by: int = 1) -> int:
        self.value += by
        return self.value
`;
    const result = await parseSource(src, 'python');
    const greet = result.symbols.find((s) => s.name === 'greet');
    expect(greet?.kind).toBe('function');
    expect(greet?.docstring).toBe('Say hi.');

    const cls = result.symbols.find((s) => s.kind === 'class');
    expect(cls?.name).toBe('Counter');
    expect(cls?.docstring).toBe('A counter.');

    const inc = result.symbols.find((s) => s.name === 'increment');
    expect(inc?.kind).toBe('method');
    expect(inc?.qualifiedName).toBe('Counter.increment');
  });

  it('extracts import_from and aliased imports', async () => {
    const src = `
import os
import json as j
from typing import List, Dict as D
from . import sibling
`;
    const result = await parseSource(src, 'python');
    expect(result.imports.find((i) => i.module === 'os')).toBeDefined();
    const aliased = result.imports.find((i) => i.module === 'json');
    expect(aliased?.alias).toBe('j');
    const typingD = result.imports.find((i) => i.module === 'typing' && i.alias === 'D');
    expect(typingD?.imported).toBe('Dict');
  });
});

describe('TSX / JSX', () => {
  it('parses .tsx with the tsx grammar', async () => {
    const src = `
export const App = () => <a href="/x">it's {1}</a>;
export function List() {
  return (
    <ul>
      {items.map((i) => <li key={i}>{i}'s</li>)}
    </ul>
  );
}
export function After() {}
`;
    const result = await parseSource(src, 'typescript', 'App.tsx');
    expect(result.language).toBe('typescript');
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('App');
    expect(names).toContain('List');
    expect(names).toContain('After');
  });

  it('keeps plain .ts generics/casts working', async () => {
    const src = `const n = <number>foo; export function After() {}`;
    const result = await parseSource(src, 'typescript', 'a.ts');
    expect(result.symbols.map((s) => s.name)).toContain('After');
  });

  it('parses .jsx', async () => {
    const src = `export const App = () => <a href="/x">it's {1}</a>;\nexport function After() {}\n`;
    const result = await parseSource(src, 'javascript', 'App.jsx');
    expect(result.symbols.map((s) => s.name)).toContain('After');
  });
});

describe('member qualification', () => {
  it('qualifies interface members and does not emit them top-level', async () => {
    const src = `
export interface Drawable { area(): number; onDraw: () => void; size: number }
export type Shape = { perimeter(): number };
`;
    const result = await parseSource(src, 'typescript');
    const q = byQName(result.symbols);
    expect(q.get('Drawable.area')?.kind).toBe('method');
    expect(q.get('Drawable.onDraw')?.kind).toBe('method');
    expect(q.get('Shape.perimeter')?.kind).toBe('method');
    expect(result.symbols.filter((s) => s.qualifiedName === 'area')).toHaveLength(0);
    expect(result.symbols.filter((s) => s.qualifiedName === 'perimeter')).toHaveLength(0);
  });

  it('qualifies methods of object literals assigned to top-level consts', async () => {
    const src = `
export const Obj = {
  method() { return 1; },
  arrow: () => 2,
  value: 3,
};
`;
    const result = await parseSource(src, 'typescript');
    const q = byQName(result.symbols);
    expect(q.get('Obj')?.kind).toBe('variable');
    expect(q.get('Obj.method')?.kind).toBe('method');
    expect(q.get('Obj.arrow')?.kind).toBe('method');
    expect(q.has('Obj.value')).toBe(false);
    expect(q.has('method')).toBe(false);
  });

  it('turns class-field arrow functions into methods', async () => {
    const src = `
export class Widget {
  handle = () => {};
  legacy = function () {};
  count = 0;
}
`;
    const ts = byQName((await parseSource(src, 'typescript')).symbols);
    expect(ts.get('Widget.handle')?.kind).toBe('method');
    expect(ts.get('Widget.legacy')?.kind).toBe('method');
    expect(ts.has('Widget.count')).toBe(false);
    const js = byQName((await parseSource(src, 'javascript')).symbols);
    expect(js.get('Widget.handle')?.kind).toBe('method');
  });
});

describe('exported flag', () => {
  it('TS: export statements, export clauses and class member visibility', async () => {
    const src = `
export function a() {}
function b() {}
function c() {}
const d = 1;
export const e = 2;
export default class Main {
  pub() {}
  private priv() {}
  protected prot() {}
  #hidden() {}
  field = () => {};
  private pfield = () => {};
}
class Internal { m() {} }
export { b, c as cee };
export { d } from './elsewhere';
export interface Iface { m(): void }
`;
    const q = byQName((await parseSource(src, 'typescript')).symbols);
    expect(q.get('a')?.exported).toBe(true);
    expect(q.get('b')?.exported).toBe(true);
    expect(q.get('c')?.exported).toBe(true);
    expect(q.get('d')?.exported).toBe(false);
    expect(q.get('e')?.exported).toBe(true);
    expect(q.get('Main')?.exported).toBe(true);
    expect(q.get('Main.pub')?.exported).toBe(true);
    expect(q.get('Main.priv')?.exported).toBe(false);
    expect(q.get('Main.prot')?.exported).toBe(false);
    expect(q.get('Main.#hidden')?.exported).toBe(false);
    expect(q.get('Main.field')?.exported).toBe(true);
    expect(q.get('Main.pfield')?.exported).toBe(false);
    expect(q.get('Internal')?.exported).toBe(false);
    expect(q.get('Internal.m')?.exported).toBe(false);
    expect(q.get('Iface.m')?.exported).toBe(true);
  });

  it('TS: export default <identifier>', async () => {
    const q = byQName(
      (await parseSource('class Foo {}\nexport default Foo;\n', 'typescript')).symbols,
    );
    expect(q.get('Foo')?.exported).toBe(true);
  });

  it('JS: CommonJS module.exports / exports.name', async () => {
    const src = `
function createApplication() {}
function helper() {}
function named() {}
function other() {}
function hidden() {}
const obj = { a: 1 };
exports = module.exports = createApplication;
exports.named = named;
module.exports.other = 1;
module.exports = { helper, renamed: obj };
`;
    const q = byQName((await parseSource(src, 'javascript')).symbols);
    expect(q.get('createApplication')?.exported).toBe(true);
    expect(q.get('named')?.exported).toBe(true);
    expect(q.get('other')?.exported).toBe(true);
    expect(q.get('helper')?.exported).toBe(true);
    expect(q.get('obj')?.exported).toBe(true);
    expect(q.get('hidden')?.exported).toBe(false);
  });

  it('Python: underscore convention and dunder methods', async () => {
    const src = `
def greet(): pass
def _private(): pass
X = 1
_y = 2
class Counter:
    def __init__(self): pass
    def increment(self): pass
    def _bump(self): pass
class _Hidden:
    def visible(self): pass
`;
    const q = byQName((await parseSource(src, 'python')).symbols);
    expect(q.get('greet')?.exported).toBe(true);
    expect(q.get('_private')?.exported).toBe(false);
    expect(q.get('X')?.exported).toBe(true);
    expect(q.get('_y')?.exported).toBe(false);
    expect(q.get('Counter')?.exported).toBe(true);
    expect(q.get('Counter.__init__')?.exported).toBe(false);
    expect(q.get('Counter.increment')?.exported).toBe(true);
    expect(q.get('Counter._bump')?.exported).toBe(false);
    expect(q.get('_Hidden')?.exported).toBe(false);
    expect(q.get('_Hidden.visible')?.exported).toBe(false);
  });

  it('Python: literal __all__ is authoritative for top-level names', async () => {
    const src = `
__all__ = ['greet', "_special"]
def greet(): pass
def other(): pass
def _special(): pass
`;
    const q = byQName((await parseSource(src, 'python')).symbols);
    expect(q.get('greet')?.exported).toBe(true);
    expect(q.get('other')?.exported).toBe(false);
    expect(q.get('_special')?.exported).toBe(true);
  });

  describe('fixtures/sample via indexRepo', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'atlas-parse-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('marks the fixture public API as exported', async () => {
      const db = openDatabase(join(dir, 'index.db'));
      await indexRepo(db, FIXTURE);
      const rows = getAllSymbols(db);
      closeDatabase(db);
      const exp = new Map(rows.map((r) => [r.qualified_name, r.exported === 1]));
      for (const name of [
        'Circle',
        'Square',
        'Shape',
        'Drawable',
        'add',
        'multiply',
        'PI',
        'totalArea',
        'main',
        'Drawable.area',
        'Circle.area',
        'greet',
        'Counter',
        'Counter.increment',
      ]) {
        expect(exp.get(name), name).toBe(true);
      }
      expect(exp.get('Counter.__init__')).toBe(false);
      expect(rows.filter((r) => r.qualified_name === 'area')).toHaveLength(0);
    });

    it('indexes .tsx files with the tsx grammar', async () => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      writeFileSync(
        join(repo, 'App.tsx'),
        `export const App = () => <a href="/x">it's {1}</a>;\nexport function After() {}\n`,
      );
      const db = openDatabase(join(dir, 'index.db'));
      await indexRepo(db, repo);
      const names = getAllSymbols(db).map((r) => r.qualified_name);
      closeDatabase(db);
      expect(names).toContain('After');
    });
  });
});
