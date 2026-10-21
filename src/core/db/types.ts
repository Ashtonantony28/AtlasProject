export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'module';

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'implements' | 'references';

export interface FileRow {
  id: number;
  path: string;
  language: string;
  content_hash: string;
  loc: number;
  indexed_at: string;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  kind: SymbolKind;
  name: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  docstring: string | null;
  qualified_name: string | null;
  exported: number;
}

export interface EdgeRow {
  id: number;
  src_symbol: number | null;
  dst_symbol: number | null;
  kind: EdgeKind;
  weak: number;
  meta: string | null;
}

export interface ImportRow {
  id: number;
  file_id: number;
  module: string;
  imported: string | null;
  alias: string | null;
  start_line: number;
}

export interface DocRow {
  id: number;
  target_kind: string;
  target_id: number;
  content: string;
  source_hash: string;
  generated_at: string;
}

export interface RunRow {
  id: number;
  commit_sha: string | null;
  started_at: string;
  finished_at: string | null;
  stats_json: string | null;
}
