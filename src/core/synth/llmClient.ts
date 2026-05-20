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
 */
export function createOfflineClient(model = 'offline-mock-v1'): LLMClient {
  return {
    model,
    async complete(params: LLMCallParams): Promise<LLMResult> {
      const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
      const body = lastUser?.content ?? '';
      // Extract a "Target:" line if present.
      const targetMatch = body.match(/^Target:\s*(.+)$/m);
      const target = targetMatch ? targetMatch[1]?.trim() : 'this module';
      // Extract bullet lines that look like symbol references (file:line).
      const refs = [...body.matchAll(/([\w./-]+\.(?:ts|tsx|js|jsx|py)):(\d+)/g)]
        .slice(0, 5)
        .map((m) => `\`${m[1]}:${m[2]}\``);
      const refLine = refs.length > 0 ? `References: ${refs.join(', ')}.` : '';
      const content =
        `# ${target}\n\n` +
        `${target} contains the symbols listed above. The graph shows the ` +
        `incoming and outgoing relationships used to ground this summary.\n\n` +
        (refLine ? `${refLine}\n` : '') +
        `\n_Generated offline (mock client)._`;
      const tokens = Math.ceil(body.length / 4);
      return {
        content,
        inputTokens: tokens,
        outputTokens: Math.ceil(content.length / 4),
      };
    },
  };
}
