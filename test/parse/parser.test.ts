import { describe, expect, it } from 'vitest';
import { parseSource } from '../../src/core/parse/index.js';

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

  it('extracts interfaces and type aliases', async () => {
    const src = `
export interface Drawable { area(): number; }
export type Pair = [number, number];
`;
    const result = await parseSource(src, 'typescript');
    expect(result.symbols.find((s) => s.name === 'Drawable')?.kind).toBe('interface');
    expect(result.symbols.find((s) => s.name === 'Pair')?.kind).toBe('type');
  });

  it('extracts CJS require() — default, member, destructured, and aliased forms', async () => {
    const src = `
const express = require('express');
const Router = require('express').Router;
const { json, urlencoded } = require('express');
const { json: parseJson } = require('express');
`;
    const result = await parseSource(src, 'javascript');

    // default: const express = require('express')
    const def = result.imports.find((i) => i.module === 'express' && i.imported === 'default');
    expect(def?.alias).toBe('express');

    // member: const Router = require('express').Router
    const member = result.imports.find((i) => i.module === 'express' && i.imported === 'Router');
    expect(member?.alias).toBe('Router');

    // destructured: const { json, urlencoded } = require('express')
    const json = result.imports.find((i) => i.module === 'express' && i.imported === 'json' && i.alias === null);
    expect(json).toBeDefined();
    const urlencoded = result.imports.find((i) => i.module === 'express' && i.imported === 'urlencoded');
    expect(urlencoded).toBeDefined();

    // aliased destructured: const { json: parseJson } = require('express')
    const aliased = result.imports.find((i) => i.module === 'express' && i.imported === 'json' && i.alias === 'parseJson');
    expect(aliased).toBeDefined();
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
