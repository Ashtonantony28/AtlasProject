import type { DB } from '../db/index.js';
import type { LLMClient } from '../synth/index.js';
import { retrieveForQuery, type RetrievedSnippet } from './retrieve.js';

const SYSTEM = `You are a careful, code-aware assistant answering questions about a specific codebase.

You will receive the user's question and a set of grounded snippets in this format:
  [1] kind: name (file:start-end)
  <code>

Rules:
  - Answer ONLY using the snippets provided.
  - Every claim about the code must include a citation in the form (file:line) or [n] referencing a snippet.
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
  const snippets = await retrieveForQuery(db, root, question, {
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
    maxTokens: opts.maxTokens ?? 800,
    temperature: 0.1,
  });

  return {
    answer: res.content,
    citations,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    snippets,
  };
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
