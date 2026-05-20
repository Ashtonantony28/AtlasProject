// Map file extensions to canonical language identifiers used in the index.

export type LanguageId = 'typescript' | 'javascript' | 'python';

const EXT_TO_LANG: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
};

export function detectLanguage(filename: string): LanguageId | null {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  return EXT_TO_LANG[ext] ?? null;
}

export function isSupported(filename: string): boolean {
  return detectLanguage(filename) !== null;
}
