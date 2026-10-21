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
        const isArchitecture = target.toLowerCase().includes('architecture');

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

        // Architecture prompts have a "Files:" + "Top connected files:"
        // section instead of "Symbols:". Render those into the doc.
        const fileEntries: Array<{ path: string; language: string; loc: string; symbols: string }> = [];
        if (isArchitecture) {
          const filesHeaderIdx = body.indexOf('\nFiles:');
          if (filesHeaderIdx >= 0) {
            const tail = body.slice(filesHeaderIdx);
            const blockEnd = tail.search(/\n[A-Z][A-Za-z ]+(?:\s+\([^)]+\))?:\s*\n/);
            const block = blockEnd > 0 ? tail.slice(0, blockEnd) : tail;
            const re = /^\s*-\s+([\S]+)\s+\[(\w+)\]\s+loc=(\d+)\s+symbols=(\d+)/gm;
            for (let m = re.exec(block); m !== null; m = re.exec(block)) {
              fileEntries.push({
                path: m[1] ?? '',
                language: m[2] ?? '',
                loc: m[3] ?? '',
                symbols: m[4] ?? '',
              });
            }
          }
        }
        const topConnected: Array<{ file: string; degree: string }> = [];
        if (isArchitecture) {
          const topHeader = body.indexOf('Top connected files');
          if (topHeader >= 0) {
            const tail = body.slice(topHeader);
            const re = /^\s*-\s+([\S]+)\s+\(degree=(\d+)\)/gm;
            for (let m = re.exec(tail); m !== null; m = re.exec(tail)) {
              topConnected.push({ file: m[1] ?? '', degree: m[2] ?? '' });
            }
          }
        }
        const totalsMatch = body.match(/^Totals:\s+files=(\d+)\s+symbols=(\d+)\s+edges=(\d+)/m);

        const refs = [...body.matchAll(/([\w./-]+\.(?:ts|tsx|js|jsx|py)):(\d+)/g)]
          .slice(0, 5)
          .map((m) => `\`${m[1]}:${m[2]}\``);
        const refLine = refs.length > 0 ? `References: ${refs.join(', ')}.` : '';

        // Scale bullets with the token budget: tight budgets produce short
        // docs; generous budgets cover every grounded symbol up to a sane cap.
        const maxBullets = Math.max(1, Math.min(50, Math.floor(params.maxTokens / 40)));

        if (isArchitecture) {
          const totalsLine = totalsMatch
            ? `**Totals:** ${totalsMatch[1]} files, ${totalsMatch[2]} symbols, ${totalsMatch[3]} edges`
            : '';
          const filesBullets = fileEntries
            .slice(0, maxBullets)
            .map((f) => `- \`${f.path}\` — ${f.language}, loc=${f.loc}, ${f.symbols} symbols`)
            .join('\n');
          const topBullets = topConnected
            .slice(0, Math.min(10, maxBullets))
            .map((t) => `- \`${t.file}\` (degree=${t.degree})`)
            .join('\n');
          content =
            `# Architecture\n\n` +
            `This codebase's modules collaborate through the graph above.\n\n` +
            (totalsLine ? `${totalsLine}\n\n` : '') +
            (filesBullets
              ? `## Modules\n\n${filesBullets}\n\n`
              : '_No modules extracted._\n\n') +
            (topBullets ? `## Key collaborations\n\n${topBullets}\n\n` : '') +
            `_Generated offline (mock client)._`;
        } else {
          const bullets = symbolEntries
            .slice(0, maxBullets)
            .map((s) => `- \`${s.name}\` — ${s.kind} (${s.file}:${s.line})`)
            .join('\n');
          content =
            `# ${target}\n\n` +
            `\`${target}\` exposes the following public surface:\n\n` +
            (bullets || '_No symbols extracted._') +
            (refLine ? `\n\n${refLine}` : '') +
            `\n\n_Generated offline (mock client)._`;
        }
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
