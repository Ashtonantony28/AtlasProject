// AUDIT-46: soundness, round 14 (no false negatives). Each `it.fails` asserts the CORRECT behaviour
// and currently fails, reproducing one finding in AUDIT-46.md (IDs A46-xx); when it is fixed it
// turns red and should become a plain `it`. Plain `it` blocks pin what was attacked and held:
// incremental indexing (skip, re-parse, prune on rename/move/delete/newly ignored), drift on renamed,
// moved and deleted files (index and `.atlas/docs` modes), search filters, and MCP tool results
// against the core calls the CLI makes.
//
// Everything runs in-process on copies of the sample fixture with the offline LLM; `git` is used
// only to read git's own verdict on a `.gitignore` (`git ls-files --others --exclude-standard`).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getFileByPath, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo, walkRepo } from '../../src/core/ingest/index.js';
import {
  createOfflineClient,
  exportDocs,
  synthesizeDocs,
  type LLMCallParams,
  type LLMClient,
} from '../../src/core/synth/index.js';
import { runDrift } from '../../src/core/drift/index.js';
import { createEmbedder, search } from '../../src/core/vector/index.js';
import { loadConfig } from '../../src/core/config.js';
import {
  createMcpContext,
  handleAskTool,
  handleDriftTool,
  handleIndexTool,
  handleSearchTool,
  handleSymbolTool,
  type McpContext,
} from '../../src/mcp/server.js';
import { SAMPLE } from '../cli/helpers.js';

const dirs: string[] = [];
const dbs: DB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit46-'));
  dirs.push(d);
  return d;
}

/** A copy of the sample fixture with an index (no embeddings) and, optionally, docs. */
async function sample(
  docs = true,
): Promise<{ dir: string; root: string; db: DB; docsDir: string }> {
  const dir = tmp();
  const root = join(dir, 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  const db = openDatabase(join(dir, 'index.db'));
  dbs.push(db);
  await indexRepo(db, root, { skipEmbeddings: true });
  const docsDir = join(dir, 'docs');
  if (docs) {
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    exportDocs(db, docsDir);
  }
  return { dir, root, db, docsDir };
}

/** Untracked, not-ignored files git sees (its `.gitignore` verdict), as relative POSIX paths. */
function gitVisible(root: string): string[] {
  execFileSync('git', ['init', '-q'], { cwd: root });
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((p) => /\.(ts|tsx|js|py)$/.test(p))
    .sort();
}

function tree(files: Record<string, string>): string {
  const root = join(tmp(), 'repo');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const walked = (root: string): string[] =>
  walkRepo(root)
    .map((f) => f.relativePath)
    .sort();
const SRC = 'export function kept(): number { return 1; }\n';

describe('A46-01 (medium) .gitignore and `exclude` patterns match case-insensitively', () => {
  it.fails(
    'A46-01 a file git does not ignore (the pattern differs in case, or uses a character class) is walked and indexed',
    async () => {
      const root = tree({
        '.gitignore': 'Build/\nConfig.ts\n[A-Z]*.gen.ts\n',
        'Build/out.ts': SRC, // ignored by git
        'Config.ts': SRC, // ignored by git
        'Api.gen.ts': SRC, // ignored by git
        'src/build/util.ts': SRC,
        'src/config.ts': SRC,
        'src/api.gen.ts': SRC,
        'src/main.ts': SRC,
      });
      const git = gitVisible(root);
      expect(git).toEqual(['src/api.gen.ts', 'src/build/util.ts', 'src/config.ts', 'src/main.ts']);
      expect(walked(root)).toEqual(git);
      const db = openDatabase(join(root, '..', 'index.db'));
      dbs.push(db);
      await indexRepo(db, root, { skipEmbeddings: true });
      expect(getFileByPath(db, 'src/config.ts')).toBeDefined();
    },
  );

  it('held: a pattern in the same case as the path, a negation and a nested set match as git does', () => {
    const root = tree({
      '.gitignore': 'build/\n*.gen.ts\n!keep.gen.ts\n/root-only.ts\n',
      'build/out.ts': SRC,
      'src/a.gen.ts': SRC,
      'src/keep.gen.ts': SRC,
      'root-only.ts': SRC,
      'src/root-only.ts': SRC,
      'src/main.ts': SRC,
      'pkg/.gitignore': '*.py\n!api.py\n',
      'pkg/api.py': 'def api():\n    pass\n',
      'pkg/impl.py': 'def impl():\n    pass\n',
    });
    expect(walked(root)).toEqual(gitVisible(root));
    expect(walked(root)).toEqual([
      'pkg/api.py',
      'src/keep.gen.ts',
      'src/main.ts',
      'src/root-only.ts',
    ]);
  });
});

describe('A46-02 (low) `dir/**/` ignores `dir` itself', () => {
  it.fails('A46-02 a `src/**/` rule leaves the files directly in src/ walked, as git does', () => {
    const root = tree({
      '.gitignore': 'src/**/\n',
      'src/main.ts': SRC,
      'src/nested/inner.ts': SRC,
    });
    const git = gitVisible(root);
    expect(git).toEqual(['src/main.ts']);
    expect(walked(root)).toEqual(git);
  });
});

describe('A46-03 (medium) a missing architecture doc is never reported', () => {
  it.fails(
    'A46-03 drift reports the architecture doc when it is missing from the index or from .atlas/docs',
    async () => {
      const { root, db, docsDir } = await sample();
      db.prepare("DELETE FROM docs WHERE target_kind = 'architecture'").run();
      unlinkSync(join(docsDir, 'architecture.md'));
      for (const report of [runDrift(db, { root }), runDrift(db, { root, docsDir })]) {
        const named = [
          ...report.stale.map((s) => s.targetPath),
          ...report.undocumented.map((u) => u.symbol),
        ];
        expect(named, `hasDrift=${report.hasDrift}`).toContain('architecture');
      }
    },
  );

  it.fails(
    'A46-03 after `atlas docs` skips the architecture doc for budget, drift does not say every doc is up to date',
    async () => {
      const { root, db } = await sample(false);
      // A budget that pays for every module doc but not the architecture doc as well (3300 on the
      // sample: `atlas docs --offline --budget 3300`); the offline client is deterministic.
      let st;
      for (let budget = 2000; budget <= 6000; budget += 50) {
        db.prepare('DELETE FROM docs').run();
        st = await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: budget });
        if (st.modulesGenerated === 4 && !st.architectureGenerated) break;
      }
      expect(st).toMatchObject({ modulesGenerated: 4, architectureGenerated: false });
      expect(runDrift(db, { root }).hasDrift).toBe(true);
    },
  );

  it('held: an architecture doc that no longer matches the index is reported stale in both modes', async () => {
    const { root, db, docsDir } = await sample();
    writeFileSync(join(root, 'src/extra.ts'), SRC);
    await indexRepo(db, root, { skipEmbeddings: true });
    for (const report of [runDrift(db, { root }), runDrift(db, { root, docsDir })]) {
      expect(report.stale.map((s) => s.targetPath)).toContain('architecture');
      expect(report.failing).toBe(true);
    }
  });
});

describe('A46-04 (high) excerpts are read from disk at the indexed line numbers without checking the file', () => {
  const HEADER = '// header added after indexing\n'.repeat(12);

  async function edited(llm?: LLMClient): Promise<McpContext> {
    const root = join(tmp(), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    const ctx = createMcpContext({ root, ...(llm ? { llm } : { offline: true }) });
    dbs.push(ctx.db);
    await handleIndexTool(ctx, {});
    const p = join(root, 'src/math.ts');
    writeFileSync(p, HEADER + readFileSync(p, 'utf8'));
    return ctx;
  }

  it('A46-04 atlas_symbol does not return other lines as `add`’s source after an edit that was not re-indexed', async () => {
    const ctx = await edited();
    const [add] = handleSymbolTool(ctx, { name: 'add' });
    expect(add?.file).toBe('src/math.ts');
    const excerpt = add?.excerpt ?? null;
    expect(
      excerpt === null || excerpt.includes('return a + b'),
      `excerpt ${JSON.stringify(excerpt)}`,
    ).toBe(true);
  });

  it('A46-04 atlas_ask does not ground the model on other lines labelled as `add` (or says the file changed)', async () => {
    const prompts: string[] = [];
    const capture: LLMClient = {
      model: 'capture',
      async complete(params: LLMCallParams) {
        prompts.push(params.messages.map((m) => m.content).join('\n'));
        return { content: 'ok [1]', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      },
    };
    const ctx = await edited(capture);
    await handleAskTool(ctx, { question: 'What does add do?' });
    const prompt = prompts.join('\n');
    expect(prompt).toMatch(/add/);
    expect(prompt, 'the snippet labelled add holds the inserted header').not.toMatch(
      /header added after indexing/,
    );
  });

  it('held: before the edit the excerpt is `add`’s source, and after it drift marks the doc unindexed', async () => {
    const root = join(tmp(), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    const ctx = createMcpContext({ root, offline: true });
    dbs.push(ctx.db);
    await handleIndexTool(ctx, {});
    expect(handleSymbolTool(ctx, { name: 'add' })[0]?.excerpt).toContain('return a + b');
    await synthesizeDocs(ctx.db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    const p = join(root, 'src/math.ts');
    writeFileSync(p, HEADER + readFileSync(p, 'utf8'));
    const report = handleDriftTool(ctx, { skipArchitecture: true });
    expect(report.stale).toEqual([
      expect.objectContaining({ targetPath: 'src/math.ts', currentHash: 'unindexed' }),
    ]);
  });
});

describe('held (pinned): incremental indexing and drift on renames, moves and deletes', () => {
  it('an unchanged re-index skips every file; an edit re-parses only that file', async () => {
    const { root, db } = await sample(false);
    const again = await indexRepo(db, root, { skipEmbeddings: true });
    expect(again).toMatchObject({ filesIndexed: 0, filesSkipped: 4, filesRemoved: 0 });
    writeFileSync(join(root, 'src/math.ts'), readFileSync(join(root, 'src/math.ts'), 'utf8') + SRC);
    const edit = await indexRepo(db, root, { skipEmbeddings: true });
    expect(edit).toMatchObject({
      filesIndexed: 1,
      filesSkipped: 3,
      resolveReason: 'files changed',
    });
    expect(db.prepare("SELECT COUNT(*) FROM symbols WHERE name = 'kept'").pluck().get()).toBe(1);
  });

  it('a renamed file is pruned and its doc reported missing in both modes (exit-2 gate)', async () => {
    const { root, db, docsDir } = await sample();
    renameSync(join(root, 'src/math.ts'), join(root, 'src/arith.ts'));
    const st = await indexRepo(db, root, { skipEmbeddings: true });
    expect(st).toMatchObject({ filesIndexed: 1, filesRemoved: 1 });
    for (const report of [runDrift(db, { root }), runDrift(db, { root, docsDir })]) {
      expect(report.failing).toBe(true);
      expect(report.stale).toContainEqual(
        expect.objectContaining({ targetPath: 'src/math.ts', currentHash: 'missing' }),
      );
      expect(report.undocumented.map((u) => u.file)).toContain('src/arith.ts');
    }
  });

  it('a file moved into a new directory and a file deleted are both reported', async () => {
    const { root, db, docsDir } = await sample();
    mkdirSync(join(root, 'lib'));
    renameSync(join(root, 'src/shapes.ts'), join(root, 'lib/shapes.ts'));
    unlinkSync(join(root, 'src/util.py'));
    await indexRepo(db, root, { skipEmbeddings: true });
    for (const report of [runDrift(db, { root }), runDrift(db, { root, docsDir })]) {
      const missing = report.stale
        .filter((s) => s.currentHash === 'missing')
        .map((s) => s.targetPath);
      expect(missing.sort()).toEqual(['src/shapes.ts', 'src/util.py']);
    }
  });

  it('a file that becomes ignored is pruned and its doc reported missing', async () => {
    const { root, db, docsDir } = await sample();
    writeFileSync(join(root, '.gitignore'), 'math.ts\n');
    const st = await indexRepo(db, root, { skipEmbeddings: true });
    expect(st.filesRemoved).toBe(1);
    for (const report of [runDrift(db, { root }), runDrift(db, { root, docsDir })]) {
      expect(report.stale).toContainEqual(
        expect.objectContaining({ targetPath: 'src/math.ts', currentHash: 'missing' }),
      );
    }
  });
});

describe('held (pinned): search filters and MCP results against the core calls the CLI makes', () => {
  async function indexed(): Promise<McpContext> {
    const root = join(tmp(), 'repo');
    cpSync(SAMPLE, root, { recursive: true });
    const ctx = createMcpContext({ root, offline: true });
    dbs.push(ctx.db);
    await handleIndexTool(ctx, {});
    return ctx;
  }

  it('kind and file filters keep exact-name hits and drop everything outside them', async () => {
    const ctx = await indexed();
    const embedder = createEmbedder(loadConfig(ctx.root));
    const area = await search(ctx.db, embedder, 'area', { kind: ['method'], limit: 50 });
    expect(area.length).toBeGreaterThan(0);
    expect(area.every((h) => h.symbol.kind === 'method')).toBe(true);
    expect(area.map((h) => h.symbol.qualified_name)).toEqual(
      expect.arrayContaining(['Square.area', 'Drawable.area']),
    );
    const inMath = await search(ctx.db, embedder, 'add', { file: 'math', limit: 50 });
    expect(inMath[0]?.symbol.name).toBe('add');
    expect(inMath.every((h) => h.filePath.includes('math'))).toBe(true);
    expect(await search(ctx.db, embedder, 'add', { file: 'shapes', limit: 50 })).not.toContainEqual(
      expect.objectContaining({ filePath: 'src/math.ts' }),
    );
  });

  it('atlas_search and atlas_drift return what the CLI’s core calls return', async () => {
    const ctx = await indexed();
    await synthesizeDocs(ctx.db, createOfflineClient(), { root: ctx.root, tokenBudget: 1_000_000 });
    writeFileSync(join(ctx.root, 'src/extra.ts'), SRC);
    await handleIndexTool(ctx, {});
    const embedder = createEmbedder(loadConfig(ctx.root));
    for (const args of [
      { query: 'area' },
      { query: 'add numbers', kind: ['function' as const] },
      { query: 'shape', file: 'shapes', limit: 3 },
    ]) {
      const core = await search(ctx.db, embedder, args.query, {
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.file ? { file: args.file } : {}),
        limit: args.limit ?? 10,
      });
      const mcp = await handleSearchTool(ctx, args);
      expect(mcp.map((h) => [h.name, h.file, h.startLine])).toEqual(
        core.map((h) => [
          h.symbol.qualified_name ?? h.symbol.name,
          h.filePath,
          h.symbol.start_line,
        ]),
      );
    }
    const full = runDrift(ctx.db, { root: ctx.root });
    const mcp = handleDriftTool(ctx, { limit: 1000 });
    expect(mcp.stale).toEqual(full.stale);
    expect(mcp.undocumented).toEqual(full.undocumented);
    expect(mcp.failing).toBe(true);
  });
});
