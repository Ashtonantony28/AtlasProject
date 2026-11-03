// AUDIT-53: test coverage, round 15 (final). Plain `it` blocks, all passing on unmodified `src/`, that
// kill mutants the product suite (everything outside `test/audit/`) lets through. See AUDIT-53.md.
//
// A53-01: `readIndexedSource` and the indexer must hash the same text. The product suite only ever
// edits plain ASCII files, so hashing the raw bytes on either side (H04, H06) or normalising a BOM
// on one side (H07) passes all of it; on a file with a BOM or a non-UTF-8 byte that then reads as
// "changed" forever: `atlas_symbol` withholds its excerpts, `ask` drops its snippets with a note
// that re-indexing cannot clear, and drift marks its doc `unindexed`, failing the gate.
//
// Everything runs in-process on copies of the sample fixture with the offline LLM.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getFileByPath } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { createOfflineClient, synthesizeDocs, type LLMClient } from '../../src/core/synth/index.js';
import { runDrift } from '../../src/core/drift/index.js';
import { ask } from '../../src/core/qa/ask.js';
import { readIndexedSource } from '../../src/core/vector/index.js';
import { createMcpContext, handleSymbolTool, type McpContext } from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

const dirs: string[] = [];
const contexts: McpContext[] = [];

afterEach(() => {
  for (const c of contexts.splice(0)) if (c.db.open) closeDatabase(c.db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `src/latin.ts` holds a Latin-1 byte (invalid UTF-8); `src/bom.ts` starts with a BOM and uses CRLF. */
const LATIN = Buffer.concat([
  Buffer.from('// caf'),
  Buffer.from([0xe9]),
  Buffer.from(' au lait\nexport function latinTotal(): number {\n  return 41 + 1;\n}\n'),
]);
const BOM = Buffer.from('﻿export function bomTotal(): number {\r\n  return 40 + 2;\r\n}\r\n');

async function indexed(): Promise<{ root: string; ctx: McpContext }> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-a53-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  writeFileSync(join(root, 'src/latin.ts'), LATIN);
  writeFileSync(join(root, 'src/bom.ts'), BOM);
  const ctx = createMcpContext({ root, offline: true });
  contexts.push(ctx);
  await indexRepo(ctx.db, root);
  return { root, ctx };
}

describe('A53-01: a file with a BOM or a non-UTF-8 byte reads as unchanged after indexing', () => {
  it('readIndexedSource and atlas_symbol serve both files', async () => {
    const { root, ctx } = await indexed();
    for (const [path, name, body] of [
      ['src/latin.ts', 'latinTotal', 'return 41 + 1;'],
      ['src/bom.ts', 'bomTotal', 'return 40 + 2;'],
    ] as const) {
      const read = readIndexedSource(root, getFileByPath(ctx.db, path)!);
      expect(read.changed, path).toBe(false);
      expect(read.source, path).toContain(body);
      expect(handleSymbolTool(ctx, { name })[0]?.excerpt, path).toContain(body);
    }
  });

  it('ask cites them with no "changed since indexing" note', async () => {
    const { root, ctx } = await indexed();
    const prompts: string[] = [];
    const capture: LLMClient = {
      model: 'capture',
      complete: async (params) => {
        prompts.push(params.messages.map((m) => m.content).join('\n'));
        return { content: 'see [1]', inputTokens: 1, outputTokens: 1 };
      },
    };
    const res = await ask(ctx.db, capture, root, 'latinTotal bomTotal', { seedLimit: 20 });
    expect(res.answer).not.toMatch(/changed since indexing/);
    expect(prompts.join('\n')).toContain('return 41 + 1;');
    expect(prompts.join('\n')).toContain('return 40 + 2;');
  });

  it('drift reports their docs in sync, not `unindexed`, after `atlas docs`', async () => {
    const { root, ctx } = await indexed();
    await synthesizeDocs(ctx.db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    const report = runDrift(ctx.db, { root });
    expect(report.stale.map((s) => `${s.targetPath}:${s.currentHash}`)).toEqual([]);
    // A re-index with nothing edited skips both files (the indexer agrees with itself, too).
    const stats = await indexRepo(ctx.db, root);
    expect(stats.filesSkipped).toBe(stats.filesScanned);
  });
});
