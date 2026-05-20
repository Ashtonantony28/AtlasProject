import {
  type DB,
  getAllEdges,
  getAllSymbols,
  getAllFiles,
} from '../db/index.js';

export type GraphFormat = 'json' | 'dot';

export interface GraphJson {
  nodes: Array<{
    id: number;
    name: string;
    kind: string;
    file: string;
    qualifiedName: string | null;
    startLine: number;
    endLine: number;
  }>;
  edges: Array<{
    src: number | null;
    dst: number | null;
    kind: string;
    weak: boolean;
    meta?: unknown;
  }>;
}

export function buildGraphJson(db: DB): GraphJson {
  const files = new Map(getAllFiles(db).map((f) => [f.id, f]));
  const symbols = getAllSymbols(db);
  const edges = getAllEdges(db);

  const nodes = symbols.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    file: files.get(s.file_id)?.path ?? '',
    qualifiedName: s.qualified_name,
    startLine: s.start_line,
    endLine: s.end_line,
  }));

  const e = edges.map((edge) => ({
    src: edge.src_symbol,
    dst: edge.dst_symbol,
    kind: edge.kind,
    weak: edge.weak === 1,
    meta: edge.meta ? safeParse(edge.meta) : undefined,
  }));

  return { nodes, edges: e };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function buildGraphDot(db: DB): string {
  const json = buildGraphJson(db);
  const lines: string[] = [];
  lines.push('digraph Atlas {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, fontname="Helvetica"];');
  for (const n of json.nodes) {
    const label = escapeDot(`${n.kind}: ${n.qualifiedName ?? n.name}\n${n.file}:${n.startLine}`);
    lines.push(`  n${n.id} [label="${label}"];`);
  }
  for (const e of json.edges) {
    if (e.src === null || e.dst === null) continue;
    const style = e.weak ? ' style=dashed color=gray' : '';
    lines.push(`  n${e.src} -> n${e.dst} [label="${e.kind}"${style}];`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function escapeDot(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
