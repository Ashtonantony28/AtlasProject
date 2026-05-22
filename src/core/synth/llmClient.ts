// Thin LLM client interface so synthesis + Q&A can run with either the real
// Anthropic SDK or a deterministic fake (used in tests and --offline mode).

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMCallParams {
  system?: string;
  messages: LLMMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface LLMResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMClient {
  readonly model: string;
  complete(params: LLMCallParams): Promise<LLMResult>;
}

/**
 * Anthropic-backed client. Constructed lazily so unit tests don't import the SDK.
 */
export async function createAnthropicClient(model: string): Promise<LLMClient> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Either export it, or pass --offline to use the mock synthesizer.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk.Anthropic ?? sdk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = new Anthropic({ apiKey });
  return {
    model,
    async complete(params: LLMCallParams): Promise<LLMResult> {
      const response = await client.messages.create({
        model,
        max_tokens: params.maxTokens,
        temperature: params.temperature ?? 0.2,
        ...(params.system ? { system: params.system } : {}),
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const text = (response.content ?? [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
      return {
        content: text,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}

/**
 * Offline fake. Echoes a structured summary built from the prompt itself,
 * which is enough to verify the pipeline end-to-end without API spend.
 *
 * Two prompt shapes are recognized:
 *  - synthesis: starts with "Target: ..." — produces a markdown doc.
 *  - Q&A: starts with "Question: ..." — produces an answer that cites the
 *    grounded snippets [n] (file:line) it was given.
 */
export function createOfflineClient(model = 'offline-mock-v1'): LLMClient {
  return {
    model,
    async complete(params: LLMCallParams): Promise<LLMResult> {
      const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
      const body = lastUser?.content ?? '';

      let content: string;
      const qMatch = body.match(/^Question:\s*(.+)$/m);
      if (qMatch) {
        const question = qMatch[1]?.trim() ?? '';
        // Find snippet headers: "[n] kind: name (file:start-end)"
        const snippetRefs = [
          ...body.matchAll(
            /\[(\d+)\]\s+\w+:\s+([\w.$/-]+)\s+\(([\w./-]+):(\d+)-(\d+)\)/g,
          ),
        ];
        const cited = snippetRefs.slice(0, 3).map((m) => ({
          idx: m[1] ?? '',
          name: m[2] ?? '',
          file: m[3] ?? '',
          start: m[4] ?? '',
          end: m[5] ?? '',
        }));
        const bullets = cited
          .map((c) => `- \`${c.name}\` is defined in ${c.file}:${c.start} (see [${c.idx}]).`)
          .join('\n');
        content =
          `Based on the grounded snippets, here is what I can say about: "${question}"\n\n` +
          (bullets || '_No snippets matched._') +
          `\n\n_Answer generated offline (mock client)._`;
      } else {
        const targetMatch = body.match(/^Target:\s*(.+)$/m);
        const target = (targetMatch?.[1]?.trim()) ?? 'this module';

        // Extract grounded symbol entries from the "Symbols:" section so the
        // generated doc literally references the real symbol names (not just
        // file paths). The synthesis prompt emits lines of the form:
        //   "  - [kind] qualified.name (file.ts:N)"
        // Each captured tuple becomes a bullet in the generated doc.
        const symbolEntries: Array<{ kind: string; name: string; file: string; line: string }> = [];
        const symbolsHeaderIdx = body.indexOf('\nSymbols:');
        if (symbolsHeaderIdx >= 0) {
          const tail = body.slice(symbolsHeaderIdx);
          const blockEnd = tail.search(/\n[A-Z][A-Za-z ]+:\s*\n/);
          const block = blockEnd > 0 ? tail.slice(0, blockEnd) : tail;
          const re = /^\s*-\s*\[(\w+)\]\s+([\w.$-]+)\s+\(([\w./-]+):(\d+)\)/gm;
          for (let m = re.exec(block); m !== null; m = re.exec(block)) {
            symbolEntries.push({
              kind: m[1] ?? '',
              name: m[2] ?? '',
              file: m[3] ?? '',
              line: m[4] ?? '',
            });
          }
        }

        const refs = [...body.matchAll(/([\w./-]+\.(?:ts|tsx|js|jsx|py)):(\d+)/g)]
          .slice(0, 5)
          .map((m) => `\`${m[1]}:${m[2]}\``);
        const refLine = refs.length > 0 ? `References: ${refs.join(', ')}.` : '';

        // Scale bullets with the token budget: tight budgets produce short
        // docs; generous budgets cover every grounded symbol up to a sane cap.
        const maxBullets = Math.max(1, Math.min(50, Math.floor(params.maxTokens / 40)));
        const bullets = symbolEntries
          .slice(0, maxBullets)
          .map((s) => `- \`${s.name}\` — ${s.kind} (${s.file}:${s.line})`)
          .join('\n');

        const isArchitecture = target.toLowerCase().includes('architecture');
        const heading = isArchitecture ? '# Architecture' : `# ${target}`;
        const lede = isArchitecture
          ? `This codebase's modules collaborate through the graph above.`
          : `\`${target}\` exposes the following public surface:`;

        content =
          `${heading}\n\n` +
          `${lede}\n\n` +
          (bullets || '_No symbols extracted._') +
          (refLine ? `\n\n${refLine}` : '') +
          `\n\n_Generated offline (mock client)._`;
      }

      const tokens = Math.ceil(body.length / 4);
      return {
        content,
        inputTokens: tokens,
        outputTokens: Math.ceil(content.length / 4),
      };
    },
  };
}
