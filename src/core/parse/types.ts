import type { LanguageId } from '../ingest/language.js';
import type { SymbolKind } from '../db/index.js';

export interface ParsedSymbol {
  kind: SymbolKind;
  name: string;
  signature: string | null;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  docstring: string | null;
  qualifiedName: string | null;
  exported: boolean;
}

export interface ParsedImport {
  module: string;
  imported: string | null; // specific binding (e.g. 'Foo' from `import { Foo }`)
  alias: string | null; // local name; for a re-export, the exported name
  line: number;
  // Re-export (`export … from`), or with module '' a local name exported under `alias`.
  reexport?: boolean;
}

export type RefReceiver = 'none' | 'this' | 'super' | 'member';
export type RefKind = 'calls' | 'extends' | 'implements';

/** A call or heritage reference found in the CST, attributed to its enclosing symbol. */
export interface ParsedReference {
  fromQualifiedName: string | null; // null = module level
  name: string;
  receiver: RefReceiver;
  object: string | null; // dotted receiver text for 'member', e.g. `ns` in `ns.f()`
  kind: RefKind;
  line: number;
}

export interface ParseDiagnostic {
  line: number; // 1-based
  message: string;
  severity: 'error' | 'warning';
}

export interface ParseResult {
  language: LanguageId;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  references: ParsedReference[];
  diagnostics: ParseDiagnostic[]; // syntax errors (capped) and internal failures; empty for a clean parse
}
