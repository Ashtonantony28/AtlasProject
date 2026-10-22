import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getAllDocs, getAllFiles, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  countDocs,
  createOfflineClient,
  exportDocs,
  listDocs,
  importPersistedDocs,
  readPersistedDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { SAMPLE } from '../cli/helpers.js';

describe('persisted docs (.atlas/docs)', () => {
  let dir: string;
  let root: string;
  let docsDir: string;

  /** Index + synthesize + export the base state, then throw the DB away. */
  async function generateBase(): Promise<void> {
    const db = openDatabase(join(dir, 'base.db'));
    await indexRepo(db, root);
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
    exportDocs(db, docsDir);
    closeDatabase(db);
  }

  /** A fresh DB over the current tree, as a CI checkout would have. */
  async function freshDb(name: string) {
    const db = openDatabase(join(dir, `${name}.db`));
    await indexRepo(db, root);
    return db;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-persist-'));
    root = join(dir, 'repo');
    docsDir = join(root, '.atlas', 'docs');
    cpSync(SAMPLE, root, { recursive: true });
    await generateBase();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one markdown file per doc with the source_hash in front matter', async () => {
    const db = await freshDb('check');
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
    const docs = getAllDocs(db);
    const files = new Map(getAllFiles(db).map((f) => [f.id, f.path]));
    expect(docs).toHaveLength(5);
    for (const d of docs) {
      const rel =
        d.target_kind === 'architecture' ? 'architecture.md' : `files/${files.get(d.target_id)}.md`;
      const text = readFileSync(join(docsDir, rel), 'utf8');
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toContain(`source_hash: ${d.source_hash}\n`);
      expect(text.endsWith(`${d.content}\n`)).toBe(true);
    }
    const persisted = readPersistedDocs(docsDir);
    expect(persisted.map((p) => `${p.kind}:${p.target}`).sort()).toEqual([
      'architecture:architecture',
      'file:src/app.ts',
      'file:src/math.ts',
      'file:src/shapes.ts',
      'file:src/util.py',
    ]);
    closeDatabase(db);
  });

  it('a fresh DB over the unchanged tree has no stale docs', async () => {
    const db = await freshDb('clean');
    const report = detectDrift(db, { root, docs: readPersistedDocs(docsDir) });
    expect(report.stale).toEqual([]);
    expect(report.undocumented).toEqual([]);
    expect(report.totals.docs).toBe(5);
    closeDatabase(db);
  });

  it('detects the changed file as stale from persisted docs in a fresh DB', async () => {
    const p = join(root, 'src/math.ts');
    writeFileSync(p, readFileSync(p, 'utf8').replace('return a * b;', 'return b * a;'));
    const db = await freshDb('ci');
    const report = detectDrift(db, { root, docs: readPersistedDocs(docsDir) });
    expect(report.stale.map((s) => `${s.kind}:${s.targetPath}`)).toEqual(['file:src/math.ts']);
    expect(report.hasDrift).toBe(true);
    closeDatabase(db);
  });

  it('reports a persisted doc whose source file was deleted as stale', async () => {
    unlinkSync(join(root, 'src/util.py'));
    const db = await freshDb('deleted');
    const stale = detectDrift(db, { root, docs: readPersistedDocs(docsDir) }).stale;
    expect(stale.filter((s) => s.kind === 'file').map((s) => s.targetPath)).toEqual([
      'src/util.py',
    ]);
    closeDatabase(db);
  });

  it('export prunes docs for files that no longer exist', async () => {
    unlinkSync(join(root, 'src/util.py'));
    const db = await freshDb('prune');
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
    const res = exportDocs(db, docsDir);
    expect(res.removed).toBe(1);
    expect(existsSync(join(docsDir, 'files/src/util.py.md'))).toBe(false);
    expect(detectDrift(db, { root, docs: readPersistedDocs(docsDir) }).stale).toEqual([]);
    closeDatabase(db);
  });

  it('seeds the cache from persisted docs so a fresh DB regenerates nothing', async () => {
    const db = await freshDb('seed');
    expect(importPersistedDocs(db, docsDir)).toBe(5);
    const stats = await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
    expect(stats.modulesGenerated).toBe(0);
    expect(stats.modulesCached).toBe(4);
    expect(stats.architectureGenerated).toBe(false);
    expect(stats.inputTokens).toBe(0);
    closeDatabase(db);
  });

  it('a missing docs dir reads as no docs', () => {
    expect(readPersistedDocs(join(dir, 'nope'))).toEqual([]);
  });

  describe('front matter that does not parse (A5-08)', () => {
    const arch = () => join(docsDir, 'architecture.md');
    const mathDoc = () => join(docsDir, 'files/src/math.ts.md');
    const prepend = (p: string, prefix: string) =>
      writeFileSync(p, prefix + readFileSync(p, 'utf8'));

    it('parses docs saved with a UTF-8 BOM, with or without CRLF line endings', async () => {
      const before = readPersistedDocs(docsDir);
      prepend(mathDoc(), '\uFEFF');
      writeFileSync(arch(), `\uFEFF${readFileSync(arch(), 'utf8').replace(/\n/g, '\r\n')}`);
      expect(readPersistedDocs(docsDir)).toEqual(before);
      const db = await freshDb('bom');
      expect(detectDrift(db, { root, docs: readPersistedDocs(docsDir) }).stale).toEqual([]);
      closeDatabase(db);
    });

    it('a BOM doc is still reported stale after its source changes', async () => {
      prepend(mathDoc(), '\uFEFF');
      writeFileSync(join(root, 'src/math.ts'), 'export function add2(): number { return 1; }\n');
      const db = await freshDb('bom-stale');
      const report = detectDrift(db, { root, docs: readPersistedDocs(docsDir) });
      expect(report.stale.map((s) => s.targetPath)).toContain('src/math.ts');
      expect(report.failing).toBe(true);
      closeDatabase(db);
    });

    it('a hand-broken doc is kept by path with no hash, so drift reports it stale', async () => {
      writeFileSync(mathDoc(), '# math\n\nNo front matter here; mentions add.\n');
      writeFileSync(arch(), '--\nkind: architecture\n');
      const docs = readPersistedDocs(docsDir);
      expect(docs.find((d) => d.target === 'src/math.ts')).toMatchObject({
        kind: 'file',
        sourceHash: '',
        content: '# math\n\nNo front matter here; mentions add.\n',
      });
      expect(docs.find((d) => d.kind === 'architecture')?.sourceHash).toBe('');
      const db = await freshDb('broken');
      const report = detectDrift(db, { root, docs });
      expect(report.stale.map((s) => [s.targetPath, s.storedHash]).sort()).toEqual([
        ['architecture', ''],
        ['src/math.ts', ''],
      ]);
      expect(report.failing).toBe(true);
      closeDatabase(db);
    });

    it('a broken doc is not imported as a cache hit, and is rewritten by the next export', async () => {
      writeFileSync(mathDoc(), 'garbage\n');
      const db = await freshDb('broken-import');
      expect(importPersistedDocs(db, docsDir)).toBe(4);
      const stats = await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 200_000 });
      expect(stats.modulesGenerated).toBe(1);
      exportDocs(db, docsDir);
      expect(readFileSync(mathDoc(), 'utf8').startsWith('---\n')).toBe(true);
      expect(detectDrift(db, { root, docs: readPersistedDocs(docsDir) }).stale).toEqual([]);
      closeDatabase(db);
    });

    it('listDocs and countDocs agree on a broken doc; stray markdown outside files/ is ignored', async () => {
      writeFileSync(mathDoc(), 'garbage\n');
      writeFileSync(join(docsDir, 'NOTES.md'), 'not a doc\n');
      const db = openDatabase(join(dir, 'empty.db'));
      const listed = listDocs(db, docsDir);
      expect(listed.map((d) => d.target)).not.toContain('NOTES');
      expect(listed).toHaveLength(countDocs(db, docsDir));
      expect(listed.find((d) => d.target === 'src/math.ts')?.content).toBe('garbage\n');
      closeDatabase(db);
    });
  });
});
