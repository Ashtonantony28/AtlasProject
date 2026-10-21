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
import { parseSource, parseSourceOrThrow } from '../../src/core/parse/parser.js';

// tree-sitter fails (as with R1's `Invalid argument`) on any source containing `fault.on`.
const fault = vi.hoisted(() => ({ on: null as string | null }));

vi.mock('tree-sitter', async (importOriginal) => {
  const real = await importOriginal<{
    default: new () => { parse(...a: unknown[]): unknown };
  }>();
  class FaultyParser extends real.default {
    parse(input: unknown, ...rest: unknown[]): unknown {
      if (fault.on !== null && typeof input === 'function') {
        if (String((input as (i: number) => string)(0)).includes(fault.on)) {
          throw new Error('Invalid argument');
        }
      }
      return super.parse(input, ...rest);
    }
  }
  return { ...real, default: FaultyParser };
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
    fault.on = null;
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
      fault.on = 'subtract';

      const failed = await indexRepo(db, root, { skipEmbeddings: true });
      expect(failed.filesFailed).toBe(1);
      const after = getFileByPath(db, MATH);
      expect(after?.content_hash).toBe(before!.content_hash);
      expect(getSymbolsForFile(db, before!.id).map((s) => s.qualified_name)).toEqual(oldSymbols);

      fault.on = null;
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

  it('parseSource reports the failure as a diagnostic; parseSourceOrThrow throws', async () => {
    fault.on = 'x';
    const r = await parseSource('const x = 1;\n', 'typescript', 'x.ts');
    expect(r.symbols).toEqual([]);
    expect(r.diagnostics).toEqual([
      { line: 1, message: expect.stringContaining('Invalid argument'), severity: 'error' },
    ]);
    await expect(parseSourceOrThrow('const x = 1;\n', 'typescript', 'x.ts')).rejects.toThrow(
      'Invalid argument',
    );
  });
});
