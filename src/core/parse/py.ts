import type Parser from 'tree-sitter';
import type {
  ParseDiagnostic,
  ParsedImport,
  ParsedReference,
  ParsedSymbol,
  ParseResult,
  RefKind,
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

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

function signatureFor(node: Node): string {
  const first = node.text.split('\n', 1)[0] ?? '';
  return first.trim().slice(0, 240);
}

/** Python docstring: a string literal that's the first statement of a function/class/module body. */
function docstringOf(bodyNode: Node | null): string | null {
  if (!bodyNode) return null;
  const first = bodyNode.namedChildren[0];
  if (!first) return null;
  if (first.type !== 'expression_statement') return null;
  const inner = first.namedChildren[0];
  if (!inner) return null;
  if (inner.type !== 'string') return null;
  // Strip quotes
  return cleanPyString(inner.text);
}

function cleanPyString(s: string): string {
  let str = s;
  // Strip leading prefix like r, b, u
  str = str.replace(/^[rRbBuU]+/, '');
  if (str.startsWith('"""') && str.endsWith('"""')) return str.slice(3, -3).trim();
  if (str.startsWith("'''") && str.endsWith("'''")) return str.slice(3, -3).trim();
  if (str.startsWith('"') && str.endsWith('"')) return str.slice(1, -1).trim();
  if (str.startsWith("'") && str.endsWith("'")) return str.slice(1, -1).trim();
  return str.trim();
}

interface Ctx {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  qualifier: string[];
  all: Set<string> | null; // literal `__all__`, authoritative for top-level names
  scopeExported: boolean; // exported flag of the enclosing class
  references: ParsedReference[];
  owner: string | null; // qualified name references are attributed to; null = module
}

const CALL_NODES = new Set(['call']);

/** `a`, `a.b.c` for identifier chains; null for anything computed. */
function dotted(node: Node): string | null {
  const parts: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === 'attribute') {
    const attr = cur.childForFieldName('attribute');
    if (!attr) return null;
    parts.push(attr.text);
    cur = cur.childForFieldName('object');
  }
  if (cur?.type !== 'identifier') return null;
  parts.push(cur.text);
  return parts.reverse().join('.');
}

function addRef(ctx: Ctx, from: string | null, node: Node | null, kind: RefKind): void {
  if (!node) return;
  const base = { fromQualifiedName: from, kind, line: lineOf(node) };
  if (node.type === 'identifier') {
    ctx.references.push({ ...base, name: node.text, receiver: 'none', object: null });
    return;
  }
  const obj = node.type === 'attribute' ? node.childForFieldName('object') : null;
  const attr = node.childForFieldName('attribute');
  if (!obj || !attr) return;
  const name = attr.text;
  if (obj.type === 'identifier' && (obj.text === 'self' || obj.text === 'cls')) {
    ctx.references.push({ ...base, name, receiver: 'this', object: null });
  } else if (obj.type === 'call' && obj.childForFieldName('function')?.text === 'super') {
    ctx.references.push({ ...base, name, receiver: 'super', object: null });
  } else {
    ctx.references.push({ ...base, name, receiver: 'member', object: dotted(obj) });
  }
}

function collectCalls(ctx: Ctx, node: Node | null, from: string | null): void {
  if (node)
    forEachOfType(node, CALL_NODES, (c) =>
      addRef(ctx, from, c.childForFieldName('function'), 'calls'),
    );
}

function isExported(ctx: Ctx, name: string): boolean {
  if (ctx.qualifier.length > 0) return ctx.scopeExported && !name.startsWith('_');
  return ctx.all ? ctx.all.has(name) : !name.startsWith('_');
}

/** Names in a top-level `__all__ = [...]` / `(...)` made only of string literals; null otherwise. */
function literalAll(root: Node): Set<string> | null {
  let names: Set<string> | null = null;
  for (const stmt of root.namedChildren) {
    const assign = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : null;
    if (assign?.type !== 'assignment' || assign.childForFieldName('left')?.text !== '__all__')
      continue;
    const right = assign.childForFieldName('right');
    if (!right || (right.type !== 'list' && right.type !== 'tuple')) return null;
    if (right.namedChildren.some((c) => c.type !== 'string')) return null;
    names = new Set(right.namedChildren.map((c) => cleanPyString(c.text)));
  }
  return names;
}

function qualify(ctx: Ctx, name: string): string {
  return ctx.qualifier.length === 0 ? name : `${ctx.qualifier.join('.')}.${name}`;
}

function visit(node: Node, ctx: Ctx, stack: Frame[]): void {
  if (node.type === 'import_statement' || node.type === 'import_from_statement') {
    collectImports(node, ctx);
    return;
  }

  if (node.type === 'function_definition') {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    if (nameNode) collectCalls(ctx, node, qualify(ctx, nameNode.text));
    else collectCalls(ctx, node, ctx.owner);
    if (nameNode) {
      const isMethod = ctx.qualifier.length > 0;
      ctx.symbols.push({
        kind: isMethod ? 'method' : 'function',
        name: nameNode.text,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: docstringOf(body),
        qualifiedName: qualify(ctx, nameNode.text),
        exported: isExported(ctx, nameNode.text),
      });
    }
    return; // don't recurse into function bodies
  }

  if (node.type === 'class_definition') {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    if (nameNode) {
      const exported = isExported(ctx, nameNode.text);
      ctx.symbols.push({
        kind: 'class',
        name: nameNode.text,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: docstringOf(body),
        qualifiedName: qualify(ctx, nameNode.text),
        exported,
      });
      const qname = qualify(ctx, nameNode.text);
      for (const base of node.childForFieldName('superclasses')?.namedChildren ?? []) {
        addRef(ctx, qname, base, 'extends');
      }
      if (body) {
        const saved = { scopeExported: ctx.scopeExported, owner: ctx.owner };
        ctx.qualifier.push(nameNode.text);
        ctx.scopeExported = exported;
        ctx.owner = qname;
        stack.push(() => {
          ctx.qualifier.pop();
          Object.assign(ctx, saved);
        });
        pushAll(stack, body.namedChildren);
      }
    }
    return;
  }

  // Top-level assignments capture as variables.
  if (node.type === 'assignment' && ctx.qualifier.length === 0) {
    const left = node.childForFieldName('left');
    if (left && left.type === 'identifier') {
      ctx.symbols.push({
        kind: 'variable',
        name: left.text,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: null,
        qualifiedName: qualify(ctx, left.text),
        exported: isExported(ctx, left.text),
      });
      const right = node.childForFieldName('right');
      if (right?.type === 'assignment') stack.push(right);
      else collectCalls(ctx, right, left.text);
      return;
    }
  }

  if (node.type === 'call') addRef(ctx, ctx.owner, node.childForFieldName('function'), 'calls');

  pushAll(stack, node.namedChildren);
}

function collectImports(node: Node, ctx: Ctx): void {
  const line = lineOf(node);
  if (node.type === 'import_statement') {
    // import a, b as c
    for (const c of node.namedChildren) {
      if (c.type === 'dotted_name') {
        ctx.imports.push({ module: c.text, imported: null, alias: null, line });
      } else if (c.type === 'aliased_import') {
        const nameNode = c.childForFieldName('name');
        const aliasNode = c.childForFieldName('alias');
        if (nameNode) {
          ctx.imports.push({
            module: nameNode.text,
            imported: null,
            alias: aliasNode?.text ?? null,
            line,
          });
        }
      }
    }
    return;
  }

  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    const moduleName = moduleNode?.text ?? '';
    if (!moduleName) return;
    // Subsequent children are imported names.
    for (const c of node.namedChildren) {
      if (c === moduleNode) continue;
      if (c.type === 'dotted_name' || c.type === 'identifier') {
        ctx.imports.push({ module: moduleName, imported: c.text, alias: null, line });
      } else if (c.type === 'aliased_import') {
        const nameNode = c.childForFieldName('name');
        const aliasNode = c.childForFieldName('alias');
        if (nameNode) {
          ctx.imports.push({
            module: moduleName,
            imported: nameNode.text,
            alias: aliasNode?.text ?? null,
            line,
          });
        }
      } else if (c.type === 'wildcard_import') {
        ctx.imports.push({ module: moduleName, imported: '*', alias: null, line });
      }
    }
  }
}

export function parsePython(root: Node): ParseResult {
  const ctx: Ctx = {
    symbols: [],
    imports: [],
    qualifier: [],
    all: null,
    scopeExported: false,
    references: [],
    owner: null,
  };
  const diagnostics: ParseDiagnostic[] = [];
  try {
    ctx.all = literalAll(root);
    walkFrames(root.namedChildren, (node, stack) => visit(node, ctx, stack));
  } catch (err) {
    diagnostics.push(internalDiagnostic(err));
  }
  return {
    language: 'python',
    symbols: ctx.symbols,
    imports: ctx.imports,
    references: uniqueRefs(ctx.references),
    diagnostics,
  };
}
