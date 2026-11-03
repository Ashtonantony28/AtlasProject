// AUDIT-49: test coverage, round 11. Every test here is a plain `it` that holds today and fails under
// a mutant that the product suite (every test outside `test/audit/`) lets through; see AUDIT-49.md
// (IDs A49-xx, mutants C04, N02, N03). They pin SG240's guarantee where no product test does:
// module-doc prompts never slice a file that changed since indexing, and `ask`'s note names every
// changed file. Everything runs in-process on copies of the sample fixture.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getFileByPath, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { ask } from '../../src/core/qa/index.js';
import {
  buildModuleContext,
  synthesizeDocs,
  type LLMCallParams,
  type LLMClient,
} from '../../src/core/synth/index.js';
import { SAMPLE } from '../cli/helpers.js';

const HEADER = '// header added after indexing\n'.repeat(12);
const dirs: string[] = [];
const dbs: DB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function indexed(): Promise<{ root: string; db: DB }> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit49-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  const db = openDatabase(join(dir, 'index.db'));
  dbs.push(db);
  await indexRepo(db, root);
  return { root, db };
}

function prepend(root: string, rel: string): void {
  const p = join(root, rel);
  writeFileSync(p, HEADER + readFileSync(p, 'utf8'));
}

function capture(prompts: string[], content = 'ok'): LLMClient {
  return {
    model: 'capture',
    async complete(params: LLMCallParams) {
      prompts.push(params.messages.map((m) => m.content).join('\n'));
      return { content, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
    },
  };
}

describe('A49-01 (high) module-doc prompts never slice a file changed since indexing (C04)', () => {
  it('buildModuleContext has `add`’s source before the edit and no snippet after it', async () => {
    const { root, db } = await indexed();
    const file = getFileByPath(db, 'src/math.ts');
    if (!file) throw new Error('src/math.ts not indexed');
    const before = buildModuleContext(db, root, file).sourceSnippets;
    expect(before.find((s) => s.symbol === 'add')?.code).toMatch(/return a \+ b/);
    prepend(root, 'src/math.ts');
    const after = buildModuleContext(db, root, file).sourceSnippets;
    expect(after.map((s) => s.code).join('\n')).not.toMatch(/header added after indexing/);
    expect(after).toEqual([]);
  });

  it('`atlas docs` after an edit that was not re-indexed sends no inserted line labelled as a symbol', async () => {
    const { root, db } = await indexed();
    prepend(root, 'src/math.ts');
    const prompts: string[] = [];
    await synthesizeDocs(db, capture(prompts, '# doc\nadd multiply PI'), {
      root,
      tokenBudget: 1_000_000,
    });
    const math = prompts.filter((p) => p.startsWith('Target: module src/math.ts'));
    expect(math.length).toBeGreaterThan(0);
    expect(math.join('\n')).not.toMatch(/header added after indexing/);
  });
});

describe('A49-02 (low) ask’s note names every changed file (N02, N03)', () => {
  it('two files changed: the note lists both, with "their"', async () => {
    const { root, db } = await indexed();
    const prompts: string[] = [];
    const q = 'What do add, multiply and the Circle area do?';
    const before = await ask(db, capture(prompts), root, q, { seedLimit: 20 });
    const files = [...new Set(before.citations.map((c) => c.file))];
    expect(files).toEqual(expect.arrayContaining(['src/math.ts', 'src/shapes.ts']));
    prepend(root, 'src/math.ts');
    prepend(root, 'src/shapes.ts');
    const after = await ask(db, capture(prompts), root, q, { seedLimit: 20 });
    const note = /\n\nNote: (.+) changed since indexing, so their snippets were left out; run `atlas index`\.$/.exec(
      after.answer,
    );
    expect(note, after.answer).not.toBeNull();
    expect(note?.[1]?.split(', ').sort()).toEqual(['src/math.ts', 'src/shapes.ts']);
    expect(after.citations.map((c) => c.file)).not.toContain('src/math.ts');
    expect(after.citations.map((c) => c.file)).not.toContain('src/shapes.ts');
  });
});
