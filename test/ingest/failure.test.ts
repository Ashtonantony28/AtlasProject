import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  openDatabase,
  getFileByPath,
  getSymbolsForFile,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import * as parser from '../../src/core/parse/parser.js';

vi.mock('../../src/core/parse/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/parse/parser.js')>();
  return { ...actual, parseSource: vi.fn(actual.parseSource) };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');
const MATH = 'src/math.ts';

describe('indexRepo parse failure', () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-fail-'));
    root = join(dir, 'repo');
    cpSync(FIXTURE, root, { recursive: true });
  });
  afterEach(() => {
    vi.mocked(parser.parseSource).mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the previous rows and hash so the next run retries', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    try {
      await indexRepo(db, root, { skipEmbeddings: true });
      const before = getFileByPath(db, MATH);
      expect(before).toBeDefined();
      const oldSymbols = getSymbolsForFile(db, before!.id).map((s) => s.qualified_name);
      expect(oldSymbols).toContain('add');

      writeFileSync(
        join(root, MATH),
        'export function subtract(a: number, b: number): number {\n  return a - b;\n}\n',
      );
      const real = vi.mocked(parser.parseSource).getMockImplementation()!;
      vi.mocked(parser.parseSource).mockImplementationOnce(() => {
        throw new Error('boom');
      });

      const failed = await indexRepo(db, root, { skipEmbeddings: true });
      expect(failed.filesFailed).toBe(1);
      const after = getFileByPath(db, MATH);
      expect(after?.content_hash).toBe(before!.content_hash);
      expect(getSymbolsForFile(db, before!.id).map((s) => s.qualified_name)).toEqual(oldSymbols);

      vi.mocked(parser.parseSource).mockImplementation(real);
      const retried = await indexRepo(db, root, { skipEmbeddings: true });
      expect(retried.filesFailed).toBe(0);
      expect(retried.filesIndexed).toBe(1);
      const names = getSymbolsForFile(db, before!.id).map((s) => s.qualified_name);
      expect(names).toContain('subtract');
      expect(names).not.toContain('add');
      expect(getFileByPath(db, MATH)?.content_hash).not.toBe(before!.content_hash);
    } finally {
      closeDatabase(db);
    }
  });
});
