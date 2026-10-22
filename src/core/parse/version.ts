/**
 * Version of what the extractors store (symbols, imports, references). Bump it in any change
 * that alters `parseSource` output for the same source (test/parse/golden.test.ts enforces this
 * for the fixtures): the next `atlas index` on an index written by another version re-parses
 * every file, without `--force`.
 */
export const EXTRACTOR_VERSION = 3;
