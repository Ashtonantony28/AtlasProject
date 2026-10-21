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
  uniqueRefs,
  walkFrames,
  type Frame,
} from './refs.js';

type Node = Parser.SyntaxNode;

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

const CALL_NODES = new Set(['call_expression', 'new_expression']);
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
  const callee =
    call.type === 'new_expression'
      ? call.childForFieldName('constructor')
      : call.childForFieldName('function');
  addRef(ctx, from, callee, 'calls', call);
}

function collectCalls(ctx: Ctx, node: Node | null, from: string | null): void {
  if (node) forEachOfType(node, CALL_NODES, (c) => addCall(ctx, from, c));
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

function visit(node: Node, ctx: Ctx, stack: Frame[]): void {
  // ESM imports
  if (node.type === 'import_statement') {
    collectImports(node, ctx);
  }

  // CommonJS require() — only at top level to avoid noise from dynamic requires
  // inside functions. Express, older Node libs, etc.
  if (
    (node.type === 'lexical_declaration' || node.type === 'variable_declaration') &&
    ctx.qualifier.length === 0
  ) {
    collectRequires(node, ctx);
  }

  // Functions — do not descend into function bodies, locals are not symbols.
  if (FN_NODES.has(node.type)) {
    const name = nameOf(node);
    const sym = name ? push(ctx, 'function', name, node) : null;
    collectCalls(ctx, node, sym?.qualifiedName ?? ctx.owner);
    return;
  }

  if (CLASS_NODES.has(node.type) || INTERFACE_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      const sym = push(ctx, CLASS_NODES.has(node.type) ? 'class' : 'interface', name, node);
      collectHeritage(ctx, node, sym.qualifiedName ?? name);
      visitScope(ctx, stack, name, sym.exported, node.childForFieldName('body'));
      return;
    }
  }

  if (node.type === 'call_expression' || node.type === 'new_expression') {
    addCall(ctx, ctx.owner, node);
  }

  if (ctx.qualifier.length === 0) {
    const value = node.type === 'export_statement' ? node.childForFieldName('value') : null;
    const scope =
      value?.type === 'object'
        ? 'default'
        : node.type === 'assignment_expression'
          ? cjsObjectScope(node)
          : null;
    if (scope) {
      visitScope(ctx, stack, scope, true, value ?? node.childForFieldName('right'));
      return;
    }
  }

  // Type aliases & enums; object-type members are qualified like interface members.
  if (TYPE_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      const sym = push(ctx, 'type', name, node);
      const value = node.childForFieldName('value');
      if (value?.type === 'object_type') visitScope(ctx, stack, name, sym.exported, value);
    }
    return;
  }

  // Methods — don't descend.
  if (METHOD_NODES.has(node.type)) {
    const name = nameOf(node);
    const sym = name ? push(ctx, 'method', name, node) : null;
    collectCalls(ctx, node, sym?.qualifiedName ?? ctx.owner);
    return;
  }

  if (ctx.qualifier.length > 0) {
    // Function-typed interface properties: `onDraw: () => void`.
    if (node.type === 'property_signature') {
      const name = nameOf(node);
      const type = node.childForFieldName('type')?.namedChildren[0];
      if (name && type?.type === 'function_type') push(ctx, 'method', name, node);
      return;
    }
    // Class fields holding functions: `handle = () => {}`.
    if (FIELD_NODES.has(node.type)) {
      const name = (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text;
      const value = node.childForFieldName('value');
      const fn =
        name && value && FN_VALUES.has(value.type) ? push(ctx, 'method', name, node) : null;
      collectCalls(ctx, value, fn?.qualifiedName ?? ctx.owner);
      return;
    }
    // Object-literal properties holding functions: `{ arrow: () => 2 }`.
    if (node.type === 'pair') {
      const key = node.childForFieldName('key');
      const value = node.childForFieldName('value');
      const fn =
        key && value && FN_VALUES.has(value.type)
          ? push(ctx, 'method', trimQuotes(key.text), node)
          : null;
      collectCalls(ctx, value, fn?.qualifiedName ?? ctx.owner);
      return;
    }
  }

  // Top-level lexical declarations (const/let/var). We only record top-level
  // (ctx.qualifier empty) to avoid noise from local variables.
  if (
    (node.type === 'lexical_declaration' || node.type === 'variable_declaration') &&
    ctx.qualifier.length === 0
  ) {
    // Declarators are deferred so each object scope is walked before the next declarator.
    const decls = node.namedChildren.filter((d) => d.type === 'variable_declarator');
    for (let i = decls.length - 1; i >= 0; i--) {
      const decl = decls[i] as Node;
      stack.push(() => visitDeclarator(ctx, stack, node, decl));
    }
    return;
  }

  // Recurse for children unless we already short-circuited.
  pushAll(stack, node.namedChildren);
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

function collectCjsExports(first: Node, names: Set<string>): void {
  // `a = b = c` chains nest to the right; walked as a loop.
  for (let assign: Node | null = first; assign; ) {
    assign = collectCjsExport(assign, names);
  }
}

/** Records one assignment's export names; returns the chained right-hand assignment, if any. */
function collectCjsExport(assign: Node, names: Set<string>): Node | null {
  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');
  if (!left || !right) return null;
  if (isModuleExports(left)) {
    if (right.type === 'identifier') names.add(right.text);
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
    }
  }
  return right.type === 'assignment_expression' ? right : null;
}

function collectExportNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type === 'export_statement' && !node.childForFieldName('source')) {
      const value = node.childForFieldName('value');
      if (value?.type === 'identifier') names.add(value.text);
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      for (const spec of clause?.namedChildren ?? []) {
        const name = spec.type === 'export_specifier' ? spec.childForFieldName('name') : null;
        if (name) names.add(name.text);
      }
    } else if (node.type === 'expression_statement') {
      const expr = node.namedChildren[0];
      if (expr?.type === 'assignment_expression') collectCjsExports(expr, names);
    }
  }
  return names;
}

function collectImports(node: Node, ctx: Ctx): void {
  // `import_statement` has shape:
  //   import <import_clause>? from <string>;
  // import_clause may contain named_imports / namespace_import / identifier (default).
  const src = node.childForFieldName('source');
  const moduleStr = src ? trimQuotes(src.text) : null;
  if (!moduleStr) return;
  const line = lineOf(node);

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
    ctx.exportNames = collectExportNames(root);
    walkFrames(root.namedChildren, (node, stack) => visit(node, ctx, stack));
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
