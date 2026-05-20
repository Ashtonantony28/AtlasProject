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
}

export interface ParsedImport {
  module: string;
  imported: string | null; // specific binding (e.g. 'Foo' from `import { Foo }`)
  alias: string | null;
  line: number;
}

export interface ParseResult {
  language: LanguageId;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
}
