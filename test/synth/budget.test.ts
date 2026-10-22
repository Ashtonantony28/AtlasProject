// SG28: max_tokens is capped to what the budget can pay; only a call below MIN_OUTPUT_TOKENS is refused.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getAllDocs, openDatabase, type DB } from '../../src/core/db/index.js';
import {
  affordableMaxTokens,
  budgeted,
  createOfflineClient,
  DOC_MAX_TOKENS,
  estimateInputTokens,
  MIN_OUTPUT_TOKENS,
  synthesizeDocs,
  TokenBudget,
  type LLMCallParams,
  type LLMClient,
} from '../../src/core/synth/index.js';
import { createMcpContext, handleAskTool } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function indexedCopy(): Promise<{ root: string; db: DB }> {
  const d = mkdtempSync(join(tmpdir(), 'atlas-sg28-'));
  dirs.push(d);
  const root = join(d, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  await runCli(['index', root]);
  const db = openDatabase(join(root, '.atlas', 'index.db'));
  dbs.push(db);
  return { root, db };
}

function spy(inner: LLMClient = createOfflineClient()): LLMClient & { calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = [];
  return { model: inner.model, calls, complete: (p) => (calls.push(p), inner.complete(p)) };
}

describe('affordableMaxTokens', () => {
  it('keeps the requested cap when the budget pays for it in full', () => {
    expect(affordableMaxTokens(new TokenBudget(DOC_MAX_TOKENS + 500), 500, DOC_MAX_TOKENS)).toBe(
      DOC_MAX_TOKENS,
    );
  });

  it('caps to the remaining budget after the prompt estimate', () => {
    const budget = new TokenBudget(10_000);
    budget.record(1_000, 1_000);
    expect(affordableMaxTokens(budget, 2_000, DOC_MAX_TOKENS)).toBe(6_000);
  });

  it('accepts exactly MIN_OUTPUT_TOKENS and refuses one token less', () => {
    expect(affordableMaxTokens(new TokenBudget(300 + MIN_OUTPUT_TOKENS), 300, DOC_MAX_TOKENS)).toBe(
      MIN_OUTPUT_TOKENS,
    );
    const short = new TokenBudget(300 + MIN_OUTPUT_TOKENS - 1);
    expect(() => affordableMaxTokens(short, 300, DOC_MAX_TOKENS)).toThrow(
      `token budget exhausted: a call needs ~${300 + MIN_OUTPUT_TOKENS} tokens (~300 prompt + ${MIN_OUTPUT_TOKENS} output), ${300 + MIN_OUTPUT_TOKENS - 1} of ${300 + MIN_OUTPUT_TOKENS - 1} left; raise tokenBudget`,
    );
  });

  it('a requested cap below the minimum is its own floor', () => {
    expect(affordableMaxTokens(new TokenBudget(150), 50, 100)).toBe(100);
    expect(() => affordableMaxTokens(new TokenBudget(149), 50, 100)).toThrow(/needs ~150 tokens/);
  });

  it('estimates ~3 chars/token over system and messages', () => {
    expect(
      estimateInputTokens({ system: 'abc', messages: [{ role: 'user', content: 'abcd' }] }),
    ).toBe(3);
  });
});

describe('budgeted()', () => {
  it('passes the capped max_tokens to the client and refuses below the minimum without a call', async () => {
    const inner = spy();
    const params: LLMCallParams = {
      messages: [{ role: 'user', content: 'x'.repeat(300) }],
      maxTokens: DOC_MAX_TOKENS,
    };
    await budgeted(inner, new TokenBudget(2_100)).complete(params);
    expect(inner.calls[0]?.maxTokens).toBe(2_000);
    await expect(budgeted(inner, new TokenBudget(1_000)).complete(params)).rejects.toThrow(
      /token budget exhausted/,
    );
    expect(inner.calls).toHaveLength(1);
  });
});

describe('docs and ask with small budgets', () => {
  it('synthesizeDocs refuses before any call when the budget cannot pay the first doc', async () => {
    const { root, db } = await indexedCopy();
    const llm = spy();
    await expect(synthesizeDocs(db, llm, { root, tokenBudget: 1_000 })).rejects.toThrow(
      /token budget exhausted/,
    );
    expect(llm.calls).toHaveLength(0);
    expect(getAllDocs(db)).toHaveLength(0);
  });

  it('offline docs with a 4k budget generates every doc with capped max_tokens', async () => {
    const { root, db } = await indexedCopy();
    const llm = spy();
    const stats = await synthesizeDocs(db, llm, { root, tokenBudget: 4_000 });
    expect(stats.modulesGenerated).toBe(4);
    expect(stats.architectureGenerated).toBe(true);
    for (const c of llm.calls) {
      expect(c.maxTokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
      expect(c.maxTokens).toBeLessThan(DOC_MAX_TOKENS);
    }
  });

  it('`atlas docs --offline --budget 1000` exits 1 with the budget error and writes nothing', async () => {
    const { root } = await indexedCopy();
    await expect(runCli(['docs', '--offline', '--budget', '1000', '--cwd', root])).rejects.toThrow(
      /token budget exhausted: .* 1000 of 1000 left/,
    );
  });

  it('ask and atlas_ask answer with a small budget and refuse a tiny one with the same message', async () => {
    const { root, db } = await indexedCopy();
    closeDatabase(db);
    const config = (tokenBudget: number) =>
      writeFileSync(
        join(root, '.atlas', 'config.json'),
        JSON.stringify({ version: 1, tokenBudget }),
      );

    config(5_000);
    const ok = createMcpContext({ root, offline: true });
    try {
      expect((await handleAskTool(ok, { question: 'circle area' })).answer.length).toBeGreaterThan(
        0,
      );
    } finally {
      closeDatabase(ok.db);
    }

    config(1_000);
    const tiny = createMcpContext({ root, offline: true });
    let mcpError = '';
    try {
      await handleAskTool(tiny, { question: 'circle area' }).catch(
        (e: Error) => (mcpError = e.message),
      );
    } finally {
      closeDatabase(tiny.db);
    }
    expect(mcpError).toMatch(/^token budget exhausted: .* 1000 of 1000 left; raise tokenBudget$/);
    await expect(runCli(['ask', '--offline', '--cwd', root, 'circle area'])).rejects.toThrow(
      mcpError,
    );
  });
});
