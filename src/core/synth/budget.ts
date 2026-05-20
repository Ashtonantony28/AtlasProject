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
