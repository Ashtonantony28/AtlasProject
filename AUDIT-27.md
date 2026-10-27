# AUDIT-27: API and SDK consistency, round 7

This audit checks that the changes since AUDIT-23 behave the same way on the CLI, the dashboard HTTP API
(`atlas serve`), the MCP tools and the `@atlas/core` exports, and that they match the README, `DECISIONS.md` and the
config schema. The changes are:
- SG80: the `immediate()` helper (`BEGIN IMMEDIATE`, retried every 10 ms up to the 5 s busy timeout) now wraps every
  write transaction of an index run, `upsertDoc` and `deleteFile`. Every `SQLITE_BUSY` reads
  `<step>: database is locked (another process is writing the index; retry when it finishes)`, including
  `atlas docs` (step `docs write`).
- SG90: `openDatabase` no longer pre-creates a WAL file when a stale `-wal` exists beside a missing index. An empty
  index file that another process is switching to WAL is now waited out for up to 5 s, instead of failing at once with
  `journal mode: …`.

Base: `ba14fd7` (SG90 merged) on `claude/atlas-audit-27`. The auditor wrote none of this code. The SDKs are
`@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1, with better-sqlite3 11.10.0 (SQLite 3.49.2).
Node 22.22.

**Method.** I copied `fixtures/sample` (and, for the crash checks, a generated 1,500-file repo) into scratch
directories and drove them in these ways:
- through the real CLI (`tsx src/cli/index.ts`) as separate processes, reading every output, exit code and wall time,
  and in-process through `buildProgram()`;
- through `atlas mcp --offline` over stdio with the stock SDK `Client` + `StdioClientTransport`, and through
  `createAtlasMcpServer` over `InMemoryTransport`;
- through `atlas serve` and `startServer` on a read-only connection (`/api/*` with curl and fetch);
- with another process holding the index's SQLite write lock (`BEGIN IMMEDIATE` on `index.db`), either once for
  9–20 s, or for 1 s at a time with 20 ms gaps (as a concurrent `atlas docs` does);
- with another process holding a 0-byte `index.db`;
- by `kill -9` of a running `atlas index --force`, and by a child that stamps a run and SIGKILLs itself;
- by deleting `index.db` (alone, or with its `-wal`/`-shm`) while `atlas mcp` and `atlas serve` run, then running
  `atlas index`, as the SG90 row says a user can.

Repros live in `test/audit/audit-27.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it` and
confirmed that it fails on its stated assertion, not on a harness error (the messages are listed under each finding).
The state- and timing-dependent ones (A27-01, A27-02, A27-03) failed as intended in 5 of 5 runs. The five plain `it`
tests pin what the audit found consistent.

**Totals:** 0 critical, 0 high, 3 medium, 2 low. Fixed since AUDIT-23, and pinned: A23-01 and A23-02 (SG80). Partly
fixed: A23-05 (`DECISIONS.md` now has SG80 and SG90 entries). Still open: A23-03, A23-04 and A23-05; A19-02, A19-03,
A19-04 and A19-05; A15-02 (mitigated), A15-04, A15-05, A15-06 and A15-07; A11-04 and A11-06..A11-11; A7-06, A7-07,
A7-09 and A7-11; A3-11 and A3-13.

## Findings

### Critical

None found.

### High

None found.

### Medium

**A27-01: the SG90 reset, `rm .atlas/index.db && atlas index`, fails with a bare `atlas: disk I/O error` while an
`atlas mcp` that has indexed in this session is running. The error names no step, cause or remedy, and every command
fails the same way until the server exits.** Medium.
- **Evidence:** the SG90 row says that deleting the index "gives a fresh, healthy index", and `DECISIONS.md` says
  Atlas leaves the `-wal` beside a deleted index to SQLite. That is true when the `-wal` is stale. In the documented
  editor workflow, the `-wal` and `-shm` beside the deleted file belong to the `atlas mcp` process, which still has
  the old file open. Results, 3 of 3 runs over stdio and 5 of 5 in the test:
  - **After `atlas_index` on the running server:** I deleted `.atlas/index.db` only. `atlas index` then exited 1 after
    about 1 s with `atlas: disk I/O error` (`SQLITE_IOERR_SHORT_READ`), and `atlas search` failed the same way. A
    4 KB `index.db` and a 0-byte `-wal` were left behind. Repeated opens failed while the server lived. The CLI
    recovered only after the server exited or wrote again.
  - **When the server had only read, or with a plain read-only `atlas serve`:** the same steps succeeded.
  - **Deleting `index.db`, `-wal` and `-shm` together:** `atlas index` succeeded (see A27-02 for what the server then
    serves).

  `nameBusy` only handles `SQLITE_BUSY*`, and the SG90 retry only handles `SQLITE_BUSY` and
  `SQLITE_IOERR_DELETE_NOENT`, so this error reaches the user raw. "disk I/O error" points at hardware, not at the
  server that is still running. Before SG90, the same steps replayed the live WAL into the new file (A25-01), so this
  is an improvement, but the stated remedy does not hold.
- **Impact:** a user who resets the index while their editor's `atlas mcp` runs (the usual case) gets an error that
  says nothing useful, and no document says to stop the server first (A27-05).
- **Test:** `A27-01`. As a plain `it`, it fails with
  `expected 'atlas: disk I/O error' not to be 'atlas: disk I/O error'`.
- **Repro:** `createMcpContext` on an indexed copy, then `handleIndexTool(ctx, {force: true})` and
  `rm .atlas/index.db`. Then run `tsx src/cli/index.ts index <root>` as another process.
- **Location:** `src/core/db/database.ts:40-72` (open path when `<db>-wal` exists, line 45), `:102-117`
  (`switchToWal` retries only two codes), `:154-164` (`nameBusy` only names `SQLITE_BUSY*`).

**A27-02: after the index is deleted and rebuilt, a running `atlas mcp` (and `atlas serve`) keeps answering from the
deleted file, and its `atlas_index` keeps writing to that file, with no sign of either.** Medium.
- **Evidence:** `createMcpContext` and `startServer` hold the connection they opened at startup. SG40's
  `reloadConfig` compares only the path (`dbPath !== ctx.db.name`), and a deleted and recreated `index.db` has the
  same path. With `atlas mcp` and `atlas serve` running, I deleted `index.db*`, added `brandNewFn` to `src/app.ts`, and
  ran `atlas index` on the CLI:
  - CLI `atlas search brandNewFn` → `brandNewFn (src/app.ts:16)`.
  - `atlas_symbol {name: 'brandNewFn'}` → `[]`. `atlas_search`, `atlas_graph` and `/api/stats` answer from the old
    file.
  - `atlas_index {force: true}` → succeeds, and writes the old, unlinked file. Those rows vanish when the server
    exits. The CLI never sees them.

  This is A19-02's frozen-index split, reached by the reset instead of an `indexPath` edit, and here even
  `atlas_index` does not notice.
- **Impact:** after a reset, an agent gets answers from an index that no longer exists, and its re-index calls do no
  durable work, until the server restarts.
- **Test:** `A27-02` (`expected [] to not deeply equal []`).
- **Location:** `src/mcp/server.ts:72` (one connection for the session), `:135-148` (`reloadConfig` checks the path
  only), `src/cli/commands/serveCmd.ts:22`.

**A27-03: while `atlas_index` waits for another process's write lock, the whole MCP server stops answering. An
`atlas_search` issued meanwhile waits up to 5 s, although readers in other processes answer at once.** Medium.
- **Evidence:** `immediate()` retries `BEGIN IMMEDIATE` in a synchronous loop (`for (;;)`, each try blocking for up
  to the 10 ms `busy_timeout`) for up to 5 s, on the event loop shared by every tool. Measured over stdio, with
  `atlas_search` issued 300 ms after `atlas_index {force: true}`:
  - **Lock held for 8 s:** the first search took **4,719 ms**. `atlas_index` failed at 5,015 ms with
    `run stamp: … retry when it finishes`.
  - **Lock held for 1 s at a time with 20 ms gaps:** three successive searches took 723, 812 and 820 ms. The run
    succeeded in 3.1 s.
  - **Same holds, from other processes:** CLI `search`, CLI `drift` and `/api/stats` answered in under 2 s (pinned).

  Before SG80, the `run stamp` statement already blocked for up to 5 s in SQLite's busy handler. The other steps
  failed at once (A23-01), so they never blocked. SG80 makes every write step a blocking wait: per-file, prune,
  resolve, each embedding batch and the finish stamp. `DECISIONS.md` (SG32) rejected SQLite's busy handler for the
  index lock because it "would block the event loop (and an MCP server)". `immediate()` does exactly that for up to
  5 s per step. AUDIT-23 pinned "reads never wait" only across processes. The README promises nothing either way.
- **Impact:** an agent's read calls stall, and can hit client timeouts, whenever its own `atlas_index` contends with
  a user's `atlas docs`. On the CLI and the dashboard, the same reads do not stall. This adds to A15-02, where the
  `atlas_index` call itself exceeds the timeout.
- **Test:** `A27-03` (`expected 5016 to be less than 1500`).
- **Location:** `src/core/db/database.ts:125-146` (`immediate`), `src/core/ingest/lock.ts:9` (the non-blocking rule
  that SG32 set).

### Low

**A27-04: the remedy reaches the CLI and MCP but not the library. The exported write helpers throw a bare
`database is locked`, and `immediate` is not exported beside `nameBusy`.** Low.
- **Evidence:** `upsertDoc` and `deleteFile` are part of `@atlas/core` (through `export * from './repo.js'`). They wait
  through `immediate()`, but the step name and remedy are added only by their CLI callers (`docsCmd.ts` and
  `indexRepo`). With another process holding the lock, `core.upsertDoc(db, …)` throws `database is locked` after
  5 s. `nameBusy` is exported, but `immediate` (in `core/db/database.ts`) is not re-exported from `core/db/index.ts`
  or `src/core/index.ts`. A library caller's own write transaction therefore gets neither SG80's wait nor its
  message. The SG80 row says that `SQLITE_BUSY` errors "on every write path" name the step, which holds only for the
  CLI and MCP paths.
- **Test:** `A27-04` (`expected false to be true`; the message has no remedy).
- **Location:** `src/core/db/repo.ts:282,404`, `src/core/db/index.ts:1`, `src/core/db/database.ts:125`.

**A27-05: no document says what to do after a crash, or how to reset the index safely.** Low.
- **Evidence:**
  - **What works (pinned):**
    - After a `kill -9` of `atlas index --force` on 1,500 files, re-running `atlas index` recovers and prints
      `resolved 1500 edges (0 weak) after an interrupted run`.
    - Deleting only `index.db` (with the stale `-wal`/`-shm` left) gives a healthy index (`integrity_check ok`).
    - The OS releases `index.db.lock`. A leftover `index.db.lock-journal` is harmless.
  - **What the README says:** none of the above. It never mentions crashes, interrupted runs, `database is locked`,
    the 5 s wait, or that `atlas mcp` and `atlas serve` must be stopped before the index is deleted (A27-01, A27-02).
    It also does not warn that the `.atlas/docs` it asks users to commit live in the same directory, so
    `rm -rf .atlas` loses them.
  - **Where the reset is described:** only in `DECISIONS.md` (SG90) and `PLAN.md`, both without that caveat.

  This adds the new behaviour to A23-05.
- **Test:** `A27-05` (`expected '# Atlas\n\n> Local-first codebase int…' to match /interrupted|crash|killed/i`).
- **Location:** `README.md` §Command notes and §MCP server, `DECISIONS.md` (SG90 entry).

## Scope checks

- **SG80 busy message, every surface:** identical where a write is refused.
  - With the lock held for 20 s:
    - `atlas index --force` exits 1 with `atlas: run stamp: database is locked (another process is writing the index;
      retry when it finishes)`;
    - `atlas docs --offline --force` exits 1 with the same text after `docs write:`;
    - `atlas_index` returns `{content: [{type: 'text', text: 'run stamp: …'}], isError: true}` (SDK and stdio,
      5,012–5,014 ms), the CLI text without `atlas: ` (pinned).
  - It is a tool `isError`, not a JSON-RPC error, as for every other handler error. Input-validation errors are also
    `isError` and keep the SDK's `MCP error -32602: …` text.
  - Reads (`search`, `drift`, `atlas_search`, `atlas_drift`, `atlas_docs`, `/api/stats`) answer in milliseconds from
    other processes (pinned). See A27-03 for the same server.
  - `nameBusy` now names an error once: a second call keeps the first step (pinned; AUDIT-23's stacking note no longer
    applies).
- **Is the remedy true?** Yes, wherever it appears:
  - After a refused run, nothing is stamped (the run-stamp `BEGIN` failed), and the retry succeeds once the holder
    commits.
  - After a refused `docs`, the docs already written stay cached and the retry finishes. The run's stats and the
    `.atlas/docs` export are skipped until then.
  - The `journal mode` case (another program holding an empty or rollback-mode file) is also cleared by a retry.
  - Gaps: the remedy is missing from the library (A27-04) and from the `disk I/O error` of A27-01. The SG32 lock
    error keeps its own wording, `another atlas index run is writing <db>; gave up after 600s`: it gives the cause
    but no remedy, and appears only after 10 minutes.
- **SG80 waits:** `atlas docs --offline --force` and `atlas_index {force: true}` succeed beside a 1 s/20 ms writer
  (pinned), as `atlas index --force` does (A23-01, pinned).
  - **Pending migration:** a v4 index needing v5 beside the same writer migrated in all 6 runs (2.6–5.7 s) of
    `atlas search`. `runMigrations` still uses SQLite's own busy handler (`.immediate()`), not `immediate()`'s 10 ms
    poll, but it caught a gap within the 5 s every time.
- **SG90:** a 0-byte `index.db` that another process holds:
  - Held for 1.5 s: `atlas index` waits and succeeds.
  - Held for 12 s: it fails at 5.0–6.0 s with `journal mode: database is locked (…; retry when it finishes)`, exit 1
    (pinned).
  - `atlas mcp` started in that state exits 1 with the same text on stderr. The client sees
    `MCP error -32000: Connection closed`, as for any startup failure.
- **Exit codes:** every lock or busy error exits 1 on the CLI. `drift` keeps 0/1/2. Like the other read commands, it
  writes only when it migrates an older index, and then a busy error exits 1 as `migrations: …`. `serve` opens the
  index read-only, so it never gets `SQLITE_BUSY`. HTTP errors stay 400 (`ParamError`) or 500.
- **Exports:** `src/core/index.ts` is unchanged since AUDIT-23. `nameBusy` is the only lock-related export
  (A27-04). Neither the config schema nor the README configuration section mentions a lock or busy setting. The
  busy timeout (5 s) and lock wait (10 min) are constants. No surface documents them (A27-05, A23-05).

## Re-verified

All AUDIT-15, AUDIT-19 and AUDIT-23 tests pass on this base (33 tests). Every `it.fails` among them still fails as
intended.
- **A23-01 and A23-02 fixed (SG80):** they are plain `it` in `audit-23.test.ts` and pass. A27's first two pins extend
  them to `docs` and `atlas_index`.
- **A23-05 partly fixed:** `DECISIONS.md` gained SG80 and SG90 entries, and SG80's covers `nameBusy` and the remedy.
  Still missing: an SG55 or SG65 entry, and everything in the README (unchanged since `7434b62`, before AUDIT-19).
- **Still open (their `it.fails` still fail):**
  - A23-03: a parallel `atlas_ask` capped by reservations fails as `incomplete response`.
  - A23-04: "retry when they finish" can be false.
  - A23-05: see above.
  - A19-02: only `atlas_ask` and `atlas_index` reload the config. A27-02 is the same split, reached by a reset.
  - A19-03: a forced re-index empties the vectors until the embed phase.
  - A19-04: the README does not describe SG34, SG40 or SG50.
  - A19-05: `getLastRun` returns an unfinished run.
  - A15-02 (mitigated): `atlas_index` exceeds a short client timeout while the SG32 lock is held.
  - A15-04: a cut-short `docs` gives no cause without `-v`.
  - A15-05: `--force` hides the extractor upgrade.
  - A15-06: actual usage can exceed the cap.
  - A15-07: the README does not mention the index lock.
  - A11-04, A11-06..A11-11, A7-06, A7-09, A3-11 and A3-13. For A7-06, `atlas_symbol {bogus: 1}` is still accepted.
- **Still open (checked by hand):**
  - A7-07: `atlas index --json` gives `error: unknown option '--json'` (exit 1).
  - A7-11: `atlas init` still prints `Next: \`atlas index <path>\` (phase 2).`
