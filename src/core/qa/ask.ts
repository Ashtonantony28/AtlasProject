import type { DB } from '../db/index.js';
import { ASK_MAX_TOKENS, incompleteReason, type LLMClient } from '../synth/index.js';
import { checkCitations, type CitationCheck } from './citations.js';
import { retrieve, type RetrievedSnippet } from './retrieve.js';

const SYSTEM = `You are a careful, code-aware assistant answering questions about a specific codebase.

You will receive the user's question and a set of grounded snippets in this format:
  [1] kind: name (file:start-end)
  <code>

Rules:
  - Answer ONLY using the snippets provided.
  - Every claim about the code must include a citation in the form (file:line) or [n] referencing a snippet.
  - Only cite snippet numbers and line ranges that appear in the snippets.
  - If the answer is not derivable from the snippets, say so plainly.
  - Be concise.`;

export interface AskOptions {
  seedLimit?: number;
  expansionLimit?: number;
  maxTokens?: number;
  excerptLines?: number;
}

export interface Citation {
  index: number;
  file: string;
  startLine: number;
  endLine: number;
  symbol: string;
  kind: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  /** Every `[n]` / `file:line` reference parsed from the answer, in order of appearance. */
  checks: CitationCheck[];
  /** The subset of `checks` that falls outside the retrieved snippets. */
  flagged: CitationCheck[];
  inputTokens: number;
  outputTokens: number;
  snippets: RetrievedSnippet[];
}

export async function ask(
  db: DB,
  llm: LLMClient,
  root: string,
  question: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const { snippets, changed } = await retrieve(db, root, question, {
    ...(opts.seedLimit !== undefined ? { seedLimit: opts.seedLimit } : {}),
    ...(opts.expansionLimit !== undefined ? { expansionLimit: opts.expansionLimit } : {}),
    ...(opts.excerptLines !== undefined ? { excerptLines: opts.excerptLines } : {}),
  });
  const citations: Citation[] = snippets.map((s, i) => ({
    index: i + 1,
    file: s.file.path,
    startLine: s.startLine,
    endLine: s.endLine,
    symbol: s.symbol.qualified_name ?? s.symbol.name,
    kind: s.symbol.kind,
  }));

  const prompt = buildPrompt(question, snippets);
  const res = await llm.complete({
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: opts.maxTokens ?? ASK_MAX_TOKENS,
  });
  const reason = incompleteReason(res);
  if (reason) throw new Error(`no answer: the model returned an incomplete response (${reason})`);

  const checks = checkCitations(res.content, citations);
  return {
    answer: changed.length > 0 ? `${res.content}\n\n${changedNote(changed)}` : res.content,
    citations,
    checks,
    flagged: checks.filter((c) => !c.valid),
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    snippets,
  };
}

function changedNote(paths: string[]): string {
  const its = paths.length === 1 ? 'its' : 'their';
  return `Note: ${paths.join(', ')} changed since indexing, so ${its} snippets were left out; run \`atlas index\`.`;
}

function buildPrompt(question: string, snippets: RetrievedSnippet[]): string {
  const lines: string[] = [];
  lines.push(`Question: ${question}`);
  lines.push('');
  lines.push('Grounded snippets:');
  snippets.forEach((s, i) => {
    const idx = i + 1;
    lines.push('');
    lines.push(
      `[${idx}] ${s.symbol.kind}: ${s.symbol.qualified_name ?? s.symbol.name} (${s.file.path}:${s.startLine}-${s.endLine})`,
    );
    lines.push('```');
    lines.push(s.excerpt);
    lines.push('```');
  });
  lines.push('');
  lines.push('Now answer the question. Cite each fact with [n] or (file:line).');
  return lines.join('\n');
}
