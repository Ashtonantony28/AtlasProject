// AUDIT-32: test coverage, round 8 (SG105). Plain `it` tests pin behaviour that is correct today
// but that a surviving mutation showed no other test checks (the mutant IDs are in each test name;
// AUDIT-32.md has the diffs). Each `it.fails` asserts the correct behaviour and currently fails,
// reproducing one finding in AUDIT-32.md (IDs A32-xx); when it is fixed it turns red and should
// become a plain `it`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/core/db/index.js';

// `hook.wal(path)` runs before every `journal_mode = WAL` pragma (it may throw, as SQLite would).
const hook = vi.hoisted(() => ({ wal: undefined as ((path: string) => void) | undefined }));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default;
  class Hooked extends Real {
    pragma(source: string, options?: Database.PragmaOptions): unknown {
      if (source === 'journal_mode = WAL') hook.wal?.(this.name);
      return super.pragma(source, options);
    }
  }
  return { default: Hooked };
});

const REMEDY = ' (another process is writing the index; retry when it finishes)';
const busyError = (code = 'SQLITE_BUSY'): Error =>
  new Database.SqliteError('database is locked', code);

const dirs: string[] = [];
afterEach(() => {
  hook.wal = undefined;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-a32-'));
  dirs.push(d);
  return d;
}

describe('SG105 the size is taken once, before the first try (pinned)', () => {
  it('S04: a refused switch of a one-page file (not empty, not WAL) fails at once, not after 5 s', () => {
    // A rollback-mode file of exactly one page: another program's index, not one being created.
    const path = join(tmp(), 'index.db');
    const other = new Database(path);
    other.pragma('user_version = 7');
    other.close();
    expect(statSync(path).size).toBe(4096);
    let tries = 0;
    hook.wal = (p) => {
      if (p !== path) return;
      tries++;
      throw busyError();
    };
    const t0 = Date.now();
    expect(() => openDatabase(path)).toThrow(`journal mode: database is locked${REMEDY}`);
    expect(tries).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
