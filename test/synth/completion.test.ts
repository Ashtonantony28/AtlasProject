// SG21: the LLM client works on current models (A7-01), incomplete completions are never
// stored or answered (A7-03), and the offline mock bills the system prompt (A7-10).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, getAllDocs, getAllFiles, getDoc, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { ask } from '../../src/core/qa/index.js';
import {
  ASK_MAX_TOKENS,
  budgeted,
  createAnthropicClient,
  createOfflineClient,
  DOC_MAX_TOKENS,
  incompleteReason,
  synthesizeDocs,
  TokenBudget,
  type DocStatus,
  type LLMCallParams,
  type LLMClient,
  type LLMResult,
} from '../../src/core/synth/index.js';
import { createAtlasMcpServer, createMcpContext, type McpContext } from '../../src/mcp/server.js';
import { runCli, SAMPLE } from '../cli/helpers.js';
import { fakeAnthropic as startFake, message } from '../helpers/fakeAnthropic.js';

const dirs: string[] = [];
const dbs: DB[] = [];
const servers: Server[] = [];
const contexts: McpContext[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleCopy(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-sg21-'));
  dirs.push(d);
  const root = join(d, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  return root;
}

async function indexedDb(): Promise<{ root: string; db: DB }> {
  const root = sampleCopy();
  const db = openDatabase(join(root, 'index.db'));
  dbs.push(db);
  await indexRepo(db, root);
  return { root, db };
}

async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  let thrown: Error | undefined;
  try {
    await runCli(args);
  } catch (e) {
    thrown = e as Error;
  } finally {
    vi.restoreAllMocks();
  }
  const code = thrown ? 1 : typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { out: out.join(''), err: err.join('') + (thrown?.message ?? ''), code };
}

async function fake(extra: Record<string, unknown> | ((body: Record<string, unknown>) => Record<string, unknown>)) {
  const f = await startFake((body) => message(body, typeof extra === 'function' ? extra(body) : extra));
  servers.push(f.server);
  vi.stubEnv('ANTHROPIC_BASE_URL', f.url);
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  return f;
}

/** A client that answers every call with `res`, recording the params. */
function scripted(res: Partial<LLMResult>): LLMClient & { calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = [];
  return {
    model: 'scripted',
    calls,
    async complete(params) {
      calls.push(params);
      return { content: '', inputTokens: 7, outputTokens: 3, ...res };
    },
  };
}

const text = (t: string) => [{ type: 'text', text: t }];
const INCOMPLETE: Array<[string, Partial<LLMResult>]> = [
  ['refusal', { content: '', stopReason: 'refusal' }],
  ['max_tokens', { content: '# partial doc that was cut', stopReason: 'max_tokens' }],
  ['empty end_turn', { content: '  \n', stopReason: 'end_turn' }],
  ['empty, no stop reason', { content: '' }],
  ['model_context_window_exceeded', { content: '# x', stopReason: 'model_context_window_exceeded' }],
];

describe('incompleteReason', () => {
  it('accepts a non-empty end_turn, stop_sequence or reason-less completion', () => {
    for (const stopReason of ['end_turn', 'stop_sequence', undefined]) {
      const res: LLMResult = { content: '# ok', inputTokens: 1, outputTokens: 1, ...(stopReason ? { stopReason } : {}) };
      expect(incompleteReason(res)).toBeNull();
    }
  });

  it.each(INCOMPLETE)('rejects %s', (_name, res) => {
    expect(incompleteReason({ content: '', inputTokens: 0, outputTokens: 0, ...res })).toMatch(
      /stop_reason|empty/,
    );
  });

  it('names the stop reason', () => {
    expect(incompleteReason({ content: '', inputTokens: 0, outputTokens: 0, stopReason: 'refusal' })).toBe(
      'stop_reason refusal',
    );
    expect(incompleteReason({ content: '', inputTokens: 0, outputTokens: 0 })).toBe('empty response');
  });
});

describe('Anthropic request shape (A7-01)', () => {
  it('sends only model, max_tokens, system and messages', async () => {
    const f = await fake({ content: text('ok'), stop_reason: 'end_turn' });
    const llm = await createAnthropicClient('claude-opus-5-5');
    await llm.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    const keys = Object.keys(f.bodies[0] ?? {});
    expect(keys.sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    for (const k of ['temperature', 'top_p', 'top_k']) expect(keys).not.toContain(k);
  });

  it('omits system when none is given', async () => {
    const f = await fake({ content: text('ok'), stop_reason: 'end_turn' });
    const llm = await createAnthropicClient('claude-opus-5-5');
    await llm.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(Object.keys(f.bodies[0] ?? {}).sort()).toEqual(['max_tokens', 'messages', 'model']);
  });

  it('`docs` sends DOC_MAX_TOKENS and no sampling params on every call', async () => {
    const root = sampleCopy();
    await cli(['index', root]);
    const f = await fake({ content: text('# doc'), stop_reason: 'end_turn' });
    const run = await cli(['docs', '--model', 'claude-opus-5-5', '--cwd', root]);
    expect(run.code).toBe(0);
    expect(f.bodies).toHaveLength(5);
    for (const b of f.bodies) {
      expect(b['max_tokens']).toBe(DOC_MAX_TOKENS);
      expect(b['model']).toBe('claude-opus-5-5');
      expect(b).not.toHaveProperty('temperature');
    }
  });

  it('`ask` sends ASK_MAX_TOKENS and no sampling params', async () => {
    const root = sampleCopy();
    await cli(['index', root]);
    const f = await fake({ content: text('Circle is in src/shapes.ts [1]'), stop_reason: 'end_turn' });
    const run = await cli(['ask', 'circle area', '--cwd', root]);
    expect(run.code).toBe(0);
    expect(run.out).toContain('Circle is in src/shapes.ts');
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]?.['max_tokens']).toBe(ASK_MAX_TOKENS);
    expect(f.bodies[0]).not.toHaveProperty('temperature');
  });

  it('leaves room for thinking: caps are the non-streaming default (~16k)', () => {
    expect(DOC_MAX_TOKENS).toBeGreaterThanOrEqual(16_000);
    expect(ASK_MAX_TOKENS).toBeGreaterThanOrEqual(16_000);
  });

  it('returns the stop reason and joins only text blocks', async () => {
    await fake({
      content: [{ type: 'thinking', thinking: '', signature: 's' }, ...text('a'), ...text('b')],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const llm = await createAnthropicClient('claude-opus-5-5');
    const res = await llm.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(res).toEqual({ content: 'a\nb', inputTokens: 12, outputTokens: 34, stopReason: 'max_tokens' });
  });
});

describe('synthesizeDocs never stores an incomplete completion (A7-03)', () => {
  it.each(INCOMPLETE)('%s: no doc stored, every target reported failed', async (_name, res) => {
    const { root, db } = await indexedDb();
    const events: Array<{ status: DocStatus; reason?: string }> = [];
    const llm = scripted(res);
    const stats = await synthesizeDocs(db, llm, {
      root,
      tokenBudget: 1_000_000,
      onProgress: (e) => events.push(e),
    });
    expect(getAllDocs(db)).toEqual([]);
    expect(stats.modulesGenerated).toBe(0);
    expect(stats.modulesFailed).toBe(4);
    expect(stats.architectureGenerated).toBe(false);
    expect(stats.architectureFailed).toBe(true);
    expect(stats.failures.map((f) => f.target)).toEqual([
      ...getAllFiles(db).map((f) => f.path),
      'architecture',
    ]);
    expect(events.map((e) => e.status)).toEqual(Array(5).fill('failed'));
    for (const e of events) expect(e.reason).toBe(incompleteReason({ content: '', inputTokens: 0, outputTokens: 0, ...res }));
    // Tokens were spent, so they still count against the budget.
    expect(stats.inputTokens).toBe(35);
    expect(stats.outputTokens).toBe(15);
    expect(stats.budgetRemaining).toBe(1_000_000 - 50);
  });

  it('a failed target is retried on the next run instead of being cached', async () => {
    const { root, db } = await indexedDb();
    await synthesizeDocs(db, scripted({ stopReason: 'refusal' }), { root, tokenBudget: 1_000_000 });
    const good = scripted({ content: '# fine', stopReason: 'end_turn' });
    const stats = await synthesizeDocs(db, good, { root, tokenBudget: 1_000_000 });
    expect(good.calls).toHaveLength(5);
    expect(stats.modulesGenerated).toBe(4);
    expect(stats.modulesCached).toBe(0);
    expect(stats.architectureGenerated).toBe(true);
    expect(stats.failures).toEqual([]);
  });

  it('a refused regeneration keeps the previous good doc untouched', async () => {
    const { root, db } = await indexedDb();
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    const before = getAllDocs(db);
    const stats = await synthesizeDocs(db, scripted({ stopReason: 'refusal' }), {
      root,
      tokenBudget: 1_000_000,
      force: true,
    });
    expect(stats.modulesFailed).toBe(4);
    expect(getAllDocs(db)).toEqual(before);
  });

  it('only the failing targets fail; the rest are stored', async () => {
    const { root, db } = await indexedDb();
    const llm: LLMClient = {
      model: 'mixed',
      async complete(p) {
        const refuse = /Target:.*shapes/.test(p.messages[0]?.content ?? '');
        return refuse
          ? { content: '', inputTokens: 1, outputTokens: 0, stopReason: 'refusal' }
          : { content: '# ok', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      },
    };
    const stats = await synthesizeDocs(db, llm, { root, tokenBudget: 1_000_000 });
    expect(stats.modulesGenerated).toBe(3);
    expect(stats.modulesFailed).toBe(1);
    expect(stats.architectureGenerated).toBe(true);
    expect(stats.failures).toEqual([{ target: 'src/shapes.ts', reason: 'stop_reason refusal' }]);
    const shapes = getAllFiles(db).find((f) => f.path === 'src/shapes.ts');
    expect(getDoc(db, 'file', shapes?.id ?? -1)).toBeUndefined();
  });

  it('passes DOC_MAX_TOKENS by default and honours perDocMaxTokens', async () => {
    const { root, db } = await indexedDb();
    const a = scripted({ content: '# ok' });
    await synthesizeDocs(db, a, { root, tokenBudget: 1_000_000 });
    expect(a.calls.map((c) => c.maxTokens)).toEqual(Array(5).fill(DOC_MAX_TOKENS));
    const b = scripted({ content: '# ok' });
    await synthesizeDocs(db, b, { root, tokenBudget: 1_000_000, perDocMaxTokens: 321, force: true });
    expect(b.calls.map((c) => c.maxTokens)).toEqual(Array(5).fill(321));
    for (const c of [...a.calls, ...b.calls]) expect(c).not.toHaveProperty('temperature');
  });

  it('the budget still reserves the per-doc cap before each call', async () => {
    const { root, db } = await indexedDb();
    const llm = scripted({ content: '# ok' });
    const stats = await synthesizeDocs(db, llm, { root, tokenBudget: DOC_MAX_TOKENS });
    expect(llm.calls).toHaveLength(0);
    expect(stats.modulesSkipped).toBe(4);
  });
});

describe('`atlas docs` reports incomplete completions (A7-03)', () => {
  it.each([
    ['refusal', { content: [], stop_reason: 'refusal' }, 'stop_reason refusal'],
    ['max_tokens', { content: text('# cut off mid'), stop_reason: 'max_tokens' }, 'stop_reason max_tokens'],
    ['empty', { content: [], stop_reason: 'end_turn' }, 'empty response'],
  ])('%s: exits 1, names each target, persists nothing', async (_n, reply, reason) => {
    const root = sampleCopy();
    await cli(['index', root]);
    const f = await fake(reply);
    const run = await cli(['docs', '--cwd', root]);
    expect(f.bodies).toHaveLength(5);
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/generated 0, cached 0, skipped 0, failed 4/);
    expect(run.out).toMatch(/architecture: failed/);
    for (const t of ['src/shapes.ts', 'src/math.ts', 'architecture']) {
      expect(run.err).toContain(`atlas docs: ${t}: not stored (${reason})`);
    }
    const docsDir = join(root, '.atlas', 'docs');
    const persisted = existsSync(docsDir) ? readdirSync(docsDir, { recursive: true }) : [];
    expect(persisted.filter((p) => String(p).endsWith('.md'))).toEqual([]);

    // Nothing was cached: the next run calls the model again for every target.
    await cli(['docs', '--cwd', root]);
    expect(f.bodies).toHaveLength(10);
  });

  it('a later successful run generates and persists every doc and exits 0', async () => {
    const root = sampleCopy();
    await cli(['index', root]);
    let refuse = true;
    await fake(() => (refuse ? { content: [], stop_reason: 'refusal' } : { content: text('# doc'), stop_reason: 'end_turn' }));
    expect((await cli(['docs', '--cwd', root])).code).toBe(1);
    refuse = false;
    const run = await cli(['docs', '--cwd', root]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/generated 4, cached 0, skipped 0, failed 0/);
    expect(run.err).toBe('');
    expect((await cli(['drift', '--cwd', root])).code).toBe(0);
  });

  it('offline docs still succeed with exit 0', async () => {
    const root = sampleCopy();
    await cli(['index', root]);
    const run = await cli(['docs', '--offline', '--cwd', root]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/generated 4, cached 0, skipped 0, failed 0/);
  });
});

describe('ask surfaces incomplete completions as errors (A7-03)', () => {
  it.each(INCOMPLETE)('%s: core ask throws', async (_name, res) => {
    const { root, db } = await indexedDb();
    await expect(ask(db, scripted(res), root, 'circle area')).rejects.toThrow(
      /no answer: the model returned an incomplete response \((stop_reason \w+|empty response)\)/,
    );
  });

  it('a complete answer is returned as before, with ASK_MAX_TOKENS and no temperature', async () => {
    const { root, db } = await indexedDb();
    const llm = scripted({ content: 'Circle [1]', stopReason: 'end_turn' });
    const res = await ask(db, llm, root, 'circle area');
    expect(res.answer).toBe('Circle [1]');
    expect(llm.calls[0]?.maxTokens).toBe(ASK_MAX_TOKENS);
    expect(llm.calls[0]).not.toHaveProperty('temperature');
    const own = scripted({ content: 'x', stopReason: 'end_turn' });
    await ask(db, own, root, 'circle area', { maxTokens: 99 });
    expect(own.calls[0]?.maxTokens).toBe(99);
  });

  it.each([
    ['refusal', { content: [], stop_reason: 'refusal' }, /stop_reason refusal/],
    ['max_tokens', { content: text('Circle is'), stop_reason: 'max_tokens' }, /stop_reason max_tokens/],
    ['empty', { content: [], stop_reason: 'end_turn' }, /empty response/],
  ])('CLI `ask` (%s) exits 1 with a clear error, no answer printed', async (_n, reply, re) => {
    const root = sampleCopy();
    await cli(['index', root]);
    await fake(reply);
    const run = await cli(['ask', '--json', 'circle area', '--cwd', root]);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(re);
    expect(run.out).toBe('');
  });

  it('MCP atlas_ask returns isError on a refusal', async () => {
    const root = sampleCopy();
    await cli(['index', root]);
    const ctx = createMcpContext({ root, llm: scripted({ stopReason: 'refusal' }) });
    contexts.push(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'sg21', version: '0.0.0' });
    await Promise.all([createAtlasMcpServer(ctx).connect(a), client.connect(b)]);
    try {
      const res = await client.callTool({ name: 'atlas_ask', arguments: { question: 'circle area' } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/stop_reason refusal/);
    } finally {
      await client.close();
    }
  });
});

describe('offline mock token accounting (A7-10)', () => {
  it('counts the system prompt and every message, ~4 chars per token', async () => {
    const llm = createOfflineClient();
    const system = 's'.repeat(400);
    const res = await llm.complete({
      system,
      messages: [
        { role: 'user', content: 'Target: x\n' + 'a'.repeat(390) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'Target: y' },
      ],
      maxTokens: 100,
    });
    expect(res.inputTokens).toBe(Math.ceil((400 + 400 + 100 + 9) / 4));
    expect(res.stopReason).toBe('end_turn');
    const noSystem = await llm.complete({ messages: [{ role: 'user', content: 'a'.repeat(40) }], maxTokens: 100 });
    expect(noSystem.inputTokens).toBe(10);
  });

  it('`ask --offline` reports (system + prompt) / 4 input tokens', async () => {
    const { root, db } = await indexedDb();
    const seen: LLMCallParams[] = [];
    const inner = createOfflineClient();
    const spy: LLMClient = {
      model: inner.model,
      complete: (p) => (seen.push(p), inner.complete(p)),
    };
    const res = await ask(db, spy, root, 'circle area');
    const p = seen[0];
    expect(p?.system?.length).toBeGreaterThan(100);
    expect(res.inputTokens).toBe(Math.ceil(((p?.system?.length ?? 0) + (p?.messages[0]?.content.length ?? 0)) / 4));
  });

  it('offline synthesis charges the system prompt against the budget', async () => {
    const { root, db } = await indexedDb();
    const seen: LLMCallParams[] = [];
    const inner = createOfflineClient();
    const spy: LLMClient = { model: inner.model, complete: (p) => (seen.push(p), inner.complete(p)) };
    const stats = await synthesizeDocs(db, spy, { root, tokenBudget: 1_000_000 });
    const expected = seen.reduce(
      (n, p) => n + Math.ceil(((p.system?.length ?? 0) + (p.messages[0]?.content.length ?? 0)) / 4),
      0,
    );
    expect(stats.inputTokens).toBe(expected);
    expect(stats.budgetRemaining).toBe(1_000_000 - stats.inputTokens - stats.outputTokens);
  });

  it('budgeted() records the mock usage including system', async () => {
    const budget = new TokenBudget(10_000);
    const llm = budgeted(createOfflineClient(), budget);
    const res = await llm.complete({ system: 'x'.repeat(800), messages: [{ role: 'user', content: 'Target: t' }], maxTokens: 40 });
    expect(res.inputTokens).toBe(Math.ceil(809 / 4));
    expect(budget.total().input).toBe(res.inputTokens);
  });
});
