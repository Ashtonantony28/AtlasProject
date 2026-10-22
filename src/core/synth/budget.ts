import type { LLMCallParams, LLMClient } from './llmClient.js';

/** Smallest output worth a call: one whose budget cannot pay this after its prompt is refused. */
export const MIN_OUTPUT_TOKENS = 1024;

/**
 * Simple, monotonic token budget enforcer. Subsystems call `charge()` before a
 * call; if the total would exceed the cap, `charge` returns false and the
 * caller is expected to skip the work.
 */
export class TokenBudget {
  private input = 0;
  private output = 0;

  constructor(public readonly cap: number) {}

  remaining(): number {
    return Math.max(0, this.cap - this.input - this.output);
  }

  total(): { input: number; output: number; spent: number; cap: number; remaining: number } {
    return {
      input: this.input,
      output: this.output,
      spent: this.input + this.output,
      cap: this.cap,
      remaining: this.remaining(),
    };
  }

  /**
   * Attempt to charge `tokens` against the budget. Returns false if it would exceed.
   */
  tryCharge(input: number, output: number): boolean {
    if (this.input + this.output + input + output > this.cap) return false;
    this.input += input;
    this.output += output;
    return true;
  }

  record(input: number, output: number): void {
    this.input += input;
    this.output += output;
  }
}

/** Prompt estimate: ~3 chars/token over the system prompt and every message. */
export function estimateInputTokens(params: Pick<LLMCallParams, 'system' | 'messages'>): number {
  const chars =
    (params.system?.length ?? 0) + params.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 3);
}

/**
 * `maxTokens` capped to what the budget can pay after `inputTokens`. Throws when that is below
 * MIN_OUTPUT_TOKENS (or `maxTokens`, if smaller).
 */
export function affordableMaxTokens(
  budget: TokenBudget,
  inputTokens: number,
  maxTokens: number,
): number {
  const remaining = budget.remaining();
  const floor = Math.min(maxTokens, MIN_OUTPUT_TOKENS);
  if (remaining - inputTokens < floor) {
    throw new Error(
      `token budget exhausted: a call needs ~${inputTokens + floor} tokens (~${inputTokens} prompt + ${floor} output), ${remaining} of ${budget.cap} left; raise tokenBudget`,
    );
  }
  return Math.min(maxTokens, remaining - inputTokens);
}

/** Caps each call's max_tokens to the remaining budget; refuses calls it cannot pay (see affordableMaxTokens). */
export function budgeted(inner: LLMClient, budget: TokenBudget): LLMClient {
  return {
    model: inner.model,
    async complete(params) {
      const maxTokens = affordableMaxTokens(budget, estimateInputTokens(params), params.maxTokens);
      const res = await inner.complete({ ...params, maxTokens });
      budget.record(res.inputTokens, res.outputTokens);
      return res;
    },
  };
}
