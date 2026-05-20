import Parser from 'tree-sitter';
import type { LanguageId } from '../ingest/language.js';
import type { ParseResult } from './types.js';
import { parseTsLike } from './ts.js';
import { parsePython } from './py.js';

// tree-sitter grammars don't ship ESM-friendly types; load via dynamic import + assert any.
// We cache parser instances per language since constructing them is non-trivial.

interface LangBundle {
  parser: Parser;
}

const cache = new Map<string, LangBundle>();

async function getBundle(language: LanguageId): Promise<LangBundle> {
  const cached = cache.get(language);
  if (cached) return cached;

  const parser = new Parser();
  let grammar: unknown;
  switch (language) {
    case 'typescript': {
      const mod = (await import('tree-sitter-typescript')) as unknown as {
        default?: { typescript: unknown; tsx: unknown };
        typescript?: unknown;
        tsx?: unknown;
      };
      const root = mod.default ?? mod;
      grammar = (root as { typescript: unknown }).typescript;
      break;
    }
    case 'javascript': {
      const mod = (await import('tree-sitter-javascript')) as unknown as {
        default?: unknown;
      };
      grammar = mod.default ?? mod;
      break;
    }
    case 'python': {
      const mod = (await import('tree-sitter-python')) as unknown as {
        default?: unknown;
      };
      grammar = mod.default ?? mod;
      break;
    }
    default: {
      const exhaustive: never = language;
      throw new Error(`unsupported language: ${String(exhaustive)}`);
    }
  }
  // tree-sitter's setLanguage takes a Language; the grammar module exports one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parser.setLanguage(grammar as any);
  const bundle = { parser };
  cache.set(language, bundle);
  return bundle;
}

export async function parseSource(
  source: string,
  language: LanguageId,
): Promise<ParseResult> {
  const { parser } = await getBundle(language);
  const tree = parser.parse(source);
  switch (language) {
    case 'typescript':
    case 'javascript':
      return parseTsLike(tree.rootNode, language);
    case 'python':
      return parsePython(tree.rootNode);
    default: {
      const exhaustive: never = language;
      throw new Error(`unsupported language: ${String(exhaustive)}`);
    }
  }
}
