import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import * as parser from '../../src/core/parse/parser.js';
import {
  createOfflineClient,
  exportDocs,
  readPersistedDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { SAMPLE } from '../cli/helpers.js';

vi.mock('../../src/core/parse/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/parse/parser.js')>();
  return { ...actual, parseSource: vi.fn(actual.parseSource) };
});

const MATH = 'src/math.ts';

describe('drift when the index is behind the file', () => {
  let dir: string;
  let root: string;
  let db: DB;
  let docsDir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-unindexed-'));
    root = join(dir, 'repo');
    docsDir = join(dir, 'docs');
    cpSync(SAMPLE, root, { recursive: true });
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
    exportDocs(db, docsDir);
  });
  afterEach(() => {
    vi.mocked(parser.parseSource).mockRestore();
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const stale = (docs?: string) =>
    detectDrift(db, {
      root,
      skipArchitecture: true,
      ...(docs ? { docs: readPersistedDocs(docs) } : {}),
    }).stale;

  it('is clean before any edit', () => {
    expect(stale()).toEqual([]);
    expect(stale(docsDir)).toEqual([]);
  });

  it('marks the doc stale when the changed file fails to re-index', async () => {
    appendFileSync(join(root, MATH), 'export function added(): void {}\n');
    vi.mocked(parser.parseSource).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const st = await indexRepo(db, root, { skipEmbeddings: true });
    expect(st.filesFailed).toBe(1);
    for (const report of [stale(), stale(docsDir)]) {
      expect(report).toEqual([
        expect.objectContaining({ kind: 'file', targetPath: MATH, currentHash: 'unindexed' }),
      ]);
    }
  });

  it('marks the doc stale when the file was edited but not re-indexed', () => {
    appendFileSync(join(root, MATH), '// trailing edit\n');
    expect(stale().map((s) => s.targetPath)).toEqual([MATH]);
    expect(stale(docsDir).map((s) => s.targetPath)).toEqual([MATH]);
  });

  it('recovers once the file re-indexes', async () => {
    appendFileSync(join(root, MATH), 'export function added(): void {}\n');
    vi.mocked(parser.parseSource).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await indexRepo(db, root, { skipEmbeddings: true });
    await indexRepo(db, root, { skipEmbeddings: true });
    const report = stale();
    expect(report.map((s) => s.targetPath)).toEqual([MATH]);
    expect(report[0]?.currentHash).not.toBe('unindexed');
  });
});
