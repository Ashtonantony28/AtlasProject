// AUDIT-50: soundness, round 15 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-50.md (IDs A50-xx, plus one new consequence
// of A48-01); when it is fixed it turns red and should become a plain `it`. Plain `it` blocks pin
// what was attacked and held: SG240's `readIndexedSource` and its callers (`handleSymbolTool`,
// `retrieve`/`ask`, `buildModuleContext`, drift), the citation checks on ordinary forms, and
// incremental embeddings.
//
// Everything runs in-process on copies of the sample fixture with the offline LLM or an injected
// client. `search` is wrapped (transparently unless a test sets `afterSearch`) so A50-02 can run a
// concurrent index between `retrieve`'s reads deterministically.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getFileByPath, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { createOfflineClient, synthesizeDocs, type LLMClient } from '../../src/core/synth/index.js';
import { buildModuleContext } from '../../src/core/synth/context.js';
import { runDrift } from '../../src/core/drift/index.js';
import { readIndexedSource } from '../../src/core/vector/index.js';
import { checkCitations } from '../../src/core/qa/citations.js';
import { ask } from '../../src/core/qa/ask.js';
import { retrieve } from '../../src/core/qa/retrieve.js';
import { createMcpContext, handleSymbolTool, type McpContext } from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

const hook: { afterSearch: (() => Promise<void>) | null } = { afterSearch: null };

vi.mock('../../src/core/vector/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/vector/index.js')>();
  return {
    ...real,
    search: async (...args: Parameters<typeof real.search>) => {
      const hits = await real.search(...args);
      const after = hook.afterSearch;
      hook.afterSearch = null;
      if (after) await after();
      return hits;
    },
  };
});

const dirs: string[] = [];
const dbs: DB[] = [];

afterEach(() => {
  hook.afterSearch = null;
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit50-'));
  dirs.push(d);
  return d;
}

function open(path: string): DB {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

/** A copy of the sample fixture (plus `extra` files) indexed into its `.atlas/index.db` (the MCP context's). */
async function sample(
  opts: { embeddings?: boolean; extra?: Record<string, string> } = {},
): Promise<{ dir: string; root: string; db: DB; ctx: McpContext }> {
  const dir = tmp();
  const root = join(dir, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  for (const [p, text] of Object.entries(opts.extra ?? {})) writeFileSync(join(root, p), text);
  const ctx = createMcpContext({ root, offline: true });
  dbs.push(ctx.db);
  await indexRepo(ctx.db, root, { skipEmbeddings: opts.embeddings !== true });
  return { dir, root, db: ctx.db, ctx };
}

const HEADER = '// header added after indexing\n'.repeat(12);

/** A client that answers with `answer` (whatever the prompt). */
function answering(answer: string): LLMClient {
  return {
    model: 'fake',
    async complete() {
      return { content: answer, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
    },
  };
}

/** Each symbol's stored vector, by qualified name, as hex. */
function vectors(db: DB): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT f.path || ':' || COALESCE(s.qualified_name, s.name) AS k, v.embedding AS e
         FROM symbols s JOIN files f ON f.id = s.file_id
         JOIN embeddings_vec v ON v.rowid = s.id ORDER BY k`,
    )
    .all() as { k: string; e: Buffer }[];
  return new Map(rows.map((r) => [r.k, Buffer.from(r.e).toString('hex')]));
}

describe('SG240 `readIndexedSource` and its callers (pinned)', () => {
  it('an untouched file with a BOM, CRLF line ends and invalid UTF-8 bytes reads as unchanged; one edited byte reads as changed', async () => {
    const odd = Buffer.concat([
      Buffer.from('﻿export function odd(): number {\r\n  return 1; // '),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('\r\n}\r\n'),
    ]);
    const { root, db, ctx } = await sample();
    writeFileSync(join(root, 'src/odd.ts'), odd);
    await indexRepo(db, root, { skipEmbeddings: true });
    const file = getFileByPath(db, 'src/odd.ts')!;
    const read = readIndexedSource(root, file);
    expect(read.changed).toBe(false);
    expect(read.source).toContain('return 1;');
    expect(handleSymbolTool(ctx, { name: 'odd' })[0]?.excerpt).toContain('return 1;');
    const edited = Buffer.from(odd);
    edited[edited.length - 3] = 0x29; // the closing `}` → `)`
    writeFileSync(join(root, 'src/odd.ts'), edited);
    expect(readIndexedSource(root, file)).toEqual({ source: null, changed: true });
    expect(handleSymbolTool(ctx, { name: 'odd' })[0]?.excerpt).toBeNull();
  });

  it('after an unindexed edit no caller slices the new text at the indexed lines; re-indexing restores every excerpt', async () => {
    const { root, db, ctx } = await sample({ embeddings: true });
    const math = join(root, 'src/math.ts');
    const orig = readFileSync(math, 'utf8');
    writeFileSync(math, HEADER + orig);
    const file = getFileByPath(db, 'src/math.ts')!;
    expect(handleSymbolTool(ctx, { name: 'add' })[0]?.excerpt).toBeNull();
    const r = await retrieve(db, root, 'add two numbers');
    expect(r.changed).toEqual(['src/math.ts']);
    expect(r.snippets.filter((s) => s.file.path === 'src/math.ts')).toEqual([]);
    expect(buildModuleContext(db, root, file).sourceSnippets).toEqual([]);
    await indexRepo(db, root, {});
    expect(handleSymbolTool(ctx, { name: 'add' })[0]?.excerpt).toContain('return a + b');
    const again = await retrieve(db, root, 'add two numbers');
    expect(again.changed).toEqual([]);
    expect(again.snippets.find((s) => s.symbol.name === 'add')?.excerpt).toContain('return a + b');
  }, 30_000);
});

describe('A50-01 (medium) citation checks skip grouped and adjacent refs and read only the start of a dash range', () => {
  it('pinned: separate refs, hyphen ranges and backticked or bolded locations are each checked', async () => {
    const { root, db } = await sample({ embeddings: true });
    const r = await ask(
      db,
      answering('add is [1], see [9], `src/math.ts:4-60` and **src/math.ts:40**.'),
      root,
      'What does add do?',
    );
    expect(r.flagged.map((f) => f.raw)).toEqual(['[9]', 'src/math.ts:4-60', 'src/math.ts:40']);
  }, 30_000);

  it.fails(
    'A50-01 a snippet number cited as `[1][9]` or `[1, 9]` (no snippet 9) is flagged',
    async () => {
      const { root, db } = await sample({ embeddings: true });
      for (const answer of ['add sums two numbers [1][9].', 'add sums two numbers [1, 9].']) {
        const r = await ask(db, answering(answer), root, 'What does add do?');
        expect(r.citations.some((c) => c.index === 9)).toBe(false);
        expect(r.flagged.map((f) => f.raw).join(' '), answer).toMatch(/9/);
      }
    },
    30_000,
  );

  it.fails(
    'A50-01 a range written with an en dash, em dash or spaced hyphen is checked whole (`src/math.ts:4–60` is out of range)',
    () => {
      const cites = [
        {
          index: 1,
          file: 'src/math.ts',
          startLine: 4,
          endLine: 6,
          symbol: 'add',
          kind: 'function',
        },
      ];
      for (const answer of ['src/math.ts:4–60', 'src/math.ts:4—60', 'src/math.ts:4 - 60']) {
        const checks = checkCitations(answer, cites);
        expect(
          checks.map((c) => [c.raw, c.valid]),
          answer,
        ).not.toContainEqual(['src/math.ts:4', true]);
      }
    },
  );
});

describe('A50-02 (low) `retrieve` slices a newer file with a seed’s older line numbers', () => {
  it('pinned: without a concurrent index the seed excerpt is `add`’s source', async () => {
    const { root, db } = await sample({ embeddings: true });
    const r = await retrieve(db, root, 'add');
    expect(r.snippets.find((s) => s.symbol.name === 'add')?.excerpt).toContain('return a + b');
  }, 30_000);

  it.fails(
    'A50-02 an index committed between `search` and `retrieve`’s file read does not label other lines as `add`',
    async () => {
      const { root, db } = await sample({ embeddings: true });
      const math = join(root, 'src/math.ts');
      const orig = readFileSync(math, 'utf8');
      // Another process (or the MCP server's `atlas_index`) edits and indexes in between.
      hook.afterSearch = async () => {
        writeFileSync(math, HEADER + orig);
        const other = openDatabase(db.name);
        try {
          await indexRepo(other, root, { skipEmbeddings: true });
        } finally {
          closeDatabase(other);
        }
      };
      const r = await retrieve(db, root, 'add');
      const add = r.snippets.find((s) => s.symbol.name === 'add');
      expect(add, 'the seed was dropped instead (acceptable)').toBeDefined();
      expect(add!.excerpt, `lines ${add!.startLine}-${add!.endLine}`).toContain('return a + b');
    },
    30_000,
  );
});

describe('A50-03 (low) embedding text is read from disk without the content-hash check', () => {
  it('pinned: an incremental re-index after an edit and its undo leaves the same vectors as a fresh index', async () => {
    const { dir, root, db } = await sample({ embeddings: true });
    const math = join(root, 'src/math.ts');
    const orig = readFileSync(math, 'utf8');
    writeFileSync(math, HEADER + orig);
    await indexRepo(db, root, {});
    writeFileSync(math, orig);
    await indexRepo(db, root, {});
    const fresh = open(join(dir, 'fresh.db'));
    await indexRepo(fresh, root, {});
    expect(vectors(db)).toEqual(vectors(fresh));
  }, 30_000);

  it.fails(
    'A50-03 a file edited after its parse and before the embedding step (then undone) does not keep vectors built from the edit',
    async () => {
      const dir = tmp();
      const root = join(dir, 'repo');
      cpSync(SAMPLE, root, { recursive: true });
      const math = join(root, 'src/math.ts');
      const orig = readFileSync(math, 'utf8');
      const db = open(join(dir, 'index.db'));
      await indexRepo(db, root, {
        onFile: (e) => {
          if (e.path === 'src/math.ts' && e.status === 'parsed')
            writeFileSync(math, `${HEADER}export function vortex() { return quantum; }\n${orig}`);
        },
      });
      writeFileSync(math, orig); // the edit is undone; the next index skips every file
      const again = await indexRepo(db, root, {});
      expect(again.filesSkipped).toBe(4);
      const fresh = open(join(dir, 'fresh.db'));
      await indexRepo(fresh, root, {});
      const got = vectors(db);
      const want = vectors(fresh);
      const differ = [...want.keys()].filter((k) => got.get(k) !== want.get(k));
      expect(differ).toEqual([]);
    },
    30_000,
  );
});

describe('A48-01 (medium, still open): new consequence for files with no symbols', () => {
  it('pinned: a deleted (not re-indexed) file with symbols is still stale, with a hash', async () => {
    const { root, db } = await sample();
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    unlinkSync(join(root, 'src/app.ts'));
    const r = runDrift(db, { root });
    expect(r.failing).toBe(true);
    expect(r.stale.map((s) => s.targetPath)).toEqual(['src/app.ts']);
  });

  it.fails(
    'A48-01 deleting documented files with no symbols (a barrel, an entry script) is drift, not "docs are up to date"',
    async () => {
      const { root, db } = await sample({
        extra: {
          'src/index.ts': "export * from './math';\nexport * from './shapes';\n",
          'src/main.ts': "import { add } from './math';\nconsole.log(add(1, 2));\n",
        },
      });
      await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
      expect(runDrift(db, { root }).hasDrift).toBe(false);
      unlinkSync(join(root, 'src/index.ts'));
      unlinkSync(join(root, 'src/main.ts'));
      const r = runDrift(db, { root });
      expect(r.hasDrift, JSON.stringify(r.totals)).toBe(true);
    },
  );
});
