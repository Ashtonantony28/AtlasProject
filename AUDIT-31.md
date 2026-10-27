# AUDIT-31: API and SDK consistency, round 8

This audit checks how the CLI, the dashboard HTTP API (`atlas serve`), the MCP tools (SDK and stdio) and the
`@atlas/core` exports report a busy, deleted or replaced index, and whether the README, `DECISIONS.md` and `PLAN.md`
match what they do. There has been no change to `src/`, `README.md` or `DECISIONS.md` since AUDIT-27 (`git diff
6923d13 HEAD` touches only `AUDIT-29.md`, its test, `PLAN.md` and `.atlas/docs`). So this round looks again at
SG80 and SG90 from the angles AUDIT-27 did not take:
- how a process stops;
- what happens when `index.db` is replaced, not deleted;
- the read-only dashboard on an index that is still being created.

Base: `41e057a` on `claude/atlas-audit-31`. The auditor wrote none of this code. The SDKs are
`@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1, with better-sqlite3 11.10.0 (SQLite 3.49.2).
Node 22.22.

**Method.** I copied `fixtures/sample` (and, for one check, a generated 1,500-file repo) into scratch directories
and drove them in these ways:
- through the CLI built with `tsc` (`node dist/cli/index.js`), through `node --import tsx src/cli/index.ts`, and
  in-process through `buildProgram()`;
- through `atlas mcp --offline` over stdio with the stock SDK `Client` + `StdioClientTransport`, stopped by closing
  stdin, by SIGTERM or by SIGINT, and through `createMcpContext` in-process;
- through `atlas serve` (curl) and `startServer` on a read-only connection (fetch);
- with another process holding the SQLite write lock on a 0-byte `index.db`;
- by deleting `index.db*` with no process holding it, and with a stopped `atlas mcp`'s WAL left beside it;
- by replacing `index.db` with another project's index:
  - with `cp`, beside a stale WAL;
  - with `mv`, while `atlas mcp` (after `atlas_index`) or `atlas serve` held the old file.

One harness note matters for every process test. The `tsx` binary relays SIGTERM/SIGINT to a child that leaves
through `process.exit`, so the `'exit'` handler closes the index. The built binary and `node --import tsx` do not
do this. Under `tsx`, A31-02 cannot be seen. `audit-31.test.ts` therefore spawns `node --import tsx`.

Repros live in `test/audit/audit-31.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it`
and confirmed that it fails on its stated assertion, not on a harness error (the messages are listed under each
finding). The file ran green in 5 of 5 runs (12.3–12.7 s each). The three plain `it` tests pin what the audit found
consistent.

**Totals:** 0 critical, 1 high, 2 medium, 1 low. Nothing has been fixed since AUDIT-27. Still open, with their
`it.fails` still failing:
- A27-01..A27-05 and A23-03..A23-05;
- A19-02..A19-05;
- A15-02 (mitigated) and A15-04..A15-07.

## Findings

### Critical

None found.

### High

**A31-01: an `index.db` replaced beside a stale WAL is silently mixed with that WAL. Read surfaces then answer from
a corrupt index with exit 0, HTTP 200 and no `isError`. Write surfaces fail with a bare
`database disk image is malformed` on every run until the user deletes the file, which no surface or document
says to do.** High.
- **Evidence:** SQLite replays any `-wal` it finds beside the file it opens. The WAL does not identify the database
  it belongs to. SG90 keeps a stale WAL out of a *missing* index only, so `rm index.db && atlas index` is safe.
  `cp other.db index.db` and `mv other.db index.db` are not. Stale WALs are common:
  - a killed or crashed run leaves one;
  - so does Ctrl-C of `atlas index` (1,500-file repo, SIGINT at 4 s: exit 130, a 4.3 MB `index.db-wal` left);
  - so does every `atlas mcp` stopped by a signal (A31-02).

  Repro (sample copy `A` indexed, then a committed write SIGKILLed before checkpoint; `B` = the sample plus
  `replacementOnlyFn`, indexed; then `cp B/.atlas/index.db A/.atlas/index.db`):
  - `atlas search replacementOnlyFn --cwd A` exits 0 with `0.016 function add (src/math.ts:4)`. The symbol is in
    the `symbols` table, but FTS and vectors come from the old WAL.
  - `atlas graph` exits 0. `atlas docs --list` exits 0 and lists the 5 persisted docs.
  - `atlas drift` exits 1 with `no docs found in the index (run \`atlas docs\` first)`. Docs had been generated, so
    this names the wrong cause.
  - `atlas_search` returns `add`, and `atlas_symbol {name: 'replacementOnlyFn'}` returns `[]`, both without
    `isError`.
  - `atlas_index` returns `isError` with `database disk image is malformed`, and `atlas_drift` returns `isError`
    with `no docs found in the index …`.
  - `/api/stats` returns 200 `{"files":4,"symbols":25,"edges":15,"docs":5}`, and
    `/api/search?q=replacementOnlyFn` returns 200 `[{"name":"add",…}]`.
  - `atlas index` exits 1 with `atlas: database disk image is malformed`, again on the next run. `integrity_check`:
    `wrong # of entries in index idx_symbols_qualified`, with 24 rows still carrying the old WAL's docstrings.
  - Only `rm .atlas/index.db && atlas index` recovers (SG90 then drops the WAL).

  `nameBusy` names only `SQLITE_BUSY*`, so `SQLITE_CORRUPT` reaches every surface raw, with no step, cause or
  remedy. The README does not say that `index.db`, `-wal` and `-shm` belong together, or how to reset (A27-05).
  `DECISIONS.md` (SG90) describes the replay hazard for a deleted index only.
- **Impact:** restoring a backup, or copying the index from another checkout or worktree to skip a long first
  index, after any Ctrl-C or editor restart gives wrong search, symbol and graph answers on the CLI, dashboard and
  MCP, all reported as success. Every later `atlas index` and `atlas_index` then fails with an error that points at
  disk damage, not at the leftover WAL. This is A25-01 (the SG90 trigger) reached by `cp` instead of `rm`, with the
  same result.
- **Test:** `A31-01`. As a plain `it`, it fails with
  `expected 'database disk image is malformed' not to be 'database disk image is malformed'`.
- **Repro:**
  1. `atlas index A` and `atlas index B`.
  2. `node -e "const D=require('better-sqlite3');const db=new D('A/.atlas/index.db');db.exec(\"UPDATE symbols SET docstring='x'\");process.kill(process.pid,'SIGKILL')"`
     (or Ctrl-C a running `atlas index A`).
  3. `cp B/.atlas/index.db A/.atlas/index.db`.
  4. `atlas search replacementOnlyFn --cwd A` (exit 0, `add`), then `atlas index A` (exit 1,
     `atlas: database disk image is malformed`).
- **Location:** `src/core/db/database.ts:40-73` (the stale-WAL guard covers only `!existsSync(dbPath)`, line 41),
  `:154-164` (`nameBusy`), `src/cli/index.ts:6-9`, `src/web/server.ts:211-213`, `README.md` (no reset or backup
  note).

### Medium

**A31-02: `atlas mcp`, `atlas index` and `atlas docs` exit on SIGTERM or SIGINT without closing the index, unlike
`atlas serve`. A stopped `atlas mcp` leaves a 4 KB `index.db` with the whole index in `index.db-wal`.** Medium.
- **Evidence:**
  - `serveCmd.ts` handles SIGINT/SIGTERM and calls `closeDatabase`.
  - `startMcpServer` closes only in `process.once('exit')`, which a fatal signal skips.
  - `index` and `docs` install no handler.

  Results (built `dist`, `atlas_index` on the sample, then stop):
  | Stop | Left in `.atlas/` |
  | --- | --- |
  | Close stdin | `index.db` 1,736,704 bytes, no WAL |
  | SIGTERM | `index.db` 4,096, `-shm` 32,768, `-wal` 2,113,592 |
  | SIGINT | `index.db` 4,096, `-shm` 32,768, `-wal` 2,113,592 |

  The SDK's own `StdioClientTransport.close()` ends stdin first, so a client built on it stops the server cleanly.
  A client or terminal that signals does not.

  The next opener replays the WAL, so a reused index is not damaged (pinned: `rm index.db && atlas index` after a
  SIGTERM gives a fresh index that a new `atlas mcp` serves). But:
  - every such stop leaves the stale WAL that A31-01 needs;
  - a copy or backup of `index.db` taken then (`cp .atlas/index.db …`) is a 4 KB file with no tables.

  The `tsx` wrapper hides this: under `tsx` the same SIGTERM leaves a closed, complete index. So the existing
  stdio tests, which spawn `tsx`, cannot catch it.
- **Impact:** the surfaces behave differently on shutdown. The documented editor setup leaves the index in its
  most fragile state, and the README describes none of it.
- **Test:** `A31-02` (`expected true to be false`: `index.db-wal` exists after SIGTERM).
- **Location:** `src/mcp/server.ts:439-443`, `src/cli/commands/serveCmd.ts:29-36` (the one surface that closes),
  `src/cli/commands/indexCmd.ts`, `src/cli/commands/docsCmd.ts`.

**A31-03: an `index.db` renamed into place while `atlas mcp` holds the old one is invisible to every surface,
including the CLI. The CLI's next write then makes the replacement permanently lost.** Medium.
- **Evidence:** the server, after `atlas_index {force: true}`, holds the old file, its live `-wal` and `-shm`. I ran
  `mv B/.atlas/index.db A/.atlas/index.db`. The new file shares the holder's WAL and shm:
  - `atlas search replacementOnlyFn --cwd A` exits 0 with `Counter.increment`;
  - `atlas index A` exits 0 with `indexed 0, skipped 4 … totals: files=4 symbols=24` (the old index's counts);
  - `atlas_symbol` returns `[]`, and `atlas_index` returns `indexed 0, skipped 4`;
  - after every process exits, the file at the path is a healthy copy of the *old* index: 24 symbols, no
    `replacementOnlyFn`, integrity `ok`. B's content is gone.

  With `atlas serve` (read-only) as the holder, and a CLI writer that has since exited, the same `mv` is taken up
  correctly. This is the A27-02 split (a server pinned to the inode it opened), reached by a replacement. Here the
  CLI is affected too, and no surface reports anything.
- **Impact:** the "replaced" case gives no error anywhere. The user's replacement silently disappears, and the
  index keeps describing the old tree.
- **Test:** `A31-03` (`expected '0.010  method    Counter.increment  (…' to match /replacementOnlyFn/`).
- **Location:** `src/mcp/server.ts:72` (one connection for the session), `:135-149` (`reloadConfig` compares the
  path only), `src/core/db/database.ts:40-73`.

### Low

**A31-04: `atlas serve` on a 0-byte index answers every `/api/*` route with 500 `no such table: …`, while
`/api/health` says `ok`. The CLI read commands treat the same file as an empty index.** Low.
- **Evidence:** a 0-byte `index.db` can exist in two ways. One is SG90's own window: SQLite creates the 0-byte
  file, and a run killed before migrating leaves it. The other is a `touch`. On that file:
  - `atlas search|graph|drift|ask` open read-write, migrate it, and exit 1 with
    `index is empty: run \`atlas index\` first`. `docs --list` prints `no docs yet` and exits 0.
  - `atlas serve` opens it read-only, with no migration and no `requireIndexed`:
    - `/api/stats`, `/api/files`, `/api/docs` → 500 `{"error":"no such table: files"}`;
    - `/api/graph` → 500 `no such table: symbols`;
    - `/api/search?q=area` → 500 `no such table: embeddings_vec`;
    - `/api/health` → 200 `{"ok":true,…}`.

  `/api/health` never touches the index. It also says `ok` for a deleted, replaced (A31-01) or busy index.
  AUDIT-29 saw the same `no such table` on readers that open during creation.
- **Impact:** the dashboard shows an internal SQL error where the CLI gives a remedy, and the health check cannot
  tell a usable index from an unusable one. This adds to A11-06 (`/api/search` returns 200 on an empty index).
- **Test:** `A31-04` (`expected 'no such table: files' not to match /no such table/`).
- **Location:** `src/cli/commands/serveCmd.ts:22`, `src/core/project.ts:38-56`, `src/web/server.ts:86-94`.

## Scope checks

- **Busy (SG80/SG90), every surface (pinned, here and in AUDIT-27):**
  - one message, `<step>: database is locked (another process is writing the index; retry when it finishes)`, on:
    - `atlas index` and `atlas docs` (exit 1);
    - `atlas_index` (`isError`, SDK and stdio);
  - `atlas mcp` started on a 0-byte index held past 5 s exits 1, with nothing on stdout and
    `atlas: journal mode: database is locked (…)` on stderr (new pin, stdio). The SDK client sees
    `MCP error -32000: Connection closed`;
  - `serve` is read-only and never sees `SQLITE_BUSY`;
  - the library still throws a bare `database is locked` (A27-04).
- **Deleted, no process holding it (pinned):**
  - `search`, `graph`, `drift`, `ask`, `docs --list` and `serve` all exit 1 with
    `no index at <db>: run \`atlas index\` first` and create nothing;
  - `atlas mcp` creates the index on start, and its read tools say `index is empty: call atlas_index first`.
    That matches the README.
- **Deleted, with a holder:** a writing `atlas mcp` makes the next CLI open fail with `atlas: disk I/O error`
  (A27-01, A29-01). The server keeps serving and writing the unlinked file (A27-02). Both are unchanged.
- **Deleted after a signal-stopped `atlas mcp` (stale WAL holding the whole index):** `rm index.db && atlas index`
  gives an index with integrity `ok`, and a fresh `atlas mcp` serves the new symbols (pinned). SG90's promise holds
  for this source of stale WALs.
- **Replaced:** see A31-01 (stale WAL), A31-03 (live `atlas mcp`). With a live read-only `atlas serve` and no WAL
  left, the CLI takes the replacement up; `serve` keeps answering from the inode it opened (A27-02).
- **Error mapping:** every surface passes non-busy SQLite errors (`SQLITE_IOERR_SHORT_READ`, `SQLITE_CORRUPT`,
  `no such table`) through raw:
  - CLI `atlas: <message>`, exit 1;
  - MCP `isError` text;
  - HTTP 500 `{"error": …}`.

  None names the index file or a remedy.
- **Exit codes:** unchanged. `drift` keeps 0/1/2. Every open or lock error exits 1. `atlas index` killed by SIGINT
  exits 130 and prints nothing.
- **Exports:** `src/core/index.ts` is unchanged. `openDatabase`, `closeDatabase`, `nameBusy` and the repo helpers
  behave as the CLI does under A31-01 (no extra guard), and `immediate` is still not exported (A27-04).
- **Docs vs behaviour:**
  - The SG90 entry in `DECISIONS.md` is accurate for a stale WAL beside a *missing* index (re-confirmed after a
    SIGTERM'd `atlas mcp`).
  - The SG90 entry is silent on a replaced index (A31-01).
  - The `PLAN.md` SG90 row's "`rm .atlas/index.db && atlas index` gives a fresh, healthy index" is still false while
    a writing `atlas mcp` runs (A27-01).
  - The README still mentions none of the lock, busy wait, crash, reset or shutdown behaviour (A27-05, A23-05,
    A15-07).

## Re-verified

All AUDIT-15, AUDIT-19, AUDIT-23 and AUDIT-27 tests pass on this base (43 tests, 39.5 s). Every `it.fails` among
them still fails as intended. Since AUDIT-27 there has been no code or README change, so each status below is as
AUDIT-27 left it:
- **A27-01** (bare `disk I/O error` on reset beside a writing `atlas mcp`): open. Extended by A31-03 to a replaced
  index.
- **A27-02** (server answers from, and writes to, the deleted file): open.
- **A27-03** (`immediate()` blocks the MCP event loop for up to 5 s): open.
- **A27-04** (library write helpers throw a bare `database is locked`; `immediate` not exported): open.
- **A27-05** (no crash or reset guidance in the README): open. A31-01 and A31-02 add the replacement and shutdown
  cases.
- **A23-03** (parallel `atlas_ask` capped by reservations fails as `incomplete response`): open.
- **A23-04** ("retry when they finish" can be false): open.
- **A23-05** (README/DECISIONS gaps): partly fixed in AUDIT-27 (SG80 and SG90 entries). The README part is open.
- **A19-02** (only `atlas_ask` and `atlas_index` reload the config): open. A27-02 and A31-03 are the same split.
- **A19-03** (forced re-index empties the vectors until the embed phase): open.
- **A19-04** (README lacks SG34/SG40/SG50): open.
- **A19-05** (`getLastRun` returns an unfinished run): open.
- **A15-02** (mitigated): open.
- **A15-04** (cut-short `docs` gives no cause without `-v`): open.
- **A15-05** (`--force` hides the extractor upgrade): open.
- **A15-06** (actual usage can exceed the cap): open.
- **A15-07** (README lacks the index lock): open.

New SG rows: SG120 (A31-01, with A31-02, which is the main source of the stale WALs it needs).
