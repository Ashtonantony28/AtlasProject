import type { DB, EdgeRow } from '../db/index.js';

export type GraphFormat = 'json' | 'dot';

export interface GraphNode {
  id: number;
  name: string;
  kind: string;
  file: string;
  qualifiedName: string | null;
  startLine: number;
  endLine: number;
}

export interface GraphEdge {
  src: number | null;
  dst: number | null;
  kind: string;
  weak: boolean;
  meta?: unknown;
}

export interface GraphJson {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Nodes and edges in scope before `offset`/`limit`/`edgeLimit`.
  totals: { nodes: number; edges: number };
  // More nodes follow this page, or edges among these nodes were cut by `edgeLimit`.
  truncated: boolean;
}

export interface GraphQuery {
  // Only symbols in files whose path contains this substring.
  file?: string;
  // Only the neighbourhood (`depth` hops over edges, either direction) of
  // symbols with this name or qualified name.
  symbol?: string;
  depth?: number;
  // Undefined: everything.
  limit?: number;
  edgeLimit?: number;
  offset?: number;
}

const NODE_SQL = `SELECT s.id, s.name, s.kind, COALESCE(f.path, '') AS file,
  s.qualified_name AS qualifiedName, s.start_line AS startLine, s.end_line AS endLine
  FROM symbols s LEFT JOIN files f ON f.id = s.file_id`;
const IN_IDS = '(SELECT value FROM json_each(?))';

/** The graph, or a bounded slice of it: nodes ordered by id, edges among them. */
export function buildGraphJson(db: DB, q: GraphQuery = {}): GraphJson {
  const offset = q.offset ?? 0;
  const limit = q.limit ?? Number.MAX_SAFE_INTEGER;
  const edgeLimit = q.edgeLimit ?? Number.MAX_SAFE_INTEGER;
  const scope = scopeIds(db, q);

  let nodes: GraphNode[];
  let totalNodes: number;
  let totalEdges: number;
  let edgeRows: EdgeRow[];
  if (scope === null) {
    totalNodes = count(db, 'SELECT COUNT(*) FROM symbols');
    totalEdges = count(db, 'SELECT COUNT(*) FROM edges');
    nodes = db
      .prepare(`${NODE_SQL} ORDER BY s.id LIMIT ? OFFSET ?`)
      .all(Math.min(limit, totalNodes), offset) as GraphNode[];
    edgeRows =
      offset === 0 && nodes.length === totalNodes
        ? (db
            .prepare('SELECT * FROM edges ORDER BY id LIMIT ?')
            .all(q.edgeLimit === undefined ? -1 : q.edgeLimit + 1) as EdgeRow[])
        : edgesWithin(
            db,
            nodes.map((n) => n.id),
          );
  } else {
    const page = scope.slice(offset, offset + limit);
    totalNodes = scope.length;
    nodes = db
      .prepare(`${NODE_SQL} WHERE s.id IN ${IN_IDS} ORDER BY s.id`)
      .all(JSON.stringify(page)) as GraphNode[];
    edgeRows = edgesWithin(db, page);
    totalEdges = page.length === scope.length ? edgeRows.length : edgesWithin(db, scope).length;
  }

  const edges = edgeRows.slice(0, edgeLimit).map((e) => ({
    src: e.src_symbol,
    dst: e.dst_symbol,
    kind: e.kind,
    weak: e.weak === 1,
    meta: e.meta ? safeParse(e.meta) : undefined,
  }));
  return {
    nodes,
    edges,
    totals: { nodes: totalNodes, edges: totalEdges },
    truncated: offset + nodes.length < totalNodes || edgeRows.length > edgeLimit,
  };
}

function count(db: DB, sql: string): number {
  return db.prepare(sql).pluck().get() as number;
}

/** Sorted symbol ids in scope, or null for the whole graph. */
function scopeIds(db: DB, q: GraphQuery): number[] | null {
  let ids: number[] | null = null;
  if (q.symbol) ids = neighbourhood(db, q.symbol, q.depth ?? 1);
  if (q.file) {
    const inFiles = db
      .prepare(
        'SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE instr(f.path, ?) > 0',
      )
      .pluck()
      .all(q.file) as number[];
    if (ids === null) ids = inFiles;
    else {
      const keep = new Set(inFiles);
      ids = ids.filter((id) => keep.has(id));
    }
  }
  return ids === null ? null : ids.sort((a, b) => a - b);
}

function neighbourhood(db: DB, symbol: string, depth: number): number[] {
  const seen = new Set(
    db
      .prepare('SELECT id FROM symbols WHERE name = ? OR qualified_name = ?')
      .pluck()
      .all(symbol, symbol) as number[],
  );
  const adjacent = db.prepare(
    `SELECT dst_symbol FROM edges WHERE src_symbol IN ${IN_IDS} AND dst_symbol IS NOT NULL
     UNION SELECT src_symbol FROM edges WHERE dst_symbol IN ${IN_IDS} AND src_symbol IS NOT NULL`,
  );
  let frontier = [...seen];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const ids = JSON.stringify(frontier);
    frontier = (adjacent.pluck().all(ids, ids) as number[]).filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }
  return [...seen];
}

/** Edges whose non-null endpoints are all in `ids`, ordered by id. */
function edgesWithin(db: DB, ids: number[]): EdgeRow[] {
  if (ids.length === 0) return [];
  const set = new Set(ids);
  const json = JSON.stringify(ids);
  const rows = db
    .prepare(
      `SELECT * FROM edges WHERE src_symbol IN ${IN_IDS}
       UNION SELECT * FROM edges WHERE dst_symbol IN ${IN_IDS} ORDER BY id`,
    )
    .all(json, json) as EdgeRow[];
  return rows.filter(
    (e) =>
      (e.src_symbol === null || set.has(e.src_symbol)) &&
      (e.dst_symbol === null || set.has(e.dst_symbol)),
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function buildGraphDot(db: DB, q: GraphQuery = {}): string {
  return graphToDot(buildGraphJson(db, q));
}

export function graphToDot(json: GraphJson): string {
  const lines: string[] = [];
  lines.push('digraph Atlas {');
  if (json.truncated) {
    lines.push(
      `  // truncated: ${json.nodes.length} of ${json.totals.nodes} nodes, ${json.edges.length} of ${json.totals.edges} edges`,
    );
  }
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
