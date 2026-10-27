// AUDIT-44: API / SDK consistency, round 11 (CLI, HTTP, MCP, library exports). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-44.md (IDs
// A44-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. The plain `it` pin what the audit found consistent after SG190: while any
// Atlas process holds the index, the CLI reminder says to stop it and never offers the move-back,
// on stderr only, and every read surface prints the same stdout and exit code with or without a
// set-aside WAL.
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. An `LD_PRELOAD` shim (built with `cc`; those tests are skipped without
// one) fails `pread` calls EIO_FROM .. EIO_FROM+EIO_COUNT-1 on the integrity check's hard link
// (`*.check`) with EIO, as a failing disk does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase } from '../../src/core/db/index.js';
import { openProjectIndex } from '../../src/core/project.js';
import { createMcpContext } from '../../src/mcp/server.js';
import { startServer } from '../../src/web/server.js';
import { SAMPLE } from '../cli/helpers.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const NODE_ARGS = ['--import', 'tsx', CLI];
const BSQ = JSON.stringify(require.resolve('better-sqlite3'));
const REPLACEMENT_FN = '\nexport function replacementOnlyFn(): number { return 7; }\n';
const CC = spawnSync('cc', ['--version']).status === 0;

const dirs: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit44-'));
  dirs.push(d);
  return d;
}

const dbOf = (root: string): string => join(root, '.atlas', 'index.db');
const aside = (root: string): string[] =>
  readdirSync(join(root, '.atlas')).filter((f) => f.includes('.foreign-'));

interface Run {
  out: string;
  err: string;
  code: number | null;
}

/** The real CLI in another process. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { out: r.stdout, err: r.stderr.trim(), code: r.status };
}

/** A copy of the sample (optionally with `extra` appended to src/app.ts), indexed and closed. */
function indexed(extra?: string): string {
  const root = join(tmp(), 'repo');
  cpSync(SAMPLE, root, { recursive: true });
  if (extra) appendFileSync(join(root, 'src', 'app.ts'), extra);
  const r = cli(['index', root]);
  expect(r.code, r.err).toBe(0);
  return root;
}

/** A committed write (rows and one doc per file) SIGKILLed before any checkpoint. */
function killedWriter(dbPath: string): void {
  const r = spawnSync(process.execPath, [
    '-e',
    `const D = require(${BSQ});
     const db = new D(${JSON.stringify(dbPath)});
     db.exec("UPDATE symbols SET docstring = 'STALE-WAL-' || id; INSERT INTO docs (target_kind, target_id, content, source_hash, generated_at) SELECT 'file', id, 'DOC-FOR-' || path, 'h', '2026-10-27' FROM files");
     process.kill(process.pid, 'SIGKILL');`,
  ]);
  expect(r.signal).toBe('SIGKILL');
}

/** A backup restored over an index after a crash: the replacement beside the killed writer's WAL. */
function foreign(): string {
  const root = indexed();
  const other = indexed(REPLACEMENT_FN);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(other), dbOf(root));
  return root;
}

/** `foreign()`, after the first read has set the WAL aside. */
function setAsideByRead(): string {
  const root = foreign();
  const first = cli(['search', 'add', '--cwd', root, '--limit', '1']);
  expect(first.code, first.err).toBe(0);
  expect(first.err).toMatch(/does not belong to .*; moved it to .*-wal\.foreign-/);
  return root;
}

/** Runs `fn` with `process.stderr.write` captured; returns what it wrote. */
function stderrOf(fn: () => void): string {
  let text = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return text;
}

let shimSo: string | undefined;
/** The `pread` shim (see the header). */
function shim(): string {
  if (shimSo) return shimSo;
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit44-shim-'));
  writeFileSync(
    join(dir, 'shim.c'),
    `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static long seen = 0;
static int matches(int fd) {
  const char *s = getenv("EIO_SUFFIX");
  char p[64], t[4096];
  if (!s) return 0;
  snprintf(p, sizeof p, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(p, t, sizeof t - 1);
  if (n < 0) return 0;
  t[n] = 0;
  size_t ls = strlen(s);
  return (size_t)n >= ls && strcmp(t + n - ls, s) == 0;
}
ssize_t pread64(int fd, void *buf, size_t c, off_t o) {
  static ssize_t (*real)(int, void *, size_t, off_t);
  if (!real) real = dlsym(RTLD_NEXT, "pread64");
  if (matches(fd)) {
    long k = seen++, from = atol(getenv("EIO_FROM") ? getenv("EIO_FROM") : "0");
    long count = atol(getenv("EIO_COUNT") ? getenv("EIO_COUNT") : "-1");
    if (k >= from && (count < 0 || k < from + count)) {
      errno = EIO;
      return -1;
    }
  }
  return real(fd, buf, c, o);
}
ssize_t pread(int fd, void *buf, size_t c, off_t o) __attribute__((alias("pread64")));
`,
  );
  const so = join(dir, 'shim.so');
  const r = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-o', so, join(dir, 'shim.c'), '-ldl'], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  dirs.push(dir);
  return (shimSo = so);
}

describe('AUDIT-44 consistent surfaces (pinned)', () => {
  it('SG190: while `atlas mcp` holds the index, the CLI says to stop every Atlas process and never offers the move-back, on stderr only; stdout and the exit code are those of a free index', () => {
    const root = setAsideByRead();
    const ctx = createMcpContextQuiet(root);
    const held = cli(['search', 'add', '--cwd', root, '--limit', '1', '--json']);
    closeDatabase(ctx.db);
    const free = cli(['search', 'add', '--cwd', root, '--limit', '1', '--json']);
    expect(held.err).toMatch(
      /was set aside from .*, which a running Atlas process has open: stop every Atlas process on the project \(`atlas serve`, `atlas mcp`\) first/,
    );
    expect(held.err).not.toMatch(/move it back/);
    expect(free.err).toMatch(/stop every Atlas process on the project, then move it back to /);
    expect(held.code).toBe(free.code);
    expect(JSON.parse(held.out)).toEqual(JSON.parse(free.out));
    expect(aside(root)).toHaveLength(1);
  }, 90_000);

  it('the set-aside reminder is one stderr line before what a read surface prints without it: stdout, the rest of stderr and the exit code are unchanged (search, search --json, drift --json, docs --list, graph)', () => {
    const root = setAsideByRead();
    const surfaces = [
      ['search', 'add', '--cwd', root, '--limit', '1'],
      ['search', 'add', '--cwd', root, '--limit', '1', '--json'],
      ['drift', '--cwd', root, '--json'],
      ['docs', '--list', '--cwd', root],
      ['graph', '--format', 'json', '--cwd', root, '--limit', '5'],
    ];
    const withAside = surfaces.map((a) => cli(a));
    rmSync(join(root, '.atlas', aside(root)[0]!));
    const without = surfaces.map((a) => cli(a));
    surfaces.forEach((a, i) => {
      const [first, ...rest] = withAside[i]!.err.split('\n');
      expect(first, a.join(' ')).toMatch(/^atlas: .*-wal\.foreign-.* was set aside from .*/);
      // `drift` with no docs exits 1 with its own line after the reminder, as without it.
      expect({ out: withAside[i]!.out, err: rest.join('\n'), code: withAside[i]!.code }).toEqual(
        without[i],
      );
    });
  }, 120_000);
});

/** `createMcpContext` (a running `atlas mcp`), its startup reminder swallowed. */
function createMcpContextQuiet(root: string): ReturnType<typeof createMcpContext> {
  let ctx: ReturnType<typeof createMcpContext> | undefined;
  stderrOf(() => {
    ctx = createMcpContext({ root, offline: true });
  });
  return ctx!;
}

describe('AUDIT-44 findings', () => {
  it.fails(
    'A44-01: a starting `atlas serve` (or `atlas mcp`) does not offer the move-back, and following its reminder while it runs leaves an index that passes `integrity_check`',
    async () => {
      const root = setAsideByRead();
      let db: ReturnType<typeof openProjectIndex>['db'] | undefined;
      const startup = stderrOf(() => {
        db = openProjectIndex(root, { readonly: true }).db; // what `atlas serve` runs
      });
      const handle = await startServer(db!, root, { port: 0, host: '127.0.0.1' });
      let closed = false;
      const stop = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await handle.close();
        closeDatabase(db!);
      };
      cleanup.push(stop);
      // Follow it, as the server's own line says.
      const [name] = aside(root);
      renameSync(join(root, '.atlas', name!), `${dbOf(root)}-wal`);
      const during = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      const stats = await fetch(new URL('/api/stats', handle.url));
      await stop();
      const check = new Database(dbOf(root), { readonly: true, fileMustExist: true });
      const integrity = String(check.pragma('integrity_check(1)', { simple: true }));
      check.close();
      const after = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      expect(during.code).toBe(0);
      expect(stats.status).toBe(200);
      // Today: `… if its writes belong there, stop every Atlas process on the project, then move
      // it back to <db>-wal before anything writes the index …`, printed by the process that holds
      // the index from the next line on.
      expect(startup).not.toMatch(/move it back/);
      // Today: `wrong # of entries in index idx_symbols_qualified`, and every command then exits 1
      // with `unreadable (database disk image is malformed) … delete <db> …`.
      expect(integrity).toBe('ok');
      expect(after.code, after.err).toBe(0);
    },
    90_000,
  );

  (CC ? it.fails : it.skip)(
    'A44-02: a `cannot check` refusal is one line on stderr, whatever SQLite reported',
    () => {
      const root = foreign();
      const r = cli(['search', 'add', '--cwd', root, '--limit', '1'], {
        LD_PRELOAD: shim(),
        EIO_SUFFIX: '.check',
        EIO_FROM: '10',
        EIO_COUNT: '1',
      });
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toMatch(
        /^atlas: index .*: cannot check .*-wal, left by a process that stopped/,
      );
      expect(r.err).toMatch(/it is kept: fix the cause and retry$/);
      expect(existsSync(`${dbOf(root)}-wal`)).toBe(true);
      // Today: `… (a page could not be read: *** in database main ***\nTree 3 page 3: unable to get
      // the page. error code=8458); it is kept …`: two lines, the second without `atlas: `.
      expect(r.err.split('\n')).toHaveLength(1);
    },
    90_000,
  );
});
