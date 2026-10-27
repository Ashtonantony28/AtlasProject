// AUDIT-45: test coverage, round 10. Plain `it` blocks, correct today, each killing mutants of
// SG190 and the A41-03 texts that survive the product suite (every file outside `test/audit/`); the
// mutant IDs are in AUDIT-45.md. In-process (coverage sees them, no `cc`): the check's verdicts,
// `readSync`, `/proc/locks` and connection opens are driven through `hook`, as in
// `test/db/leftoverWal.test.ts`. A connection held by the test process stands in for a running
// `atlas mcp` (writable) or `atlas serve` (read-only).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase, type DB } from '../../src/core/db/index.js';
import { SAMPLE } from '../cli/helpers.js';

const hook = vi.hoisted(() => ({
  integrity: undefined as ((name: string, n: number) => string | undefined) | undefined,
  checks: 0,
  read: undefined as ((path: string) => number | undefined) | undefined,
  locks: undefined as ((real: string) => string) | undefined,
  open: undefined as ((name: string) => void) | undefined,
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default;
  class Hooked extends Real {
    constructor(name: string, options?: Database.Options) {
      hook.open?.(name);
      super(name, options);
    }
    pragma(source: string, options?: Database.PragmaOptions): unknown {
      if (source.startsWith('integrity_check') && hook.integrity) {
        const r = hook.integrity(this.name, hook.checks++);
        if (r !== undefined) return r;
      }
      return super.pragma(source, options);
    }
  }
  return { default: Hooked };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const fdPath = (fd: number): string => {
    try {
      return real.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return '';
    }
  };
  const readSync = ((fd: number, ...rest: unknown[]) => {
    const n = hook.read?.(fdPath(fd));
    if (n !== undefined) return n;
    return (real.readSync as (...a: unknown[]) => number)(fd, ...rest);
  }) as typeof real.readSync;
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const out = real.readFileSync(...args);
    return args[0] === '/proc/locks' && hook.locks ? hook.locks(String(out)) : out;
  }) as typeof real.readFileSync;
  const fns = { readSync, readFileSync };
  return { ...real, ...fns, default: { ...real, ...fns } };
});

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
let stderr: string[] = [];

afterEach(() => {
  Object.assign(hook, {
    integrity: undefined,
    checks: 0,
    read: undefined,
    locks: undefined,
    open: undefined,
  });
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit45-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');
const aside = (root: string): string[] =>
  readdirSync(join(root, '.atlas')).filter((f) => f.includes('.foreign-'));

let sample = '';
let replacement = '';
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'atlas-audit45-base-'));
  const index = (root: string, extra?: string): string => {
    cpSync(SAMPLE, root, { recursive: true });
    if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
    const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'index', root], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(`${dbOf(root)}-wal`)).toBe(false);
    return root;
  };
  sample = index(join(base, 'sample'));
  replacement = index(join(base, 'replacement'), REPLACEMENT_FN);
  return () => rmSync(base, { recursive: true, force: true });
}, 60_000);

function copyOf(src: string): string {
  const root = join(tmp(), 'repo');
  cpSync(src, root, { recursive: true });
  return root;
}

/** A committed write SIGKILLed before any checkpoint: its WAL and `-shm` stay beside `dbPath`. */
function killedWriter(dbPath: string): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id");
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
  expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(32);
}

const ownWal = (): string => {
  const root = copyOf(sample);
  killedWriter(dbOf(root));
  return root;
};

/** The index replaced by another checkout's beside a killed writer's WAL. */
const foreignWal = (): string => {
  const root = copyOf(sample);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(replacement), dbOf(root));
  return root;
};

/** Opens the index in-process, capturing stderr; it stays open until the test ends unless closed. */
function open(root: string, readonly = false): DB {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
  try {
    const db = openDatabase(dbOf(root), { readonly });
    cleanup.push(() => db.open && closeDatabase(db));
    return db;
  } finally {
    vi.mocked(process.stderr.write).mockRestore();
  }
}

/** A foreign WAL set aside by a first open, which is closed again: the move-back is on offer. */
function setAsideRoot(): string {
  const root = foreignWal();
  closeDatabase(open(root));
  expect(aside(root)).toHaveLength(1);
  return root;
}

const HAS_OPEN =
  /which a running Atlas process has open: stop every Atlas process on the project \(`atlas serve`, `atlas mcp`\) first, then run any `atlas` command/;
const MOVE_BACK =
  /; if its writes belong there, stop every Atlas process on the project, then move it back to .*index\.db-wal before anything writes the index, otherwise delete it/;

describe('A45-01 SG190: the reminder while an Atlas process holds the index (G01, G03, M01, M03, R01)', () => {
  it('with a writable connection open (`atlas mcp`) the reminder says "has open", never "move it back"', () => {
    const root = setAsideRoot();
    open(root);
    const reader = open(root, true);
    expect(stderr.join('')).toMatch(HAS_OPEN);
    expect(stderr.join('')).not.toMatch(/move it back/);
    closeDatabase(reader);
  });

  it('with only a read-only connection open (`atlas serve`, not yet queried) it says "has open" too', () => {
    const root = setAsideRoot();
    open(root, true);
    open(root, true);
    expect(stderr.join('')).toMatch(HAS_OPEN);
    expect(stderr.join('')).not.toMatch(/move it back/);
  });

  it('without /proc/locks the probe finds the holder (G04)', () => {
    const root = setAsideRoot();
    open(root);
    hook.locks = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    open(root, true);
    expect(stderr.join('')).toMatch(HAS_OPEN);
    expect(stderr.join('')).not.toMatch(/move it back/);
  });

  it('once every holder is closed, the move-back says to stop every Atlas process first (M02)', () => {
    const root = setAsideRoot();
    const holder = open(root);
    closeDatabase(holder);
    open(root, true);
    expect(stderr.join('')).toMatch(MOVE_BACK);
    expect(stderr.join('')).not.toMatch(/has open/);
  });
});

/** A refusal at the check with SQLite error `code`, as in `leftoverWal`'s full-disk test. */
function refusal(code: string, msg: string): string {
  const root = ownWal();
  hook.open = (name) => {
    if (name.endsWith('.check')) throw new Database.SqliteError(msg, code);
  };
  try {
    open(root);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the open was not refused');
}

describe('A45-02 the cause and remedy of a "cannot check" refusal (T01, T02, T03, T05)', () => {
  it('a full disk, a quota, a size limit or a -shm that cannot grow says to free disk space', () => {
    for (const [code, msg] of [
      ['SQLITE_FULL', 'database or disk is full'],
      ['SQLITE_IOERR_SHMSIZE', 'disk I/O error'],
      ['SQLITE_IOERR_WRITE', 'disk I/O error'],
    ] as const) {
      expect(refusal(code, msg), code).toMatch(
        new RegExp(`\\(${code}: ${msg}\\); it is kept: free disk space \\(or fix the cause\\) and retry$`),
      );
    }
  });

  it('a read error says to fix the cause, never to free disk space', () => {
    for (const code of ['SQLITE_IOERR_READ', 'SQLITE_IOERR_SHORT_READ', 'SQLITE_IOERR']) {
      const m = refusal(code, 'disk I/O error');
      expect(m, code).toMatch(/\); it is kept: fix the cause and retry$/);
      expect(m, code).not.toMatch(/free disk space/);
    }
  });

  it('a cause whose message already starts with its code is not prefixed twice', () => {
    const root = ownWal();
    const row = 'SQLITE_CORRUPT: database disk image is malformed';
    hook.integrity = (name, n) => (name.endsWith('.check') ? [row, row][n] : undefined);
    hook.read = (p) => {
      if (p.endsWith('.check'))
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return undefined;
    };
    expect(() => open(root)).toThrow(
      /left by a process that stopped \(EIO: i\/o error, read\); it is kept: fix the cause and retry$/,
    );
  });
});

describe('A45-03 a short read names the file the user has, not the deleted check link (N01, N02)', () => {
  const UNUSED_ROW = '*** in database main ***\nPage 12: never used';
  for (const [label, suffix, name] of [
    ['index.db', '.check', /short read of [^ ]*\/index\.db at byte 0 of \d+\)/],
    ['index.db-wal', '.check-wal', /short read of [^ ]*\/index\.db-wal at byte 0 of \d+\)/],
  ] as const) {
    it(label, () => {
      const root = ownWal();
      hook.integrity = (n, i) => (n.endsWith('.check') ? [UNUSED_ROW, UNUSED_ROW][i] : undefined);
      hook.read = (p) => (p.endsWith(suffix) ? 0 : undefined);
      let msg = '';
      try {
        open(root);
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toMatch(name);
      expect(msg).not.toMatch(/\.check/);
    });
  }
});
