export { EXTRACTOR_VERSION } from './version.js';
export { parseSource, parseSourceOrThrow } from './parser.js';
export type {
  ParseResult,
  ParseDiagnostic,
  ParsedSymbol,
  ParsedImport,
  ParsedReference,
  RefKind,
  RefReceiver,
} from './types.js';
