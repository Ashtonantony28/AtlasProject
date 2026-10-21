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

type GrammarId = LanguageId | 'tsx';

const cache = new Map<GrammarId, LangBundle>();

async function getBundle(language: GrammarId): Promise<LangBundle> {
  const cached = cache.get(language);
  if (cached) return cached;

  const parser = new Parser();
  let grammar: unknown;
  switch (language) {
    case 'tsx':
    case 'typescript': {
      const mod = (await import('tree-sitter-typescript')) as unknown as {
        default?: { typescript: unknown; tsx: unknown };
        typescript?: unknown;
        tsx?: unknown;
      };
      const root = (mod.default ?? mod) as { typescript: unknown; tsx: unknown };
      grammar = language === 'tsx' ? root.tsx : root.typescript;
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

// tree-sitter's string-input parse path has an internal buffer limit (~32KB on
// the Node bindings) that throws "Invalid argument" on larger files. The
// callback-input path has no such limit, so we always feed chunks instead.
const CHUNK = 8192;

function parseChunked(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) => {
    if (index >= source.length) return '';
    return source.slice(index, index + CHUNK);
  });
}

function grammarFor(language: LanguageId, filename?: string): GrammarId {
  return language === 'typescript' && filename?.toLowerCase().endsWith('.tsx') ? 'tsx' : language;
}

/** `filename` (path or basename) selects a grammar variant, e.g. tsx for `.tsx`. */
export async function parseSource(
  source: string,
  language: LanguageId,
  filename?: string,
): Promise<ParseResult> {
  const { parser } = await getBundle(grammarFor(language, filename));
  const tree = parseChunked(parser, source);
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
