import type { Citation } from './ask.js';

export type CitationFlag = 'unknown-snippet' | 'unknown-file' | 'out-of-range';

export interface CitationCheck {
  raw: string;
  kind: 'snippet' | 'location';
  index: number | null;
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  valid: boolean;
  reason: CitationFlag | null;
}

// `[n]` not preceded by an identifier/bracket (skips `arr[3]`) and not a markdown link label;
// `path.ext:line` or `path.ext:start-end` not preceded by `/` or `:` (skips URLs).
const CITATION_RE =
  /(?<![\w\]])\[(\d+)\](?!\()|(?<![\w/:.-])((?:\.\/)?[\w-][\w./-]*\.[A-Za-z]\w*):(\d+)(?:-(\d+))?\b/g;

export function checkCitations(answer: string, citations: Citation[]): CitationCheck[] {
  const out: CitationCheck[] = [];
  const seen = new Set<string>();
  for (const m of answer.matchAll(CITATION_RE)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (m[1] !== undefined) {
      const index = Number(m[1]);
      const ok = citations.some((c) => c.index === index);
      out.push({
        raw,
        kind: 'snippet',
        index,
        file: null,
        startLine: null,
        endLine: null,
        valid: ok,
        reason: ok ? null : 'unknown-snippet',
      });
      continue;
    }
    const cited = (m[2] ?? '').replace(/^\.\//, '');
    const startLine = Number(m[3]);
    const endLine = m[4] !== undefined ? Number(m[4]) : startLine;
    const sameFile = citations.filter((c) => c.file === cited || c.file.endsWith(`/${cited}`));
    const covering = sameFile.find(
      (c) => startLine <= endLine && c.startLine <= startLine && endLine <= c.endLine,
    );
    const reason: CitationFlag | null =
      sameFile.length === 0 ? 'unknown-file' : covering ? null : 'out-of-range';
    out.push({
      raw,
      kind: 'location',
      index: null,
      file: (covering ?? sameFile[0])?.file ?? cited,
      startLine,
      endLine,
      valid: reason === null,
      reason,
    });
  }
  return out;
}
