import type Parser from 'tree-sitter';
import type { ParseDiagnostic, ParsedReference } from './types.js';

type Node = Parser.SyntaxNode;

/** A pending CST node, or a scope restore to run once that scope's nodes are done. */
export type Frame = Node | (() => void);

/** Pushes `nodes` so they pop in source order. */
export function pushAll(stack: Frame[], nodes: Node[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i] as Node);
}

/** Depth-safe pre-order walk: `visit` pushes whatever it wants walked next onto the stack. */
export function walkFrames(roots: Node[], visit: (node: Node, stack: Frame[]) => void): void {
  const stack: Frame[] = [];
  pushAll(stack, roots);
  for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
    if (typeof f === 'function') f();
    else visit(f, stack);
  }
}

export const MAX_SYNTAX_DIAGNOSTICS = 20;

/** ERROR and MISSING nodes, capped; subtrees without errors are skipped. */
export function syntaxDiagnostics(root: Node): ParseDiagnostic[] {
  if (!root.hasError) return [];
  const out: ParseDiagnostic[] = [];
  let total = 0;
  const cursor = root.walk();
  let depth = 0;
  for (;;) {
    const isError = cursor.nodeType === 'ERROR';
    if (isError || cursor.nodeIsMissing) {
      total++;
      if (out.length < MAX_SYNTAX_DIAGNOSTICS) {
        const line = cursor.startPosition.row + 1;
        const message = isError
          ? `syntax error near ${JSON.stringify(snippet(cursor.currentNode.text))}`
          : `missing ${JSON.stringify(cursor.nodeType)}`;
        out.push({ line, message, severity: 'error' });
      }
    }
    if (!isError && cursor.currentNode.hasError && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      if (depth === 0) {
        if (total > out.length) {
          out.push({
            line: out[out.length - 1]?.line ?? 1,
            message: `${total - out.length} more syntax errors not reported`,
            severity: 'warning',
          });
        }
        return out;
      }
      if (cursor.gotoNextSibling()) break;
      cursor.gotoParent();
      depth--;
    }
  }
}

function snippet(text: string): string {
  const first = (text.split('\n', 1)[0] ?? '').trim();
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** Last-resort diagnostic for an exception caught inside the parser. */
export function internalDiagnostic(err: unknown): ParseDiagnostic {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    line: 1,
    message: `internal parser failure, results are partial (${msg})`,
    severity: 'error',
  };
}

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
