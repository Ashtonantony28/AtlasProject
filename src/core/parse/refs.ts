import type Parser from 'tree-sitter';
import type { ParseDiagnostic, ParsedReference } from './types.js';

type Node = Parser.SyntaxNode;

/**
 * Handles the node at the cursor without materialising it, leaving the cursor where it was;
 * returns false to have the node materialised and handled as usual instead.
 */
export type Peek = (cursor: Parser.TreeCursor, type: string) => boolean;

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

/**
 * Walks `node`'s named descendants in the order of `pushAll(stack, node.namedChildren)` with a
 * visitor that walks the children of every node whose type is not in `types`; those nodes are
 * passed over by one cursor and never materialised. `visit` gets the others and returns true to
 * have their children walked too.
 */
export function pushDescendants(
  stack: Frame[],
  node: Node,
  types: Set<string>,
  visit: (node: Node, type: string, stack: Frame[]) => boolean,
  peek?: Peek,
): void {
  const cursor = node.walk();
  if (!cursor.gotoFirstChild()) return;
  let depth = 1;
  const advance = (): boolean => {
    while (!cursor.gotoNextSibling()) {
      cursor.gotoParent();
      if (--depth === 0) return false;
    }
    return true;
  };
  const scan = (): void => {
    for (;;) {
      if (cursor.nodeIsNamed) {
        const type = cursor.nodeType;
        if (types.has(type) && !peek?.(cursor, type)) {
          const current = cursor.currentNode;
          stack.push(resume);
          if (!visit(current, type, stack)) return;
          if (stack[stack.length - 1] !== resume) {
            // `visit` queued frames of its own: its children go first, on a cursor of their own.
            pushDescendants(stack, current, types, visit, peek);
            return;
          }
          stack.pop();
        }
        if (cursor.gotoFirstChild()) {
          depth++;
          continue;
        }
      }
      if (!advance()) return;
    }
  };
  const resume = (): void => {
    if (advance()) scan();
  };
  stack.push(scan);
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

// `descendantsOfType` matches type names against every grammar symbol first (about 20 µs a
// call); a JS cursor costs about 0.5 µs a node, so small subtrees are walked in JS. Matches found
// natively are materialised, and with value nodes (SG18) there are many, so the cut-off is high.
const NATIVE_MIN_DESCENDANTS = 500;

/** Calls `onMatch` for every descendant of `node` (inclusive) whose type is in `types`, in pre-order. Comments and plain strings have no such descendants. */
export function forEachOfType(
  node: Node,
  types: Set<string>,
  onMatch: (n: Node) => void,
  peek?: Peek,
): void {
  if (node.descendantCount > NATIVE_MIN_DESCENDANTS) {
    for (const n of node.descendantsOfType([...types])) onMatch(n);
    return;
  }
  const cursor = node.walk();
  let depth = 0;
  for (;;) {
    const type = cursor.nodeType;
    if (types.has(type) && !peek?.(cursor, type)) onMatch(cursor.currentNode);
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

/**
 * Drops `references` refs whose name (or receiver object) is not bound at the top level of the
 * file: the resolver could not resolve them, and most are locals and parameters.
 */
export function boundValueRefs(refs: ParsedReference[], bound: Set<string>): ParsedReference[] {
  return refs.filter((r) => {
    if (r.kind !== 'references' || r.receiver === 'this' || r.receiver === 'super') return true;
    const key = r.receiver === 'none' ? r.name : (r.object ?? '');
    return bound.has(key) || bound.has(key.split('.')[0] as string);
  });
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
