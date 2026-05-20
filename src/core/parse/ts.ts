import type Parser from 'tree-sitter';
import type { LanguageId } from '../ingest/language.js';
import type { ParsedImport, ParsedSymbol, ParseResult } from './types.js';

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
}

function pushSymbol(ctx: Ctx, sym: ParsedSymbol): void {
  ctx.symbols.push(sym);
}

function qualify(ctx: Ctx, name: string): string {
  return ctx.qualifier.length === 0 ? name : `${ctx.qualifier.join('.')}.${name}`;
}

function visit(node: Node, ctx: Ctx): void {
  // Imports
  if (node.type === 'import_statement') {
    collectImports(node, ctx);
  }

  // Functions — do not descend into function bodies, locals are not symbols.
  if (FN_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      pushSymbol(ctx, {
        kind: 'function',
        name,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: extractLeadingComment(node),
        qualifiedName: qualify(ctx, name),
      });
    }
    return;
  }

  // Classes
  if (CLASS_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      pushSymbol(ctx, {
        kind: 'class',
        name,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: extractLeadingComment(node),
        qualifiedName: qualify(ctx, name),
      });
      // Descend into the body with the class as qualifier so methods get a path.
      const body = node.childForFieldName('body');
      if (body) {
        ctx.qualifier.push(name);
        for (const c of body.namedChildren) visit(c, ctx);
        ctx.qualifier.pop();
      }
      return; // don't double-descend
    }
  }

  // Interfaces
  if (INTERFACE_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      pushSymbol(ctx, {
        kind: 'interface',
        name,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: extractLeadingComment(node),
        qualifiedName: qualify(ctx, name),
      });
    }
  }

  // Type aliases & enums
  if (TYPE_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      pushSymbol(ctx, {
        kind: 'type',
        name,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: extractLeadingComment(node),
        qualifiedName: qualify(ctx, name),
      });
    }
  }

  // Methods (only when we're inside a class qualifier) — don't descend.
  if (METHOD_NODES.has(node.type)) {
    const name = nameOf(node);
    if (name) {
      pushSymbol(ctx, {
        kind: 'method',
        name,
        signature: signatureFor(node),
        startLine: lineOf(node),
        endLine: endLine(node),
        docstring: extractLeadingComment(node),
        qualifiedName: qualify(ctx, name),
      });
    }
    return;
  }

  // Top-level lexical declarations (const/let/var). We only record top-level
  // (ctx.qualifier empty) to avoid noise from local variables.
  if (
    (node.type === 'lexical_declaration' || node.type === 'variable_declaration') &&
    ctx.qualifier.length === 0
  ) {
    for (const decl of node.namedChildren) {
      if (decl.type !== 'variable_declarator') continue;
      const nameNode = decl.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      // Skip if the value is a function/arrow — we already capture those by name above
      // via function_declaration. But arrow functions assigned to a const are common.
      const valueNode = decl.childForFieldName('value');
      const isFn =
        valueNode &&
        (valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression' ||
          valueNode.type === 'function');
      pushSymbol(ctx, {
        kind: isFn ? 'function' : 'variable',
        name: nameNode.text,
        signature: signatureFor(decl),
        startLine: lineOf(decl),
        endLine: endLine(decl),
        docstring: extractLeadingComment(node),
        qualifiedName: qualify(ctx, nameNode.text),
      });
    }
  }

  // Recurse for children unless we already short-circuited.
  for (const child of node.namedChildren) {
    visit(child, ctx);
  }
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

function trimQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === '`')) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseTsLike(root: Node, language: LanguageId): ParseResult {
  const ctx: Ctx = { symbols: [], imports: [], qualifier: [] };
  for (const child of root.namedChildren) {
    visit(child, ctx);
  }
  return { language, symbols: ctx.symbols, imports: ctx.imports };
}
