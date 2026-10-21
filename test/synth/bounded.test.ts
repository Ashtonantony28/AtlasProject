import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getAllFiles, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  architectureContextToPrompt,
  buildArchitectureContext,
  buildModuleContext,
  createOfflineClient,
  MAX_ARCH_PROMPT_CHARS,
  MAX_MODULE_PROMPT_CHARS,
  moduleContextToPrompt,
  synthesizeDocs,
  type LLMClient,
} from '../../src/core/synth/index.js';

function bigFile(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`/** Doc for fn${i}. ${'lorem ipsum '.repeat(8)} */`);
    out.push(
      `export function fn${i}(a: number): number { return a + ${i}; /* ${'x'.repeat(200)} */ }`,
    );
  }
  return out.join('\n') + '\n';
}

describe('bounded synthesis context', () => {
  let dir: string;
  let root: string;
  let db: DB;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-bounded-'));
    root = join(dir, 'repo');
    mkdirSync(join(root, 'src/many'), { recursive: true });
    writeFileSync(join(root, 'src/big.ts'), bigFile(1500));
    writeFileSync(
      join(root, 'src/imports.ts'),
      Array.from({ length: 200 }, (_, i) => `import { fn${i} } from './big.js';`).join('\n') +
        '\nexport const total = fn1(1) + fn2(2);\n',
    );
    for (let i = 0; i < 300; i++) {
      writeFileSync(
        join(root, `src/many/m${i}.ts`),
        `export function m${i}(): number { return ${i}; }\n`,
      );
    }
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root);
  }, 60_000);
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps every module prompt and the architecture prompt deterministically', () => {
    for (const file of getAllFiles(db)) {
      const a = moduleContextToPrompt(buildModuleContext(db, root, file));
      const b = moduleContextToPrompt(buildModuleContext(db, root, file));
      expect(a).toBe(b);
      expect(a.length).toBeLessThanOrEqual(MAX_MODULE_PROMPT_CHARS);
    }
    const big = getAllFiles(db).find((f) => f.path === 'src/big.ts')!;
    const prompt = moduleContextToPrompt(buildModuleContext(db, root, big));
    expect(prompt).toMatch(/^Target: module src\/big\.ts$/m);
    expect(prompt).toMatch(/fn0 \(src\/big\.ts:\d+\)/);
    expect(prompt).toMatch(/more symbols omitted/);

    const arch = architectureContextToPrompt(buildArchitectureContext(db));
    expect(arch.length).toBeLessThanOrEqual(MAX_ARCH_PROMPT_CHARS);
    expect(arch).toMatch(/^Totals: files=302 /m);
    expect(arch).toMatch(/src\/big\.ts/);
    expect(arch).toMatch(/more files omitted/);
  });

  it('never spends more than the token budget with a worst-case client', async () => {
    const base = createOfflineClient();
    // Bills at ~3 chars/token over system + prompt and always uses max_tokens.
    const greedy: LLMClient = {
      model: 'greedy',
      async complete(params) {
        const r = await base.complete(params);
        const chars =
          (params.system ?? '').length + params.messages.reduce((n, m) => n + m.content.length, 0);
        return { ...r, inputTokens: Math.ceil(chars / 3), outputTokens: params.maxTokens };
      },
    };
    const budget = 20_000;
    const stats = await synthesizeDocs(db, greedy, { root, tokenBudget: budget });
    expect(stats.inputTokens + stats.outputTokens).toBeLessThanOrEqual(budget);
    expect(stats.modulesGenerated).toBeGreaterThan(0);
    expect(stats.modulesSkipped).toBeGreaterThan(0);
    expect(stats.budgetRemaining).toBe(budget - stats.inputTokens - stats.outputTokens);
  });

  it('documents a 302-file repo within the default budget', async () => {
    const stats = await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
    expect(stats.modulesSkipped).toBe(0);
    expect(stats.modulesGenerated).toBe(302);
    expect(stats.architectureGenerated).toBe(true);
    expect(stats.inputTokens + stats.outputTokens).toBeLessThanOrEqual(200_000);
  });
});
