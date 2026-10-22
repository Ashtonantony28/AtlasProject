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
  // Something in scope is not in this response: nodes before or after the page,
  // or edges cut by `edgeLimit` (as for drift, true whenever `offset > 0`).
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

/**
 * The graph, or a bounded slice of it: nodes ordered by id, and the edges they
 * own. An edge belongs to the page holding its `src` (its `dst` when `src` is
 * null), so its far endpoint may sit on another page and paging through every
 * node yields every edge in scope exactly once.
 */
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
        : edgesFromRange(db, nodes, q.edgeLimit);
  } else {
    const page = scope.slice(offset, offset + limit);
    totalNodes = scope.length;
    nodes = db
      .prepare(`${NODE_SQL} WHERE s.id IN ${IN_IDS} ORDER BY s.id`)
      .all(JSON.stringify(page)) as GraphNode[];
    const inScope = new Set(scope);
    edgeRows = ownedEdges(db, page, inScope);
    totalEdges =
      page.length === scope.length ? edgeRows.length : ownedEdges(db, scope, inScope).length;
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
    truncated: offset > 0 || offset + nodes.length < totalNodes || edgeRows.length > edgeLimit,
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

const OWNED_BY = (match: string) =>
  `SELECT * FROM edges WHERE src_symbol ${match}
   UNION ALL SELECT * FROM edges WHERE src_symbol IS NULL AND dst_symbol ${match} ORDER BY id`;

/** Edges owned by an unscoped page; its ids are every symbol id from the first to the last. */
function edgesFromRange(db: DB, nodes: GraphNode[], edgeLimit?: number): EdgeRow[] {
  const lo = nodes[0]?.id ?? 0;
  const hi = nodes.at(-1)?.id ?? -1;
  return db
    .prepare(`${OWNED_BY('BETWEEN ? AND ?')} LIMIT ?`)
    .all(lo, hi, lo, hi, edgeLimit === undefined ? -1 : edgeLimit + 1) as EdgeRow[];
}

/** Edges owned by `owners` whose non-null endpoints are all in `scope`, ordered by id. */
function ownedEdges(db: DB, owners: number[], scope: Set<number>): EdgeRow[] {
  if (owners.length === 0) return [];
  const json = JSON.stringify(owners);
  const rows = db.prepare(OWNED_BY(`IN ${IN_IDS}`)).all(json, json) as EdgeRow[];
  return rows.filter(
    (e) =>
      (e.src_symbol === null || scope.has(e.src_symbol)) &&
      (e.dst_symbol === null || scope.has(e.dst_symbol)),
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
