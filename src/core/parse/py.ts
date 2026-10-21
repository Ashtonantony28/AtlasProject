import type Parser from 'tree-sitter';
import type { ParsedImport, ParsedSymbol, ParseResult } from './types.js';

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
}

function qualify(ctx: Ctx, name: string): string {
  return ctx.qualifier.length === 0 ? name : `${ctx.qualifier.join('.')}.${name}`;
}

function visit(node: Node, ctx: Ctx): void {
  if (node.type === 'import_statement' || node.type === 'import_from_statement') {
    collectImports(node, ctx);
    return;
  }

  if (node.type === 'function_definition') {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');
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
        exported: false,
      });
    }
    return; // don't recurse into function bodies
  }

  if (node.type === 'class_definition') {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    if (nameNode) {
      ctx.symbols.push({
        kind: 'class',
        name: nameNode.text,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: docstringOf(body),
        qualifiedName: qualify(ctx, nameNode.text),
        exported: false,
      });
      if (body) {
        ctx.qualifier.push(nameNode.text);
        for (const c of body.namedChildren) visit(c, ctx);
        ctx.qualifier.pop();
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
        exported: false,
      });
    }
  }

  for (const child of node.namedChildren) {
    visit(child, ctx);
  }
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
  const ctx: Ctx = { symbols: [], imports: [], qualifier: [] };
  for (const child of root.namedChildren) {
    visit(child, ctx);
  }
  return { language: 'python', symbols: ctx.symbols, imports: ctx.imports };
}
