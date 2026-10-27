// AUDIT-41: API / SDK consistency, round 10 (CLI, HTTP, MCP, library exports). Each `it.fails`
// asserts the CORRECT behaviour and currently fails, reproducing one finding in AUDIT-41.md (IDs
// A41-xx). When a finding is fixed its test starts passing, `it.fails` turns red, and it should
// become a plain `it`. The plain `it` pins what the audit found consistent: SG150's `cannot check
// … (EIO: i/o error, read); it is kept` is one refusal on the CLI, `atlas serve`, `atlas mcp`, and
// the WAL is kept.
//
// Processes run as `node --import tsx` (see AUDIT-31). A "killed writer" commits and is SIGKILLed
// before it checkpoints. An `LD_PRELOAD` shim (built with `cc`; those tests are skipped without
// one) fails `pread` on the integrity check's hard link (`*.check`) from read EIO_FROM on, with
// EIO (EIO_MODE=eio) or by returning 0 bytes (EIO_MODE=zero), as a failing disk does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeDatabase } from '../../src/core/db/index.js';
import { openProjectIndex } from '../../src/core/project.js';
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
  const d = mkdtempSync(join(tmpdir(), 'atlas-audit41-'));
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

/** A replaced index beside a killed writer's WAL, which the first read sets aside. */
function setAsideByRead(): string {
  const root = indexed();
  const other = indexed(REPLACEMENT_FN);
  killedWriter(dbOf(root));
  copyFileSync(dbOf(other), dbOf(root)); // restore a backup over an index after a crash
  const first = cli(['search', 'add', '--cwd', root, '--limit', '1']);
  expect(first.code, first.err).toBe(0);
  expect(first.err).toMatch(/does not belong to .*; moved it to .*-wal\.foreign-/);
  return root;
}

let shimSo: string | undefined;
/** The `pread` shim (see the header). */
function shim(): string {
  if (shimSo) return shimSo;
  const dir = mkdtempSync(join(tmpdir(), 'atlas-audit41-shim-'));
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
  if (matches(fd) && seen++ >= atol(getenv("EIO_FROM") ? getenv("EIO_FROM") : "0")) {
    const char *m = getenv("EIO_MODE");
    if (m && strcmp(m, "zero") == 0) return 0;
    errno = EIO;
    return -1;
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
  return (shimSo = so);
}

const failing = (mode: 'eio' | 'zero'): NodeJS.ProcessEnv => ({
  LD_PRELOAD: shim(),
  EIO_SUFFIX: '.check',
  EIO_FROM: '3',
  EIO_MODE: mode,
});

/** `openDatabase` in another process under `env`: the class, code and message it throws. */
function libOpen(dbPath: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const lib = join(tmp(), 'open.mts');
  writeFileSync(
    lib,
    `import { openDatabase } from ${JSON.stringify(join(ROOT, 'src/core/index.ts'))};
     import Database from ${JSON.stringify(require.resolve('better-sqlite3'))};
     try { openDatabase(${JSON.stringify(dbPath)}); console.log('{}'); }
     catch (e) { console.log(JSON.stringify({ sqlite: e instanceof Database.SqliteError, code: e.code ?? null, message: e.message })); }`,
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', lib], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe('AUDIT-41 consistent surfaces (pinned)', () => {
  it.skipIf(!CC)(
    'SG150: a read error during the check gives one refusal, `cannot check … (EIO: i/o error, read); it is kept`, on the CLI (exit 1, stderr only), `atlas serve` and `atlas mcp`; the WAL is kept',
    async () => {
      const root = indexed();
      killedWriter(dbOf(root));
      const db = dbOf(root);
      const msg =
        `atlas: index ${db}: cannot check ${db}-wal, left by a process that stopped ` +
        '(EIO: i/o error, read); it is kept: free disk space (or fix the cause) and retry';
      for (const args of [
        ['search', 'add', '--cwd', root],
        ['index', root],
        ['drift', '--cwd', root, '--json'],
        ['docs', '--list', '--cwd', root],
        ['serve', '--cwd', root, '--port', '0'],
      ]) {
        expect(cli(args, failing('eio')), args[0]).toEqual({ out: '', err: msg, code: 1 });
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [...NODE_ARGS, 'mcp', '--offline', '--cwd', root],
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          ...(failing('eio') as Record<string, string>),
        },
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (d: Buffer) => (stderr += String(d)));
      const client = new Client({ name: 'audit41', version: '0.0.0' });
      cleanup.push(() => client.close().catch(() => undefined));
      await expect(client.connect(transport)).rejects.toThrow(/Connection closed/);
      await new Promise((ok) => setTimeout(ok, 200));
      expect(stderr.trim()).toBe(msg);
      expect(existsSync(`${db}-wal`)).toBe(true);
      expect(aside(root)).toEqual([]);
      // The disk is back: the killed writer's rows are read.
      const ok = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      expect(ok).toMatchObject({ code: 0, err: '' });
    },
    120_000,
  );
});

describe('AUDIT-41 findings', () => {
  it.fails(
    'A41-01: while `atlas serve` has the index open, the reminder does not offer the move-back, and following it does not leave the dashboard answering (200) from an index the CLI refuses as malformed',
    async () => {
      const root = setAsideByRead();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { db } = openProjectIndex(root, { readonly: true }); // a running `atlas serve`
      const handle = await startServer(db, root, { port: 0, host: '127.0.0.1' });
      cleanup.push(async () => {
        await handle.close();
        closeDatabase(db);
      });
      const held = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      expect(held.code, held.err).toBe(0);
      // Follow it, as the reminder says.
      const [name] = aside(root);
      renameSync(join(root, '.atlas', name!), `${dbOf(root)}-wal`);
      const after = cli(['search', 'add', '--cwd', root, '--limit', '1']);
      const stats = await fetch(new URL('/api/stats', handle.url));
      const body = (await stats.json()) as { docs?: number };
      // Today: `… if its writes belong there, move it back to <db>-wal before anything writes …`
      // is printed while the dashboard holds the index; after the move the CLI exits 1 (`unreadable
      // (database disk image is malformed) … delete <db> …`) while /api/stats answers 200 with the
      // set-aside WAL's 4 docs mixed into the replacement.
      expect(held.err).not.toMatch(/move it back/);
      expect(stats.status === 200, `${stats.status} vs exit ${after.code}`).toBe(after.code === 0);
      expect(body.docs ?? 0).toBe(0);
    },
    90_000,
  );

  (CC ? it.fails : it.skip)(
    'A41-02: the library throws every `cannot check` refusal as a SqliteError with a code, whatever stopped the check',
    () => {
      const root = indexed();
      killedWriter(dbOf(root));
      for (const mode of ['eio', 'zero'] as const) {
        const thrown = libOpen(dbOf(root), failing(mode));
        expect(thrown.message).toMatch(/cannot check .*; it is kept/);
        // Today: `eio` throws Node's `Error` with code 'EIO' (not a SqliteError); `zero` throws a
        // plain `Error` with no code at all. A full disk gives a SqliteError (AUDIT-37 pin).
        expect(thrown.sqlite, mode).toBe(true);
        expect(typeof thrown.code, mode).toBe('string');
      }
    },
    60_000,
  );

  (CC ? it.fails : it.skip)(
    'A41-03: a read error during the check is refused with a stable cause and the remedy the README gives, not "free disk space" and not a temporary file name',
    () => {
      const root = indexed();
      killedWriter(dbOf(root));
      const eio = cli(['search', 'add', '--cwd', root], failing('eio'));
      const zero1 = cli(['search', 'add', '--cwd', root], failing('zero'));
      const zero2 = cli(['search', 'add', '--cwd', root], failing('zero'));
      for (const r of [eio, zero1, zero2]) expect(r.code).toBe(1);
      // Today: `… (short read of <db>.<pid>.<ms>.check at byte 0 of …)`, a deleted hard link
      // whose name changes on every run.
      expect(zero1.err).not.toMatch(/\.check\b/);
      expect(zero1.err).toBe(zero2.err);
      // Today: `… it is kept: free disk space (or fix the cause) and retry` for an I/O error.
      expect(eio.err).not.toMatch(/free disk space/);
    },
    60_000,
  );

  it.fails(
    'A41-04: DECISIONS records SG150’s read-error rule, and its SG140 entry no longer says any result other than `ok` means the WAL does not fit',
    () => {
      const decisions = readFileSync(join(ROOT, 'DECISIONS.md'), 'utf8');
      const sg150 = decisions.split('\n').filter((l) => l.includes('SG150'));
      // Today: the one SG150 line covers only A36-02 (the reminder).
      expect(sg150.join('\n')).toMatch(/EIO|I\/O error|read error/);
      expect(decisions).not.toMatch(/or a result other than `ok`\) counts as "does not fit"/);
    },
  );
});
