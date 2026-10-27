# AUDIT-37: API and SDK consistency, round 9

This audit checks how the CLI, the dashboard HTTP API (`atlas serve`), the MCP tools (SDK and stdio) and the
`@atlas/core` exports report the conditions SG130, SG135 and SG140 added to `openDatabase`
(`src/core/db/database.ts`). It also checks whether `README.md`, `DECISIONS.md` and `PLAN.md` match what the code
does. Since AUDIT-31 the only `src/` changes are in that file, plus the `nameCorrupt` and `closeOnSignal` calls in
`src/cli/index.ts`, `driftCmd.ts`, `indexCmd.ts`, `docsCmd.ts`, `src/mcp/server.ts` and `src/web/server.ts`
(`git diff 68fb2c2 HEAD -- src`). The conditions are:
- the refusal `index <db>: cannot check <db>-wal, left by a process that stopped (<code>: …); it is kept: …`
  (SG140);
- the corrupt/malformed refusal `index <db> is unreadable (…): it may have been replaced beside a <db>-wal it does
  not belong to; delete <db> with its -wal and -shm and run \`atlas index\``, including the new cause
  `another process still has the replaced index open` (SG135);
- the busy refusals, including `open: database is locked (…)` from the new `<db>.open.lock`;
- the `-wal.foreign-<ms>` set-aside notice and the reminder printed on every later open (SG130/SG140).

Base: `aaefa5f` on `claude/atlas-audit-37` (SG120, SG130/SG135 and SG140 merged). Date: 2026-10-27. The auditor
wrote none of this code. The SDKs are `@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1, with
better-sqlite3 11.10.0 (SQLite 3.49.2). Node 22.22.

**Method.** I built the CLI with `tsc` into the scratchpad (`node dist/cli/index.js`) and used copies of
`fixtures/sample` plus the scratchpad clones of express and got. I drove them in these ways:
- through the built CLI, reading stdout, stderr and the exit code apart;
- through `atlas mcp --offline` over stdio with the stock SDK `Client` + `StdioClientTransport`, and in-process
  through `createMcpContext` + `InMemoryTransport`;
- through `atlas serve` (curl) and `startServer` (fetch);
- through `openDatabase` from the built `dist/core/index.js`.

I set up the conditions as earlier audits did:
- a killed writer: a process commits an `UPDATE` and SIGKILLs itself, optionally after a `PASSIVE` checkpoint;
- a replaced index: `cp`, or `mv` while an `atlas mcp` (after `atlas_index {force: true}`) holds the old file;
- a full disk: `ulimit -f 16` with SIGXFSZ ignored, as in AUDIT-34;
- a busy open lock: another process holds `BEGIN EXCLUSIVE` on `<db>.open.lock`.

I killed every process I started.

Repros live in `test/audit/audit-37.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it`
and confirmed that it fails on its stated assertion, not on a harness error. For tests with more than one part, I
also removed the earlier assertions and confirmed that each later part fails on its own. The failure messages are
listed under each finding. The two plain `it` tests pin what the audit found consistent.

**Totals:** 0 critical, 0 high, 2 medium, 3 low. No new SG rows. A31-01 and A31-02 are fixed (SG120). A31-03 has
changed, but the replacement is still lost, now behind a refusal (see A37-02). A31-04, A27-01..A27-03 and
A22-01..A22-04 are still open.

## Findings

### Critical

None found.

### High

None found.

### Medium

**A37-01: the set-aside reminder cannot be followed. It tells the user to move the WAL back to the index it was
just judged not to fit, and that move is refused as malformed, with a remedy that deletes the index. A write
command prints the reminder and then writes in the same run. MCP tool results and the HTTP API never mention
it.** Medium.
- **Evidence:** a replaced index beside a killed writer's WAL (`cp B/.atlas/index.db A/.atlas/index.db`). The first
  open sets the WAL aside: `atlas: <db>-wal does not belong to <db>; moved it to <db>-wal.foreign-<ms>` on stderr,
  exit 0, with the replacement's answers. Every later open prints:
  `atlas: <db>-wal.foreign-<ms> was set aside from <db>; if its writes belong there, move it back to <db>-wal
  before anything writes the index, otherwise delete it`. Three surfaces contradict that sentence:
  - **The move it prescribes fails.** With no write in between, `mv <db>-wal.foreign-<ms> <db>-wal`, then
    `atlas search add` exits 1 with `index <db> is unreadable (database disk image is malformed): … delete <db>
    with its -wal and -shm and run \`atlas index\``. The WAL was set aside only because the integrity check said
    it does not fit this file. Its `-shm` is gone, so the next check refuses it outright. Following that refusal
    deletes the replacement too. Same result on express. The README says something else: "move it back beside
    the index it came from". The PLAN SG140 row says the reminder is there "so the README's move-back recovery is
    not overtaken by the next write".
  - **A write overtakes it at once.** `atlas index` prints the reminder ("… before anything writes the index") and
    then writes in the same run: `indexed 1, skipped 3 … totals: files=4 symbols=24`, exit 0. `atlas docs` and
    `atlas_index` do the same.
  - **Only the CLI shows it.** `atlas mcp` writes the notice and reminder to its stderr once, at startup, which MCP
    clients do not show. `atlas_index` returns `isError: false` with
    `{"filesScanned":4,"filesIndexed":0,…,"resolverDiagnostics":[]}`, and no tool result says a WAL was set aside.
    `atlas serve` prints it once at startup. `/api/health` returns `{"ok":true,…}` and `/api/stats` returns 200
    `{"files":4,"symbols":24,"edges":15,"docs":0}`. An editor or dashboard user never learns that a WAL was set
    aside.
- **Impact:** the one recovery SG130/SG140 offer for a set-aside WAL is a step that is always refused, and its
  remedy deletes the user's restored index. On the surfaces most users run all day (MCP, dashboard), the set-aside
  is silent. The behaviour does not match the SG140 row's "reported until the user acts" or the README's recovery
  text.
- **Test:** `A37-01`. As a plain `it`, it fails with `expected +0 not to be +0` (`atlas index` exits 0 after
  printing the reminder). With that assertion removed, it fails with `expected 'atlas: index /tmp/…' not to match
  /unreadable/` (the move-back refused).
- **Repro:**
  1. `atlas index A` and `atlas index B` (B = A + `replacementOnlyFn`).
  2. `node -e "const D=require('better-sqlite3');const db=new D('A/.atlas/index.db');db.exec(\"UPDATE symbols SET docstring='x'\");process.kill(process.pid,'SIGKILL')"`.
  3. `cp B/.atlas/index.db A/.atlas/index.db`, then `atlas search add --cwd A` (exit 0, "moved it to
     …foreign-<ms>").
  4. `mv A/.atlas/index.db-wal.foreign-* A/.atlas/index.db-wal`, then `atlas search add --cwd A` (exit 1,
     `… is unreadable (database disk image is malformed) … delete …`).
  5. Separately, after step 3: `atlas index A` prints the reminder and exits 0, and `atlas_index` over stdio returns
     no mention of it.
- **Location:** `src/core/db/database.ts:295-309` (`reportAside`: stderr only, text), `:282-292` (`setAside`),
  `:116-128` (the reminder does not stop a write), `src/mcp/server.ts:321-333` (`answer` has no warnings channel),
  `src/web/server.ts` (`/api/health`), `README.md:236-240`, `PLAN.md` SG140 row.

**A37-02: an index renamed into place while another process holds the old one gets the replaced-WAL refusal,
whose cause and remedy are wrong. The remedy deletes the replacement. Once the holder stops, every surface answers
from the old index with exit 0, and the replacement is overwritten (A31-03 by another route).** Medium.
- **Evidence:** `atlas mcp` ran `atlas_index {force: true}` and holds `A/.atlas/index.db`. Then
  `mv B/.atlas/index.db A/.atlas/index.db`:
  - `atlas search replacementOnlyFn --cwd A` exits 1 with `index <db> is unreadable (another process still has
    the replaced index open): it may have been replaced beside a <db>-wal it does not belong to; delete <db> with
    its -wal and -shm and run \`atlas index\``. The message does not name the holder, and it gives the remedy for
    a foreign WAL. The README's reset says "stop every Atlas process on the project" first; this message does not.
  - Meanwhile the holder answers from the old inode and keeps writing to it: `atlas_symbol replacementOnlyFn` →
    `[]` and `atlas_index {force: true}` → `filesIndexed: 4`, both without `isError`. That is A27-02.
  - Following the message (`rm index.db index.db-wal index.db-shm && atlas index`) exits 0 with an index rebuilt
    from A's tree. The user's replacement is deleted, as the remedy asked.
  - Doing what the cause implies (stop the holder) does not keep it either. `atlas mcp` stopped by closing stdin
    leaves `index.db-wal` and `-shm`: SQLite sees the file was moved and cannot checkpoint. On the sample, the
    next `atlas search replacementOnlyFn` exits 0 with `0.010 method Counter.increment`, and nothing is on
    stderr. The leftover WAL passed the integrity check and was replayed. After every process exits, `index.db`
    has 0 `replacementOnlyFn` rows and integrity `ok`: the old index was checkpointed over the replacement. On got
    the leftover WAL covered fewer pages, and `replacementOnlyFn` was still found. I did not check that index for
    a partial mix (that is soundness, AUDIT-36's scope).
  - The neighbouring case gets no named message at all: a deleted index with the same live holder still fails
    with a bare `atlas: disk I/O error` (A27-01).
- **Impact:** both readings of the refusal lose the user's replacement, and the refusal gives no hint that
  `atlas mcp` or `atlas serve` must be stopped. The same holder gives a named refusal in one case and a bare
  `disk I/O error` in the next.
- **Test:** `A37-02`. As a plain `it`, it fails with `expected 'atlas: index /tmp/…' not to match /delete .* with
  its -wal and -shm/`. With that assertion removed, it fails with `expected '0.010  method    Counter.increment
  (…' to match /replacementOnlyFn/`.
- **Repro:**
  1. `atlas index A` and `atlas index B`.
  2. Start `atlas mcp --cwd A` and call `atlas_index {force: true}`.
  3. `mv B/.atlas/index.db A/.atlas/index.db`, then `atlas search replacementOnlyFn --cwd A` (exit 1, message
     above).
  4. Close the server's stdin, then `atlas search replacementOnlyFn --cwd A` (exit 0, `Counter.increment`).
- **Location:** `src/core/db/database.ts:134` (the cause), `:476-492` (`nameCorrupt`: one remedy for every cause),
  `:130-139` (`decideWal`: the WAL a stopped holder leaves is judged by integrity only), `README.md:222-223` (reset).

### Low

**A37-03: a read beside a leftover WAL that another opener is checking waits up to 60 s, then fails with
`open: database is locked (another process is writing the index; retry when it finishes)`.** Low.
- **Evidence:** `lockOpens` takes `<db>.open.lock` with a 60 s SQLite timeout (`OPEN_LOCK_MS`). Everything else
  uses the 5 s busy timeout, and AUDIT-23/27 pinned that reads never wait. A killed writer's WAL is left beside the
  index, and another process holds the open lock (an opener checking a large WAL, or one stopped with Ctrl-Z
  mid-check). Then:
  - `atlas search add` waits **60.6 s** and exits 1 with that message. No process is writing the index; one is
    checking a leftover WAL. The message does not name the check, the lock file or the WAL.
  - `atlas mcp` blocks at startup for as long as the lock is held. In my run the holder exited after 29 s, and the
    server then answered. The SDK's own request timeout is also 60 s, so a client can fail at the same moment with
    `Request timed out` instead.
  - No document mentions the 60 s wait. The README mentions no busy wait at all (A15-07).
- **Impact:** a read command can hang for a minute and then blame a writer that does not exist. That is rare: the
  check of a 157 MB index takes about 0.6 s (AUDIT-34).
- **Test:** `A37-03` (about 62 s). As a plain `it`, it fails with `expected 'atlas: open: database is locked
  (anot…' not to match /is writing the index/`.
- **Repro:** after a killed writer, run
  `node -e "const D=require('better-sqlite3');const l=new D('A/.atlas/index.db.open.lock');l.exec('BEGIN EXCLUSIVE');setInterval(()=>{},1e3)" &`,
  then `time atlas search add --cwd A`.
- **Location:** `src/core/db/database.ts:29`, `:218-234`, `:451-468` (`BUSY_REMEDY`, `nameBusy`).

**A37-04: the README promises `MCP isError` and `HTTP 500` for a refused leftover WAL. A refusal at open never
reaches either: `atlas mcp` and `atlas serve` exit 1 before they serve, and an MCP client sees only
`MCP error -32000: Connection closed`.** Low.
- **Evidence:** the README index-files section ends: "In any other case, or when SQLite finds the index corrupt,
  every surface fails with one message naming the file, the `-wal` … and the remedy above (CLI exit 1, MCP
  `isError`, HTTP 500)". The SG120 row's Accept says the same. The leftover-WAL check runs only in
  `openDatabase`, and `atlas mcp` and `atlas serve` open the index once, at startup. So for every refusal that
  check makes, the result is:
  - the corrupt refusal (a checkpoint had started, a live holder) and SG140's `cannot check … it is kept`: the CLI
    exits 1 with the message on stderr and nothing on stdout;
  - `atlas serve` exits 1 with the same line and never listens;
  - `atlas mcp` exits 1 before the handshake. The stock SDK client's `connect` rejects with
    `MCP error -32000: Connection closed`, and the text is only on the server's stderr.

  `isError` and HTTP 500 happen only when SQLite reports corruption to a server that is already running (pinned
  in AUDIT-31's SG120 tests). The startup behaviour matches AUDIT-31's pin for a busy open. So the defect is the
  document, not the code.
- **Impact:** a user or client author who relies on the README expects a tool error they can show, and gets a dead
  server with the reason in a log.
- **Test:** `A37-04` (conditional on the README sentence). As a plain `it`, it fails with
  `expected 'MCP error -32000: Connection closed' to be undefined`.
- **Repro:** after a killed writer,
  `bash -c "trap '' XFSZ; ulimit -f 16; exec atlas mcp --offline --cwd A"` under an SDK client.
- **Location:** `README.md:241-243`, `PLAN.md` SG120 row (Accept), `src/mcp/server.ts:453-458`,
  `src/cli/commands/serveCmd.ts:22`.

**A37-05: the library reports the new conditions differently from SQLite's own. The replaced-WAL refusal is
thrown as a plain `Error` with a copied `code`, not a `SqliteError`. A set-aside WAL is written to the host
process's stderr by `openDatabase` itself.** Low.
- **Evidence:**
  - `openDatabase` beside a WAL whose checkpoint had started throws `Error` with `code: 'SQLITE_CORRUPT'`, and
    `instanceof Database.SqliteError` is false. SG140's `cannot check` refusal is a `SqliteError` (for example
    `SQLITE_IOERR_SHMSIZE`), and so is corruption SQLite finds in a query.
  - `setAside` and `reportAside` call `process.stderr.write` from inside `openDatabase`. A program embedding
    `@atlas/core` (as `atlas mcp` and `atlas serve` do) cannot capture, route or show these notices, and it gets
    them on every open.
  - `nameCorrupt` is still not exported. DECISIONS (SG120) records that, so it is consistent with the docs. The
    pattern is the same as A27-04's `immediate`.
- **Impact:** a library caller that branches on `SqliteError` misses this refusal. A caller with its own UI (the
  MCP server, the dashboard) has no way to surface the set-aside, which is the root of A37-01's third part.
- **Test:** `A37-05`. As a plain `it`, it fails with `expected Error: index /tmp/… { code: '…' } to be an instance
  of SqliteError`. With that assertion removed, it fails with `expected "spy" to not be called at all, but actually
  been called 1 times`.
- **Location:** `src/core/db/database.ts:311-315` (`corrupt`), `:282-309`, `src/core/db/index.ts:1`.

## Scope checks

- **`cannot check … it is kept` (SG140), every surface (pinned):** with a killed writer's WAL beside the index and
  growing a file failing, the following all give the same line,
  `index <db>: cannot check <db>-wal, left by a process that stopped (SQLITE_IOERR_SHMSIZE: disk I/O error); it is
  kept: free disk space (or fix the cause) and retry`:
  - `atlas search`, `atlas index`, `atlas drift --json` and `atlas serve` exit 1, with that line (prefixed
    `atlas: `) on stderr and nothing on stdout;
  - `atlas mcp` exits before the handshake, with the same line on its stderr (the SDK client sees
    `Connection closed`);
  - `openDatabase` throws a `SqliteError` with `code: 'SQLITE_IOERR_SHMSIZE'` and the same message.

  The WAL stays in place, nothing is set aside, and once space is back the next read keeps the writer's rows.
  `nameCorrupt` leaves the message alone (the code is not `CORRUPT`/`NOTADB`), and so does `nameBusy`.
- **Corrupt/malformed at open (SG120/SG135):** one message on the CLI (exit 1, stderr only), `serve` (exit 1) and
  `mcp` start (stderr, `Connection closed`). A symlinked index names its target's `-wal` (AUDIT-34 pin). Corruption
  found by a running server: MCP `isError` and HTTP 500 with the same text (AUDIT-31 pin, still green).
- **Busy:** the SG80/SG90 messages are unchanged (AUDIT-27 and AUDIT-31 pins green). The new `open:` busy is
  A37-03. `integrity check: database is locked (…)` exists in code. I did not reach it, because a holder that could
  cause it is a live holder, so the check is skipped.
- **Set-aside notice and reminder (pinned):** stderr only, so `search --json` and `graph --format json` stdout
  still parse. The reminder appears once per open: once per CLI command, once per `atlas mcp` or `atlas serve`
  start.
- **Exit codes:** unchanged. `drift` keeps 0/1/2. Every open refusal exits 1, including `drift`'s, through the
  top-level handler, so the `atlas drift:` prefix is used only for errors after the open. Signals: `index`,
  `docs` and `mcp` die by the signal after closing (AUDIT-31/33 pins green).
- **Exports:** `src/core/index.ts` is unchanged. `nameBusy` is exported. `nameCorrupt`, `closeOnSignal` and
  `immediate` are not (A27-04, A37-05).
- **Docs vs behaviour:**
  - The README index-files section is accurate for the following, and the SG130/SG135 entry in `DECISIONS.md`
    matches the code:
    - copies and moves with the WAL;
    - the open lock file;
    - `cannot check` (refused, WAL kept, "free the space and retry");
    - the rename to `-wal.foreign-<ms>`.
  - Inaccurate: the move-back recovery (A37-01) and "(CLI exit 1, MCP `isError`, HTTP 500)" for refusals at open
    (A37-04).
  - The DECISIONS SG120 entry still describes the ctime rule and deletion, and says it was superseded. That is
    accurate as history.
  - The README's "which every Atlas process opening the index takes" is true only while a leftover WAL is there;
    otherwise no lock is taken. That is harmless.

## Re-verified

`audit-22`, `audit-27` and `audit-31` tests: 29 tests, green in 40.5 s. Every `it.fails` among them still fails as
intended. Status:
- **A31-01** (replaced index mixed with a stale WAL): fixed by SG120/SG130. The test is a plain `it` and passes;
  the AUDIT-33/34 residuals belong to the soundness audits.
- **A31-02** (`atlas mcp`/`index`/`docs` not closing on SIGTERM/SIGINT): fixed by SG120. Plain `it`, green. A
  stdin-closed or signalled `atlas mcp` leaves no `-wal`.
- **A31-03** (replacement renamed in under a running `atlas mcp`): open, and changed. While the holder runs, the
  CLI now refuses with a named message instead of reading the old index. Once the holder stops, the old index
  silently wins (sample). See A37-02. The `it.fails` still fails, now on `search.code` 1.
- **A31-04** (`atlas serve` on a 0-byte index: 500 `no such table`, `/api/health` ok): open. The `it.fails` still
  fails. The leftover-WAL check skips a 0-byte file.
- **A27-01** (bare `disk I/O error` on reset beside a writing `atlas mcp`): open. Re-run with the built CLI:
  `rm index.db && atlas index` exits 1 with `atlas: disk I/O error`, and so does `search`. That is unlike the
  named refusal for the renamed case (A37-02).
- **A27-02** (a server answers from, and writes to, the deleted or renamed-over file): open. `atlas_index {force:
  true}` writes 4 files to the renamed-over inode with no error.
- **A27-03** (`immediate()` blocks the MCP event loop while `atlas_index` waits): open. The `it.fails` still
  fails. `lockOpens` adds a synchronous wait of up to 60 s, but only at startup (A37-03).
- **A22-01** (resolve is one event-loop block): open. The `it.fails` still fails; `src/core/graph` is unchanged
  since AUDIT-30.
- **A22-02** (`carryEdges` quadratic in same-name symbols): open. The `it.fails` still fails.
- **A22-03** (a second writer fails after the 5 s busy timeout during a long resolve): open by inspection. The
  busy timeout is still 5 s and the resolve transaction is unchanged. Not re-measured at 10k files (AUDIT-30: 1–2
  failures in about 380 attempts). The failure now reads `docs write: database is locked (another process is
  writing the index; retry when it finishes)`.
- **A22-04** (the embed phase keeps every file's source until it ends): open by inspection. `makeSourceLoader` is
  unchanged. Not re-measured (AUDIT-30: 303 MB peak heap, OOM at 200 MB).
