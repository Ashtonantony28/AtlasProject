import type Parser from 'tree-sitter';
import type { ParsedReference } from './types.js';

type Node = Parser.SyntaxNode;

/** Calls `onMatch` for every descendant of `node` (inclusive) whose type is in `types`. Comments and plain strings have no such descendants. */
export function forEachOfType(node: Node, types: Set<string>, onMatch: (n: Node) => void): void {
  const cursor = node.walk();
  let depth = 0;
  for (;;) {
    if (types.has(cursor.nodeType)) onMatch(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      if (depth === 0) return;
      if (cursor.gotoNextSibling()) break;
      cursor.gotoParent();
      depth--;
    }
  }
}

/** Keeps the first occurrence of each (from, kind, receiver, object, name). */
export function uniqueRefs(refs: ParsedReference[]): ParsedReference[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.fromQualifiedName}\0${r.kind}\0${r.receiver}\0${r.object}\0${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
