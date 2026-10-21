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
}

const FN_VALUES = new Set(['arrow_function', 'function_expression', 'function']);
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

function isExported(ctx: Ctx, node: Node, name: string): boolean {
  if (ctx.qualifier.length > 0) return ctx.scopeExported && isPublicMember(node);
  return node.parent?.type === 'export_statement' || ctx.exportNames.has(name);
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
  return sym;
}

/** Enters the scope now; its members are walked next, then the scope is left. */
function visitScope(
  ctx: Ctx,
  stack: Frame[],
  name: string,
  exported: boolean,
  body: Node | null,
): void {
  if (!body) return;
  const saved = { scopeExported: ctx.scopeExported, owner: ctx.owner };
  ctx.owner = qualify(ctx, name);
  ctx.qualifier.push(name);
  ctx.scopeExported = exported;
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
    if (cursor.currentFieldName === field) {
      t = targetAt(cursor);
      break;
    }
  } while (cursor.gotoNextSibling());
  cursor.gotoParent();
  if (t === undefined) return false;
  if (t) ctx.references.push({ fromQualifiedName: from, ...t, kind: 'calls', line });
  return true;
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

function collectCalls(ctx: Ctx, node: Node | null, from: string | null): void {
  if (node)
    forEachOfType(
      node,
      CALL_NODES,
      (c) => addCall(ctx, from, c),
      (cursor, type) => addCallAt(ctx, from, cursor, type),
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
  const obj = left.childForFieldName('object');
  const isExports = (obj?.type === 'identifier' && obj.text === 'exports') || isModuleExports(obj);
  return isExports ? (left.childForFieldName('property')?.text ?? null) : null;
}

const VISITED_ANYWHERE = [
  ...FN_NODES,
  ...CLASS_NODES,
  ...INTERFACE_NODES,
  ...TYPE_NODES,
  ...METHOD_NODES,
  ...CALL_NODES,
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
const VISITED_MEMBER = new Set([...VISITED_ANYWHERE, ...FIELD_NODES, 'property_signature', 'pair']);

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

  if (CALL_NODES.has(type)) {
    addCall(ctx, ctx.owner, node);
  }

  // `module.exports = function f() {}` / `= class C {}`: a named default export.
  if (ctx.qualifier.length === 0 && type === 'assignment_expression') {
    const right = node.childForFieldName('right');
    const name = right ? nameOf(right) : null;
    if (right && name && isModuleExports(node.childForFieldName('left'))) {
      if (FN_VALUES.has(right.type)) {
        const sym = push(ctx, 'function', name, right, node.parent ?? node);
        collectCalls(ctx, right, sym.qualifiedName);
        return false;
      }
      if (right.type === 'class') {
        const sym = push(ctx, 'class', name, right, node.parent ?? node);
        collectHeritage(ctx, right, sym.qualifiedName ?? name);
        visitScope(ctx, stack, name, sym.exported, right.childForFieldName('body'));
        return false;
      }
    }
  }

  if (ctx.qualifier.length === 0) {
    const value = type === 'export_statement' ? node.childForFieldName('value') : null;
    const scope =
      value?.type === 'object'
        ? 'default'
        : type === 'assignment_expression'
          ? cjsObjectScope(node)
          : null;
    if (scope) {
      visitScope(ctx, stack, scope, true, value ?? node.childForFieldName('right'));
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
    const name = nameOf(node);
    const sym = name ? push(ctx, 'method', name, node) : null;
    collectCalls(ctx, node, sym?.qualifiedName ?? ctx.owner);
    return false;
  }

  if (ctx.qualifier.length > 0) {
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
      collectCalls(ctx, value, fn?.qualifiedName ?? ctx.owner);
      return false;
    }
  }

  // Top-level lexical declarations (const/let/var). We only record top-level
  // (ctx.qualifier empty) to avoid noise from local variables.
  if (
    (type === 'lexical_declaration' || type === 'variable_declaration') &&
    ctx.qualifier.length === 0
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
    collectCalls(ctx, valueNode, ctx.owner);
    return;
  }
  const isFn = valueNode !== null && FN_VALUES.has(valueNode.type);
  const sym = push(ctx, isFn ? 'function' : 'variable', nameNode.text, decl, node);
  // Values are not walked for symbols: locals of `const f = () => {...}` are not top-level.
  if (valueNode?.type === 'object') visitScope(ctx, stack, sym.name, sym.exported, valueNode);
  else collectCalls(ctx, valueNode, sym.qualifiedName);
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
    const named = right.type === 'identifier' ? right.text : nameOf(right);
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
    const obj = left.childForFieldName('object');
    if ((obj?.type === 'identifier' && obj.text === 'exports') || isModuleExports(obj)) {
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
      if (value?.type === 'identifier') {
        names.add(value.text);
        rows.push(localExport(value.text, 'default', line));
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
    }
  }
  return names;
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
  };
  const diagnostics: ParseDiagnostic[] = [];
  try {
    ctx.exportNames = collectExports(root, ctx.imports);
    const visitChild = (node: Node, type: string, stack: Frame[]): boolean =>
      visit(node, type, ctx, stack);
    // For call nodes `visit` only records the call and walks on.
    const peekCall: Peek = (cursor, type) =>
      CALL_NODES.has(type) && addCallAt(ctx, ctx.owner, cursor, type);
    walkFrames(root.namedChildren, (node, stack) => {
      if (visit(node, node.type, ctx, stack)) {
        const types = ctx.qualifier.length === 0 ? VISITED_TOP : VISITED_MEMBER;
        pushDescendants(stack, node, types, visitChild, peekCall);
      }
    });
  } catch (err) {
    diagnostics.push(internalDiagnostic(err));
  }
  return {
    language,
    symbols: ctx.symbols,
    imports: ctx.imports,
    references: uniqueRefs(ctx.references),
    diagnostics,
  };
}
