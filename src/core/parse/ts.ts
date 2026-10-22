import type Parser from 'tree-sitter';
import type { LanguageId } from '../ingest/language.js';
import type { SymbolKind } from '../db/index.js';
import type {
  ParseDiagnostic,
  ParsedImport,
  ParsedReference,
  ParsedSymbol,
  ParseResult,
  RefKind,
  RefReceiver,
} from './types.js';
import {
  forEachOfType,
  internalDiagnostic,
  pushAll,
  boundValueRefs,
  pushDescendants,
  uniqueRefs,
  walkFrames,
  type Frame,
  type Peek,
} from './refs.js';

type Node = Parser.SyntaxNode;
type Cursor = Parser.TreeCursor;

const FN_NODES = new Set([
  'function_declaration',
  'function_signature',
  'generator_function_declaration',
]);

const CLASS_NODES = new Set(['class_declaration', 'abstract_class_declaration']);
// `namespace N {}`, `module N {}`, `declare module 'm' {}`: a 'variable' whose members are qualified.
const NAMESPACE_NODES = new Set(['internal_module', 'module']);
const INTERFACE_NODES = new Set(['interface_declaration']);
const TYPE_NODES = new Set(['type_alias_declaration', 'enum_declaration']);
const METHOD_NODES = new Set([
  'method_definition',
  'method_signature',
  'abstract_method_signature',
]);

/** Extract leading JSDoc comment preceding `node`, walking up through wrappers like `export_statement`. */
function extractLeadingComment(node: Node): string | null {
  // If our parent is an export/wrapping statement and we are its first named child,
  // the comment we want is the parent's previous sibling.
  let target: Node = node;
  while (
    target.parent &&
    (target.parent.type === 'export_statement' ||
      target.parent.type === 'export_specifier' ||
      target.parent.type === 'export_clause') &&
    target.parent.namedChildren[0]?.id === target.id
  ) {
    target = target.parent;
  }

  let prev = target.previousSibling;
  const collected: string[] = [];
  while (prev && (prev.type === 'comment' || prev.type === 'line_comment')) {
    collected.unshift(prev.text);
    prev = prev.previousSibling;
  }
  if (collected.length === 0) return null;
  const last = collected[collected.length - 1] ?? '';
  if (!/^\s*\/\*\*/.test(last)) return null;
  return collected.join('\n');
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

function signatureFor(node: Node): string {
  // Take the first line of the node as a coarse signature.
  const first = node.text.split('\n', 1)[0] ?? '';
  return first.trim().slice(0, 240);
}

function nameOf(node: Node): string | null {
  const ident = node.childForFieldName('name');
  if (ident) return ident.text;
  return null;
}

interface Ctx {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  qualifier: string[]; // path prefix for qualified names (e.g. ClassName)
  exportNames: Set<string>; // top-level names exported via `export { }`, `export default x` or CJS
  scopeExported: boolean; // exported flag of the enclosing class/interface/object
  references: ParsedReference[];
  owner: string | null; // qualified name references are attributed to; null = module
  ns: boolean; // the enclosing scope is a namespace body: statements, members exported by `export`
  top: Map<string, boolean>; // top-level symbol names and their exported flag
  chained: Set<number>; // ids of inner links of assignment chains, handled with the outermost
}

const FN_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);
const FIELD_NODES = new Set(['public_field_definition', 'field_definition']);

function qualify(ctx: Ctx, name: string): string {
  return ctx.qualifier.length === 0 ? name : `${ctx.qualifier.join('.')}.${name}`;
}

function isPublicMember(node: Node): boolean {
  const name = node.childForFieldName('name') ?? node.childForFieldName('property');
  if (name?.type === 'private_property_identifier') return false;
  return !node.namedChildren.some(
    (c) => c.type === 'accessibility_modifier' && c.text !== 'public',
  );
}

/** In a class, interface or object literal body, where nodes are members rather than statements. */
function inMembers(ctx: Ctx): boolean {
  return ctx.qualifier.length > 0 && !ctx.ns;
}

function isExported(ctx: Ctx, node: Node, name: string): boolean {
  if (ctx.qualifier.length > 0)
    return ctx.scopeExported && (ctx.ns ? exportStatementOf(node) : isPublicMember(node));
  return exportStatementOf(node) || ctx.exportNames.has(name);
}

/** The parent is an `export` statement, directly or through `declare` (`export declare function f()`). */
function exportStatementOf(node: Node): boolean {
  let p = node.parent;
  if (p?.type === 'ambient_declaration') p = p.parent;
  return p?.type === 'export_statement';
}

/** `node` gives signature and span; `outer` gives docstring and export status (e.g. the declaration around a declarator). */
function push(
  ctx: Ctx,
  kind: SymbolKind,
  name: string,
  node: Node,
  outer: Node = node,
): ParsedSymbol {
  const sym: ParsedSymbol = {
    kind,
    name,
    signature: signatureFor(node),
    startLine: lineOf(node),
    endLine: endLine(node),
    docstring: extractLeadingComment(outer),
    qualifiedName: qualify(ctx, name),
    exported: isExported(ctx, outer, name),
  };
  ctx.symbols.push(sym);
  if (ctx.qualifier.length === 0) ctx.top.set(name, sym.exported);
  return sym;
}

/** Enters the scope now; its members are walked next, then the scope is left. */
function visitScope(
  ctx: Ctx,
  stack: Frame[],
  name: string,
  exported: boolean,
  body: Node | null,
  ns = false,
): void {
  if (!body) return;
  const saved = { scopeExported: ctx.scopeExported, owner: ctx.owner, ns: ctx.ns };
  ctx.owner = qualify(ctx, name);
  ctx.qualifier.push(name);
  ctx.scopeExported = exported;
  ctx.ns = ns;
  stack.push(() => {
    ctx.qualifier.pop();
    Object.assign(ctx, saved);
  });
  pushAll(stack, body.namedChildren);
}

interface Target {
  name: string;
  receiver: RefReceiver;
  object: string | null;
}

const CALL_NODES = new Set([
  'call_expression',
  'new_expression',
  'jsx_self_closing_element',
  'jsx_opening_element',
]);
const NAME_NODES = new Set([
  'identifier',
  'type_identifier',
  'property_identifier',
  'private_property_identifier',
  'nested_identifier',
]);

/** `a`, `a.b.c` for identifier chains; null for anything computed. */
function dotted(node: Node): string | null {
  const parts: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === 'member_expression') {
    const prop = cur.childForFieldName('property');
    if (!prop) return null;
    parts.push(prop.text);
    cur = cur.childForFieldName('object');
  }
  if (!cur || !NAME_NODES.has(cur.type)) return null;
  parts.push(cur.text);
  return parts.reverse().join('.');
}

function targetOf(node: Node | null): Target | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier':
    case 'type_identifier':
      return { name: node.text, receiver: 'none', object: null };
    case 'generic_type':
      return targetOf(node.childForFieldName('name') ?? node.namedChildren[0] ?? null);
    case 'nested_type_identifier': {
      const mod = node.childForFieldName('module');
      const name = node.childForFieldName('name');
      return name ? { name: name.text, receiver: 'member', object: mod?.text ?? null } : null;
    }
    case 'member_expression': {
      const prop = node.childForFieldName('property');
      const obj = node.childForFieldName('object');
      if (!prop || !obj || !NAME_NODES.has(prop.type)) return null;
      if (obj.type === 'this') return { name: prop.text, receiver: 'this', object: null };
      if (obj.type === 'super') return { name: prop.text, receiver: 'super', object: null };
      return { name: prop.text, receiver: 'member', object: dotted(obj) };
    }
    default:
      return null;
  }
}

function addRef(ctx: Ctx, from: string | null, node: Node | null, kind: RefKind, at: Node): void {
  const t = targetOf(node);
  if (t) ctx.references.push({ fromQualifiedName: from, ...t, kind, line: lineOf(at) });
}

function addCall(ctx: Ctx, from: string | null, call: Node): void {
  if (call.type === 'jsx_self_closing_element' || call.type === 'jsx_opening_element') {
    const name = call.childForFieldName('name');
    // Lower-case tags are intrinsic elements (`<div>`), not components.
    if (name && !(name.type === 'identifier' && /^[a-z]/.test(name.text)))
      addRef(ctx, from, name, 'calls', call);
    return;
  }
  const callee =
    call.type === 'new_expression'
      ? call.childForFieldName('constructor')
      : call.childForFieldName('function');
  if (callee?.type === 'import' || (callee?.type === 'identifier' && callee.text === 'require')) {
    // Dynamic `import('x')` and `require('x')` anywhere: a module dependency without a binding.
    const module = callee.type === 'import' ? stringArg(call) : requireSource(call);
    if (module && !ctx.imports.some((i) => i.module === module && !i.reexport))
      ctx.imports.push({ module, imported: null, alias: null, line: lineOf(call) });
    return;
  }
  addRef(ctx, from, callee, 'calls', call);
  const args = call.lastChild;
  if (args?.type === 'arguments') addValues(ctx, from, args);
}

/**
 * `addCall` for the node at `cursor` read through the cursor, which is left where it was, so no
 * node is materialised. Covers `f()`, `new C()` and member callees; false for anything else.
 */
function addCallAt(ctx: Ctx, from: string | null, cursor: Cursor, type: string): boolean {
  if (type !== 'call_expression' && type !== 'new_expression') return false;
  const field = type === 'new_expression' ? 'constructor' : 'function';
  const line = cursor.startPosition.row + 1;
  if (!cursor.gotoFirstChild()) return false;
  let t: Target | null | undefined;
  do {
    const name = cursor.currentFieldName;
    if (name === field) {
      t = targetAt(cursor);
      if (t === undefined) break;
      if (t) ctx.references.push({ fromQualifiedName: from, ...t, kind: 'calls', line });
    } else if (name === 'arguments' && t !== undefined) {
      addValuesAt(ctx, from, cursor, 'arguments');
    }
  } while (cursor.gotoNextSibling());
  cursor.gotoParent();
  return t !== undefined;
}

/** `targetOf` for a callee at `cursor` (left in place); undefined where `addCall` needs the node. */
function targetAt(cursor: Cursor): Target | null | undefined {
  const type = cursor.nodeType;
  if (type === 'identifier') {
    const name = cursor.nodeText;
    return name === 'require' ? undefined : { name, receiver: 'none', object: null };
  }
  if (type !== 'member_expression') return undefined;
  if (!cursor.gotoFirstChild()) return null;
  let seenObj = false;
  let objType = '';
  let obj: string | null = null;
  let prop: string | null = null;
  let propType = '';
  do {
    const field = cursor.currentFieldName;
    if (field === 'object' && !seenObj) {
      seenObj = true;
      objType = cursor.nodeType;
      if (objType !== 'this' && objType !== 'super') obj = dottedAt(cursor);
    } else if (field === 'property' && prop === null) {
      propType = cursor.nodeType;
      prop = cursor.nodeText;
    }
  } while (cursor.gotoNextSibling());
  cursor.gotoParent();
  if (prop === null || !seenObj || !NAME_NODES.has(propType)) return null;
  if (objType === 'this') return { name: prop, receiver: 'this', object: null };
  if (objType === 'super') return { name: prop, receiver: 'super', object: null };
  return { name: prop, receiver: 'member', object: obj };
}

/** `dotted` for the node at `cursor` (left in place). */
function dottedAt(cursor: Cursor): string | null {
  const parts: string[] = [];
  let depth = 0;
  let result: string | null = null;
  for (;;) {
    const type = cursor.nodeType;
    if (type !== 'member_expression') {
      if (NAME_NODES.has(type)) result = [cursor.nodeText, ...parts.reverse()].join('.');
      break;
    }
    // The property's text, then on to the object.
    let prop: string | null = null;
    let objIndex = -1;
    if (!cursor.gotoFirstChild()) break;
    for (let i = 0; ; i++) {
      const field = cursor.currentFieldName;
      if (field === 'property' && prop === null) prop = cursor.nodeText;
      else if (field === 'object' && objIndex < 0) objIndex = i;
      if (!cursor.gotoNextSibling()) break;
    }
    cursor.gotoParent();
    if (prop === null || objIndex < 0) break;
    parts.push(prop);
    cursor.gotoFirstChild();
    for (let i = 0; i < objIndex; i++) cursor.gotoNextSibling();
    depth++;
  }
  for (; depth > 0; depth--) cursor.gotoParent();
  return result;
}

// Nodes whose named children (or, for `VALUE_LAST`, last child) can be a function used as a value;
// call arguments are read with their call.
const VALUE_LAST = new Set(['pair', 'variable_declarator', 'assignment_expression']);
// Value nodes the walk itself meets; declarators and assignments are handled by `visit`.
const WALK_VALUES = new Set([
  'array',
  'jsx_expression',
  'return_statement',
  'pair',
  'shorthand_property_identifier',
]);
const REF_NODES = new Set([
  ...CALL_NODES,
  ...WALK_VALUES,
  'variable_declarator',
  'assignment_expression',
]);

/** A `references` ref for an identifier or member expression used as a value. */
function addValue(ctx: Ctx, from: string | null, node: Node | null): void {
  if (node && (node.type === 'identifier' || node.type === 'member_expression'))
    addRef(ctx, from, node, 'references', node);
}

/** Values among the children of the value node at `cursor`, read through the cursor, which is left where it was. */
function addValuesAt(ctx: Ctx, from: string | null, cursor: Cursor, type: string): boolean {
  if (type === 'shorthand_property_identifier') {
    const line = cursor.startPosition.row + 1;
    ctx.references.push({
      fromQualifiedName: from,
      name: cursor.nodeText,
      receiver: 'none',
      object: null,
      kind: 'references',
      line,
    });
    return true;
  }
  if (!cursor.gotoFirstChild()) return true;
  if (VALUE_LAST.has(type)) {
    // The value is the last child, after the key or name: `k: v`, `x = v`.
    let n = 0;
    while (cursor.gotoNextSibling()) n++;
    if (n > 0) addValueAt(ctx, from, cursor);
  } else {
    do addValueAt(ctx, from, cursor);
    while (cursor.gotoNextSibling());
  }
  cursor.gotoParent();
  return true;
}

/** `addValuesAt` for a materialised node. */
function addValues(ctx: Ctx, from: string | null, node: Node): void {
  if (node.type === 'shorthand_property_identifier') addRef(ctx, from, node, 'references', node);
  else if (!VALUE_LAST.has(node.type)) for (const c of node.namedChildren) addValue(ctx, from, c);
  else if (node.childCount > 1) addValue(ctx, from, node.lastChild);
}

function addValueAt(ctx: Ctx, from: string | null, cursor: Cursor): void {
  const t = cursor.nodeType;
  const target = t === 'identifier' || t === 'member_expression' ? targetAt(cursor) : null;
  if (target)
    ctx.references.push({
      fromQualifiedName: from,
      ...target,
      kind: 'references',
      line: cursor.startPosition.row + 1,
    });
}

/** Calls and function values in `node`'s subtree. */
function collectCalls(ctx: Ctx, node: Node | null, from: string | null): void {
  if (node)
    forEachOfType(
      node,
      REF_NODES,
      (c) => (CALL_NODES.has(c.type) ? addCall(ctx, from, c) : addValues(ctx, from, c)),
      (cursor, type) =>
        CALL_NODES.has(type)
          ? addCallAt(ctx, from, cursor, type)
          : addValuesAt(ctx, from, cursor, type),
    );
}

function collectHeritage(ctx: Ctx, node: Node, from: string): void {
  for (const c of node.namedChildren) {
    if (c.type === 'extends_type_clause') {
      for (const t of c.namedChildren) addRef(ctx, from, t, 'extends', t);
    }
    if (c.type !== 'class_heritage') continue;
    for (const h of c.namedChildren) {
      if (h.type === 'extends_clause') {
        for (const t of h.namedChildren) {
          if (t.type !== 'type_arguments') addRef(ctx, from, t, 'extends', t);
        }
      } else if (h.type === 'implements_clause') {
        for (const t of h.namedChildren) addRef(ctx, from, t, 'implements', t);
      } else {
        addRef(ctx, from, h, 'extends', h); // JS grammar: the expression sits directly in class_heritage
      }
    }
  }
}

/** Object literal assigned to `module.exports`, `exports.x` or `module.exports.x`: the scope name, else null. */
function cjsObjectScope(assign: Node): string | null {
  const left = assign.childForFieldName('left');
  if (assign.childForFieldName('right')?.type !== 'object' || !left) return null;
  if (isModuleExports(left)) return 'default';
  if (left.type !== 'member_expression') return null;
  return isExportsObject(left) ? (left.childForFieldName('property')?.text ?? null) : null;
}

const VISITED_ANYWHERE = [
  ...FN_NODES,
  ...FN_VALUES,
  ...CLASS_NODES,
  ...INTERFACE_NODES,
  ...TYPE_NODES,
  ...METHOD_NODES,
  ...NAMESPACE_NODES,
  ...CALL_NODES,
  ...WALK_VALUES,
  'import_statement',
];
// The types `visit` acts on at module level and inside a scope; other nodes only have their named children walked.
const VISITED_TOP = new Set([
  ...VISITED_ANYWHERE,
  'lexical_declaration',
  'variable_declaration',
  'assignment_expression',
  'export_statement',
]);
const VISITED_MEMBER = new Set([...VISITED_ANYWHERE, ...FIELD_NODES, 'property_signature']);

/** Walk-time handler for calls and values, which reads them through the cursor. */
function peekRef(ctx: Ctx, cursor: Cursor, type: string): boolean {
  if (CALL_NODES.has(type)) return addCallAt(ctx, ctx.owner, cursor, type);
  // In a member scope, `pair`s are object-literal members for `visit`.
  return WALK_VALUES.has(type) && !(type === 'pair' && inMembers(ctx))
    ? addValuesAt(ctx, ctx.owner, cursor, type)
    : false;
}

/** `node`'s parent, skipping parentheses. */
function outerOf(node: Node): Node | null {
  let c = node.parent;
  while (c?.type === 'parenthesized_expression') c = c.parent;
  return c;
}

/** `node` without the parentheses around it. */
function unparenthesized(node: Node | null): Node | null {
  while (node?.type === 'parenthesized_expression') node = node.namedChildren[0] ?? null;
  return node;
}

/**
 * A function value whose body is module scope (DECISIONS SG26): the callee of a call (IIFE,
 * also through `.call`/`.apply`), an argument of a call whose callee is a function value (UMD
 * factory, `(function (root, factory) {…})(this, function () {…})`), or the last argument of
 * `define(…)` (AMD, incl. `define(function (require, exports, module) {…})`).
 */
function isModuleWrapper(fn: Node): boolean {
  let c = outerOf(fn);
  if (c?.type === 'arguments') {
    const call = c.parent;
    const callee = call?.childForFieldName('function') ?? null;
    if (callee?.type === 'identifier')
      return callee.text === 'define' && c.lastNamedChild?.id === withParens(fn).id;
    return FN_VALUES.has(unparenthesized(callee)?.type ?? '');
  }
  const prop = c?.type === 'member_expression' ? c.childForFieldName('property')?.text : null;
  if (prop === 'call' || prop === 'apply') c = c?.parent ?? null;
  return c?.type === 'call_expression';
}

/** `fn` with the parentheses around it, if any. */
function withParens(fn: Node): Node {
  let n = fn;
  while (n.parent?.type === 'parenthesized_expression') n = n.parent;
  return n;
}

const DESCRIPTOR_CALLEES = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const PROPERTY_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * `fn` defines property `obj.name` (DECISIONS SG26): it is the third and last argument of
 * `f(obj, 'name', fn)` (express `defineGetter(req, 'protocol', function () {…})`), or the `get` /
 * `value` of the descriptor in `Object.defineProperty(obj, 'name', { get() {…} })`. `obj` is
 * a dotted path whose head is a top-level symbol of this file, not an import binding. Defines
 * the method at module level and returns true; false for any other shape.
 */
function definedProperty(ctx: Ctx, fn: Node): boolean {
  if (ctx.qualifier.length > 0) return false;
  let holder = fn;
  let descriptor = false;
  if (fn.type === 'method_definition' || fn.parent?.type === 'pair') {
    const member = fn.type === 'method_definition' ? fn : (fn.parent as Node);
    const key = member.childForFieldName(member === fn ? 'name' : 'key')?.text;
    if (key !== 'get' && key !== 'value') return false;
    const object = member.parent;
    if (object?.type !== 'object') return false;
    holder = object;
    descriptor = true;
  }
  const args = outerOf(holder);
  if (args?.type !== 'arguments') return false;
  const list = args.namedChildren.filter((c) => c.type !== 'comment');
  if (list.length !== 3 || list[2]?.id !== withParens(holder).id) return false;
  const nameArg = list[1];
  const name = nameArg?.type === 'string' ? trimQuotes(nameArg.text) : '';
  if (!PROPERTY_NAME.test(name)) return false;
  const callee = args.parent?.childForFieldName('function') ?? null;
  if (descriptor !== DESCRIPTOR_CALLEES.has((callee && dotted(callee)) ?? '')) return false;
  const objPath = list[0] ? dotted(list[0])?.split('.') : null;
  const head = objPath?.[0];
  if (!objPath || !head || !ctx.top.has(head) || ctx.imports.some((i) => importBinding(i) === head))
    return false;
  const call = args.parent as Node;
  const stmt = call.parent?.type === 'expression_statement' ? call.parent : call;
  ctx.qualifier = objPath;
  const sym = push(ctx, 'method', name, call, stmt);
  ctx.qualifier = [];
  sym.exported = ctx.top.get(head) ?? false;
  collectCalls(ctx, fn, sym.qualifiedName);
  return true;
}

/** The local name an import binds, if any. */
function importBinding(i: ParsedImport): string | null {
  const named = i.imported !== null && i.imported !== '*' && i.imported !== 'default';
  return i.reexport ? null : (i.alias ?? (named ? i.imported : null));
}

/** Not inside a function body, other than a module wrapper's (`isModuleWrapper`). */
function atModuleLevel(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (FN_VALUES.has(p.type) && !isModuleWrapper(p)) return false;
  }
  return true;
}

/**
 * Defines `path` (e.g. `['res', 'send']`) as the function or class `value`, a function at the top
 * level and a method below it; false for any other value. `node` gives span and signature.
 */
function defineValue(
  ctx: Ctx,
  stack: Frame[],
  path: string[],
  value: Node,
  node: Node,
  exported?: boolean,
): boolean {
  const isFn = FN_VALUES.has(value.type);
  if (!isFn && value.type !== 'class') return false;
  const name = path[path.length - 1] as string;
  const saved = ctx.qualifier;
  ctx.qualifier = path.slice(0, -1);
  const outer = node.parent?.type === 'expression_statement' ? node.parent : node;
  const sym = push(
    ctx,
    isFn ? (path.length > 1 ? 'method' : 'function') : 'class',
    name,
    node,
    outer,
  );
  ctx.qualifier = saved;
  if (exported !== undefined) sym.exported = exported;
  const qname = sym.qualifiedName ?? name;
  if (isFn) collectCalls(ctx, value, qname);
  else {
    collectHeritage(ctx, value, qname);
    visitScope(ctx, stack, qname, sym.exported, value.childForFieldName('body'));
  }
  return true;
}

interface AssignedPath {
  path: string[];
  exported?: boolean;
  /** `obj.x` / `C.prototype` on the left: an object literal on the right is a member scope. */
  scope: boolean;
}

/** What assigning `value` to `left` at module level (`topLevel()`) defines, or null. */
function assignedPath(
  ctx: Ctx,
  left: Node | null,
  value: Node,
  topLevel: () => boolean,
): AssignedPath | null {
  if (left?.type !== 'member_expression') return null;
  if (isModuleExports(left)) return { path: [nameOf(value) ?? 'default'], scope: false };
  const chain = dotted(left)?.split('.');
  if (!chain || !topLevel()) return null;
  if (chain[0] === 'exports' || (chain[0] === 'module' && chain[1] === 'exports'))
    return { path: chain.slice(chain[0] === 'exports' ? 1 : 2), scope: false };
  const path = chain.filter((p) => p !== 'prototype');
  const head = path[0] as string;
  const exported = ctx.top.get(head) ?? ctx.exportNames.has(head);
  if (path.length === 1 && !(chain.length === 2 && value.type === 'object')) return null;
  return { path, exported, scope: path.length === 1 };
}

/**
 * Module-level `module.exports = function () {}`, `exports.x = …`, `obj.m = …`,
 * `C.prototype.m = …` and `C.prototype = { … }`; true when it defined something. In a chain
 * (`res.contentType = res.type = function …`) the innermost target is defined and every other
 * member target is an alias of it (A9-12).
 */
function visitAssignment(ctx: Ctx, stack: Frame[], node: Node): boolean {
  // An inner link of a chain was handled with the outermost one.
  if (ctx.chained.has(node.id)) return false;
  let top: boolean | undefined;
  const topLevel = (): boolean => (top ??= atModuleLevel(node));
  const assigns: Node[] = [];
  let value: Node | null = node;
  while (value?.type === 'assignment_expression') {
    if (assigns.length > 0) ctx.chained.add(value.id);
    assigns.push(value);
    value = value.childForFieldName('right');
  }
  if (!value) return false;
  const stmt = node.parent?.type === 'expression_statement' ? node.parent : node;
  let main: ParsedSymbol | null = null;
  let defined = false;
  for (let i = assigns.length - 1; i >= 0; i--) {
    const assign = assigns[i] as Node;
    const target = assignedPath(ctx, assign.childForFieldName('left'), value, topLevel);
    if (!target) continue;
    if (!defined) {
      const before = ctx.symbols.length;
      if (target.scope) visitScope(ctx, stack, target.path[0] as string, !!target.exported, value);
      else if (!defineValue(ctx, stack, target.path, value, assign, target.exported)) return false;
      defined = true;
      main = ctx.symbols[before] ?? null;
      if (main && !main.docstring && assign !== node) main.docstring = extractLeadingComment(stmt);
    } else if (main && !target.scope) {
      defineAlias(ctx, main, target, assign, stmt);
    }
  }
  return defined;
}

/** `main` under another name: same kind, no calls of its own. */
function defineAlias(
  ctx: Ctx,
  main: ParsedSymbol,
  target: AssignedPath,
  node: Node,
  stmt: Node,
): void {
  const saved = ctx.qualifier;
  ctx.qualifier = target.path.slice(0, -1);
  const name = target.path[target.path.length - 1] as string;
  if (qualify(ctx, name) !== main.qualifiedName) {
    const kind = main.kind === 'class' ? 'class' : target.path.length > 1 ? 'method' : 'function';
    const sym = push(ctx, kind, name, node, stmt);
    if (target.exported !== undefined) sym.exported = target.exported;
  }
  ctx.qualifier = saved;
}

/** Returns true when the node's named children are to be walked. */
function visit(node: Node, type: string, ctx: Ctx, stack: Frame[]): boolean {
  // ESM imports
  if (type === 'import_statement') {
    collectImports(node, ctx);
  }

  // CommonJS require() — only at top level to avoid noise from dynamic requires
  // inside functions. Express, older Node libs, etc.
  if (
    (type === 'lexical_declaration' || type === 'variable_declaration') &&
    ctx.qualifier.length === 0
  ) {
    collectRequires(node, ctx);
  }

  // Functions — do not descend into function bodies, locals are not symbols.
  if (FN_NODES.has(type)) {
    const name = nameOf(node);
    const sym = name ? push(ctx, 'function', name, node) : null;
    collectCalls(ctx, node, sym?.qualifiedName ?? ctx.owner);
    return false;
  }

  if (CLASS_NODES.has(type) || INTERFACE_NODES.has(type)) {
    const name = nameOf(node);
    if (name) {
      const sym = push(ctx, CLASS_NODES.has(type) ? 'class' : 'interface', name, node);
      collectHeritage(ctx, node, sym.qualifiedName ?? name);
      visitScope(ctx, stack, name, sym.exported, node.childForFieldName('body'));
      return false;
    }
  }

  if (NAMESPACE_NODES.has(type)) {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const name = trimQuotes(nameNode.text);
      const outer = node.parent?.type === 'ambient_declaration' ? node.parent : node;
      const sym = push(ctx, 'variable', name, node, outer);
      visitScope(ctx, stack, name, sym.exported, node.childForFieldName('body'), true);
      return false;
    }
  }

  // A function value's body is a local scope unless it is a module wrapper: its calls and
  // values are the enclosing owner's, its declarations are not symbols (A9-02).
  if (FN_VALUES.has(type)) {
    if (isModuleWrapper(node)) return true;
    if (!definedProperty(ctx, node)) collectCalls(ctx, node, ctx.owner);
    return false;
  }

  if (CALL_NODES.has(type)) {
    addCall(ctx, ctx.owner, node);
  }
  if (WALK_VALUES.has(type) && !(type === 'pair' && inMembers(ctx)))
    addValuesAt(ctx, ctx.owner, node.walk(), type);

  if (ctx.qualifier.length === 0 && type === 'assignment_expression') {
    if (visitAssignment(ctx, stack, node)) return false;
    addValue(ctx, ctx.owner, node.childForFieldName('right'));
  }

  if (ctx.qualifier.length === 0) {
    const value = type === 'export_statement' ? node.childForFieldName('value') : null;
    // `export default function () {}`, `export default class extends B {}`, `export default fn`.
    if (value && defineValue(ctx, stack, [nameOf(value) ?? 'default'], value, node)) return false;
    addValue(ctx, ctx.owner, value);
    const object = objectValue(value);
    const scope = object
      ? 'default'
      : type === 'assignment_expression'
        ? cjsObjectScope(node)
        : null;
    if (scope) {
      visitScope(ctx, stack, scope, true, object ?? node.childForFieldName('right'));
      return false;
    }
  }

  // Type aliases & enums; object-type members are qualified like interface members.
  if (TYPE_NODES.has(type)) {
    const name = nameOf(node);
    if (name) {
      const sym = push(ctx, 'type', name, node);
      const value = node.childForFieldName('value');
      if (value?.type === 'object_type') visitScope(ctx, stack, name, sym.exported, value);
    }
    return false;
  }

  // Methods — don't descend.
  if (METHOD_NODES.has(type)) {
    if (definedProperty(ctx, node)) return false;
    // At module level a method belongs to an object literal that is no scope (a call argument,
    // an array element, a return value): like a callback, it defines nothing (A9-02).
    const loose = ctx.qualifier.length === 0 && node.parent?.type === 'object';
    const name = loose ? null : nameOf(node);
    const sym = name ? push(ctx, 'method', name, node) : null;
    collectCalls(ctx, node, sym?.qualifiedName ?? ctx.owner);
    return false;
  }

  if (inMembers(ctx)) {
    // Function-typed interface properties: `onDraw: () => void`.
    if (type === 'property_signature') {
      const name = nameOf(node);
      const typeNode = node.childForFieldName('type')?.namedChildren[0];
      if (name && typeNode?.type === 'function_type') push(ctx, 'method', name, node);
      return false;
    }
    // Class fields holding functions: `handle = () => {}`.
    if (FIELD_NODES.has(type)) {
      const name = (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text;
      const value = node.childForFieldName('value');
      const fn =
        name && value && FN_VALUES.has(value.type) ? push(ctx, 'method', name, node) : null;
      if (!fn) addValue(ctx, ctx.owner, value);
      collectCalls(ctx, value, fn?.qualifiedName ?? ctx.owner);
      return false;
    }
    // Object-literal properties holding functions: `{ arrow: () => 2 }`.
    if (type === 'pair') {
      const key = node.childForFieldName('key');
      const value = node.childForFieldName('value');
      const fn =
        key && value && FN_VALUES.has(value.type)
          ? push(ctx, 'method', trimQuotes(key.text), node)
          : null;
      collectCalls(ctx, fn ? value : node, fn?.qualifiedName ?? ctx.owner);
      return false;
    }
  }

  // Top-level lexical declarations (const/let/var). We only record top-level
  // (ctx.qualifier empty) to avoid noise from local variables.
  if (
    (type === 'lexical_declaration' || type === 'variable_declaration') &&
    (ctx.qualifier.length === 0 || ctx.ns)
  ) {
    // Declarators are deferred so each object scope is walked before the next declarator.
    const decls = node.namedChildren.filter((d) => d.type === 'variable_declarator');
    for (let i = decls.length - 1; i >= 0; i--) {
      const decl = decls[i] as Node;
      stack.push(() => visitDeclarator(ctx, stack, node, decl));
    }
    return false;
  }

  // Recurse for children unless we already short-circuited.
  return true;
}

function visitDeclarator(ctx: Ctx, stack: Frame[], node: Node, decl: Node): void {
  const nameNode = decl.childForFieldName('name');
  const valueNode = decl.childForFieldName('value');
  if (!nameNode || nameNode.type !== 'identifier') {
    // `const { a, b: c = 1, ...d } = f()`, `const [e, [g]] = h`: each bound name (A13-01).
    for (const name of patternNames(nameNode)) push(ctx, 'variable', name.text, decl, node);
    collectCalls(ctx, valueNode, ctx.owner);
    return;
  }
  const isFn = valueNode !== null && FN_VALUES.has(valueNode.type);
  const sym = push(ctx, isFn ? 'function' : 'variable', nameNode.text, decl, node);
  // Values are not walked for symbols: locals of `const f = () => {...}` are not top-level.
  let assigned = valueNode;
  while (assigned?.type === 'assignment_expression') assigned = assigned.childForFieldName('right');
  const object = objectValue(assigned);
  if (object) visitScope(ctx, stack, sym.name, sym.exported, object);
  else collectCalls(ctx, decl, sym.qualifiedName);
}

/** The identifiers an object or array binding pattern binds, in source order. */
function patternNames(pattern: Node | null): Node[] {
  const names: Node[] = [];
  const todo = pattern ? [pattern] : [];
  for (let n = todo.pop(); n; n = todo.pop()) {
    const t = n.type;
    if (t === 'identifier' || t === 'shorthand_property_identifier_pattern') names.push(n);
    else if (t === 'object_pattern' || t === 'array_pattern' || t === 'rest_pattern')
      todo.push(...[...n.namedChildren].reverse());
    else {
      const inner =
        t === 'pair_pattern'
          ? n.childForFieldName('value')
          : t === 'object_assignment_pattern' || t === 'assignment_pattern'
            ? n.childForFieldName('left')
            : null;
      if (inner) todo.push(inner);
    }
  }
  return names;
}

/** An object literal, also under `as const` / `satisfies T` (A9-07); null for anything else. */
function objectValue(node: Node | null): Node | null {
  while (node?.type === 'as_expression' || node?.type === 'satisfies_expression')
    node = node.namedChildren[0] ?? null;
  return node?.type === 'object' ? node : null;
}

function isModuleExports(node: Node | null): boolean {
  return (
    node?.type === 'member_expression' &&
    node.childForFieldName('object')?.text === 'module' &&
    node.childForFieldName('property')?.text === 'exports'
  );
}

function collectCjsExports(first: Node, names: Set<string>, rows: ParsedImport[]): void {
  // `a = b = c` chains nest to the right; walked as a loop.
  for (let assign: Node | null = first; assign; ) {
    assign = collectCjsExport(assign, names, rows);
  }
}

/** Records one assignment's export names; returns the chained right-hand assignment, if any. */
function collectCjsExport(assign: Node, names: Set<string>, rows: ParsedImport[]): Node | null {
  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');
  if (!left || !right) return null;
  const line = lineOf(assign);
  const required = right.type === 'call_expression' ? requireSource(right) : null;
  if (isModuleExports(left)) {
    const named = right.type === 'identifier' ? right.text : (nameOf(right) ?? 'default');
    if (
      named &&
      (right.type === 'identifier' || FN_VALUES.has(right.type) || right.type === 'class')
    ) {
      names.add(named);
      rows.push(localExport(named, 'default', line));
    }
    if (required) {
      // `module.exports = require('./x')`: a CJS barrel.
      rows.push({ module: required, imported: '*', alias: null, line, reexport: true });
      rows.push({ module: required, imported: 'default', alias: 'default', line, reexport: true });
    }
    if (right.type === 'object') {
      for (const p of right.namedChildren) {
        if (p.type === 'shorthand_property_identifier') names.add(p.text);
        const value = p.type === 'pair' ? p.childForFieldName('value') : null;
        if (value?.type === 'identifier') names.add(value.text);
      }
    }
  } else if (left.type === 'member_expression') {
    if (isExportsObject(left)) {
      const prop = left.childForFieldName('property');
      if (prop) names.add(prop.text);
      if (right.type === 'identifier') names.add(right.text);
      if (prop && right.type === 'identifier' && right.text !== prop.text)
        rows.push(localExport(right.text, prop.text, line));
      if (prop && required)
        rows.push({ module: required, imported: '*', alias: prop.text, line, reexport: true });
    }
  }
  return right.type === 'assignment_expression' ? right : null;
}

/** Local `name` exported as `as` (`export default name`, `export { name as as }`). */
function localExport(name: string, as: string, line: number): ParsedImport {
  return { module: '', imported: name, alias: as, line, reexport: true };
}

/** `export … from '…'`: one re-export row per name, or one for `*` / `* as ns`. */
function collectReexports(node: Node, module: string, rows: ParsedImport[]): void {
  const line = lineOf(node);
  const clause = node.namedChildren.find((c) => c.type === 'export_clause');
  if (clause) {
    for (const spec of clause.namedChildren) {
      const name = spec.type === 'export_specifier' ? spec.childForFieldName('name') : null;
      if (!name) continue;
      const alias = spec.childForFieldName('alias')?.text ?? null;
      rows.push({ module, imported: name.text, alias, line, reexport: true });
    }
    return;
  }
  const ns = node.namedChildren.find((c) => c.type === 'namespace_export');
  const alias = ns?.namedChildren.find((c) => c.type === 'identifier')?.text ?? null;
  rows.push({ module, imported: '*', alias, line, reexport: true });
}

/** Top-level export names; re-export and default-export rows go to `rows`. */
function collectExports(root: Node, rows: ParsedImport[]): Set<string> {
  const names = new Set<string>();
  for (const node of root.namedChildren) {
    const source = node.type === 'export_statement' ? node.childForFieldName('source') : null;
    if (source) {
      collectReexports(node, trimQuotes(source.text), rows);
    } else if (node.type === 'export_statement') {
      const line = lineOf(node);
      const value = node.childForFieldName('value');
      const named =
        value?.type === 'identifier'
          ? value.text
          : value && (FN_VALUES.has(value.type) || value.type === 'class')
            ? (nameOf(value) ?? 'default')
            : null;
      if (named) {
        names.add(named);
        rows.push(localExport(named, 'default', line));
      }
      const isDefault = node.children.some((c) => c.type === 'default');
      const declared = node.childForFieldName('declaration');
      const declName = declared ? nameOf(declared) : null;
      if (isDefault && declName) rows.push(localExport(declName, 'default', line));
      // TS `export = X`
      const assigned = node.children.some((c) => c.type === '=') ? node.namedChildren[0] : null;
      if (assigned?.type === 'identifier') {
        names.add(assigned.text);
        rows.push(localExport(assigned.text, 'default', line));
      }
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      for (const spec of clause?.namedChildren ?? []) {
        const name = spec.type === 'export_specifier' ? spec.childForFieldName('name') : null;
        if (!name) continue;
        names.add(name.text);
        const alias = spec.childForFieldName('alias')?.text;
        if (alias && alias !== name.text) rows.push(localExport(name.text, alias, line));
      }
    } else if (node.type === 'expression_statement') {
      const expr = node.namedChildren[0];
      if (expr?.type === 'assignment_expression') collectCjsExports(expr, names, rows);
    } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const decl of node.namedChildren) collectCjsAlias(decl, names, rows);
    }
  }
  return names;
}

/**
 * `var app = exports = module.exports = {}` (express `lib/application.js`): `app` is the
 * exported object, and the default export when the chain ends in an object (A9-11).
 */
function collectCjsAlias(decl: Node, names: Set<string>, rows: ParsedImport[]): void {
  const name = decl.type === 'variable_declarator' ? decl.childForFieldName('name') : null;
  let value = decl.childForFieldName('value');
  if (name?.type !== 'identifier' || value?.type !== 'assignment_expression') return;
  collectCjsExports(value, names, rows);
  let toModule = false;
  let toExports = false;
  while (value?.type === 'assignment_expression') {
    const left = value.childForFieldName('left');
    if (isModuleExports(left)) toModule = true;
    else if (left?.type === 'member_expression') toExports ||= isExportsObject(left);
    value = value.childForFieldName('right');
  }
  if (toModule || toExports) names.add(name.text);
  if (toModule && value?.type === 'object')
    rows.push(localExport(name.text, 'default', lineOf(decl)));
}

/** `exports.x` or `module.exports.x`. */
function isExportsObject(left: Node): boolean {
  const obj = left.childForFieldName('object');
  return (obj?.type === 'identifier' && obj.text === 'exports') || isModuleExports(obj);
}

function collectImports(node: Node, ctx: Ctx): void {
  // `import_statement` has shape:
  //   import <import_clause>? from <string>;
  // import_clause may contain named_imports / namespace_import / identifier (default).
  const line = lineOf(node);
  const req = node.namedChildren.find((c) => c.type === 'import_require_clause');
  if (req) {
    // TS `import x = require('./m')`: a namespace binding.
    const module = req.childForFieldName('source');
    const id = req.namedChildren.find((c) => c.type === 'identifier');
    if (module && id)
      ctx.imports.push({ module: trimQuotes(module.text), imported: '*', alias: id.text, line });
    return;
  }
  const src = node.childForFieldName('source');
  const moduleStr = src ? trimQuotes(src.text) : null;
  if (!moduleStr) return;

  const clause = node.namedChildren.find(
    (c) => c.type === 'import_clause' || c.type === 'import_specifier',
  );
  if (!clause) {
    // Side-effect import: `import './foo';`
    ctx.imports.push({ module: moduleStr, imported: null, alias: null, line });
    return;
  }

  // Default import: identifier child
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      ctx.imports.push({ module: moduleStr, imported: 'default', alias: child.text, line });
    } else if (child.type === 'namespace_import') {
      const id = child.namedChildren.find((c) => c.type === 'identifier');
      ctx.imports.push({
        module: moduleStr,
        imported: '*',
        alias: id?.text ?? null,
        line,
      });
    } else if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        const name = nameNode?.text ?? '';
        if (!name) continue;
        ctx.imports.push({
          module: moduleStr,
          imported: name,
          alias: aliasNode?.text ?? null,
          line,
        });
      }
    }
  }
}

function unwrapCallExpression(node: Node): Node | null {
  // require('x') is a call_expression; require('x').y is a member_expression
  // whose object is a call_expression; sometimes there's parenthesized_expression.
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === 'call_expression') return cur;
    if (cur.type === 'member_expression') {
      cur = cur.childForFieldName('object');
      continue;
    }
    if (cur.type === 'parenthesized_expression') {
      cur = cur.namedChildren[0] ?? null;
      continue;
    }
    return null;
  }
  return null;
}

function requireSource(callExpr: Node): string | null {
  const fn = callExpr.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'require') return null;
  return stringArg(callExpr);
}

/** The first argument of a call when it is a plain string literal. */
function stringArg(callExpr: Node): string | null {
  const args = callExpr.childForFieldName('arguments');
  if (!args) return null;
  const arg = args.namedChildren[0];
  if (!arg) return null;
  if (arg.type !== 'string') return null;
  // The string node's text includes quotes; trimQuotes handles it.
  return trimQuotes(arg.text);
}

function collectRequires(decl: Node, ctx: Ctx): void {
  for (const declarator of decl.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const value = declarator.childForFieldName('value');
    if (!value) continue;
    const call = unwrapCallExpression(value);
    if (!call) continue;
    const moduleStr = requireSource(call);
    if (!moduleStr) continue;
    const line = lineOf(declarator);
    const nameNode = declarator.childForFieldName('name');
    if (!nameNode) {
      ctx.imports.push({ module: moduleStr, imported: null, alias: null, line });
      continue;
    }
    if (nameNode.type === 'identifier') {
      // const x = require('foo')        → default
      // const x = require('foo').y      → named y, aliased x
      let imported: string = 'default';
      if (value.type === 'member_expression') {
        const prop = value.childForFieldName('property');
        if (prop && prop.type === 'property_identifier') imported = prop.text;
      }
      ctx.imports.push({ module: moduleStr, imported, alias: nameNode.text, line });
    } else if (nameNode.type === 'object_pattern') {
      // const { x, y: z } = require('foo')
      for (const prop of nameNode.namedChildren) {
        if (prop.type === 'shorthand_property_identifier_pattern') {
          ctx.imports.push({ module: moduleStr, imported: prop.text, alias: null, line });
        } else if (prop.type === 'pair_pattern') {
          const keyNode = prop.childForFieldName('key');
          const valNode = prop.childForFieldName('value');
          if (keyNode && valNode) {
            ctx.imports.push({
              module: moduleStr,
              imported: keyNode.text,
              alias: valNode.type === 'identifier' ? valNode.text : null,
              line,
            });
          }
        }
      }
    } else {
      ctx.imports.push({ module: moduleStr, imported: 'default', alias: null, line });
    }
  }
}

function trimQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === '`')) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseTsLike(root: Node, language: LanguageId): ParseResult {
  const ctx: Ctx = {
    symbols: [],
    imports: [],
    qualifier: [],
    exportNames: new Set(),
    scopeExported: false,
    references: [],
    owner: null,
    ns: false,
    top: new Map(),
    chained: new Set(),
  };
  const diagnostics: ParseDiagnostic[] = [];
  try {
    ctx.exportNames = collectExports(root, ctx.imports);
    const visitChild = (node: Node, type: string, stack: Frame[]): boolean =>
      visit(node, type, ctx, stack);
    // For call and value nodes `visit` only records them and walks on.
    const peek: Peek = (cursor, type) => peekRef(ctx, cursor, type);
    walkFrames(root.namedChildren, (node, stack) => {
      if (visit(node, node.type, ctx, stack)) {
        const types = inMembers(ctx) ? VISITED_MEMBER : VISITED_TOP;
        pushDescendants(stack, node, types, visitChild, peek);
      }
    });
  } catch (err) {
    diagnostics.push(internalDiagnostic(err));
  }
  const bound = new Set(ctx.top.keys());
  for (const i of ctx.imports) {
    const local = importBinding(i);
    if (local) bound.add(local);
  }
  return {
    language,
    symbols: ctx.symbols,
    imports: ctx.imports,
    references: uniqueRefs(boundValueRefs(ctx.references, bound)),
    diagnostics,
  };
}
