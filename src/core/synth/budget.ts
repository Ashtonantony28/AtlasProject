import type { LLMClient } from './llmClient.js';

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

/** Refuses any call whose input (~3 chars/token) + max output would exceed the budget. */
export function budgeted(inner: LLMClient, budget: TokenBudget): LLMClient {
  return {
    model: inner.model,
    async complete(params) {
      const chars =
        (params.system?.length ?? 0) + params.messages.reduce((n, m) => n + m.content.length, 0);
      const reserve = Math.ceil(chars / 3) + params.maxTokens;
      if (reserve > budget.remaining()) {
        throw new Error(
          `token budget exhausted: call needs ~${reserve} tokens, ${budget.remaining()} of ${budget.cap} left`,
        );
      }
      const res = await inner.complete(params);
      budget.record(res.inputTokens, res.outputTokens);
      return res;
    },
  };
}
