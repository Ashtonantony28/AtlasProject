# AUDIT-41: API and SDK consistency, round 10

This audit checks how the CLI, the dashboard HTTP API (`atlas serve`), the MCP tools (SDK over stdio) and the
`@atlas/core` exports report the conditions SG150 added to `openDatabase` (`src/core/db/database.ts`), and whether
`README.md` and `DECISIONS.md` match the code. Since AUDIT-37 the only `src/` change is SG150 in that file
(`git diff aaefa5f HEAD -- src`). The conditions are:
- the refusal `index <db>: cannot check <db>-wal, left by a process that stopped (<cause>); it is kept: free disk
  space (or fix the cause) and retry`, with SG150's new causes: `EIO: i/o error, read` (from `readAll`),
  `a page could not be read: <first result>` (the two checks differ, or an `error code=` row that is not
  corruption), `short read of <file> at byte …`, and `SQLITE_IOERR_*` thrown by the check connection;
- the set-aside name `<db>-wal.foreign-<ms>-<size>-<mtimeNs>`;
- the two reminders: `… if its writes belong there, move it back to <db>-wal before anything writes the index,
  otherwise delete it` and `… which may have been written since: moving it back would corrupt the index; delete
  it`.

Base: `89d019a` on `claude/atlas-audit-41` (SG150, AUDIT-37 and AUDIT-39 merged). Date: 2026-10-27. The auditor
wrote none of this code. `@modelcontextprotocol/sdk` 1.32.1, better-sqlite3 11.10.0, Node 22.

**Method.**
- I built the CLI with `tsc` into the scratchpad (`audit-41/dist`) and drove it on copies of `fixtures/sample`. I
  read stdout, stderr and the exit code separately.
- `atlas mcp --offline` ran under the stock SDK `Client` + `StdioClientTransport` (`scripts/mcp.mjs`), and also
  as a long-running session driven by control files (`scripts/mcp-hold.mjs`).
- `atlas serve` was queried with curl. The library was called from `dist/core/index.js` (`scripts/lib.mjs`).
- I/O errors came from an `LD_PRELOAD` shim (`audit-41/eio/shim.c`, derived from AUDIT-36's). It fails `pread` on
  the check's hard link (`*.check`) from read N on, either with `EIO` or by returning 0 bytes. With a window of 1,
  it reproduces `a page could not be read`.
- A killed writer commits an `UPDATE` plus one doc per file and SIGKILLs itself. A replaced index is
  `cp B/.atlas/index.db A/.atlas/index.db` beside it.
- I killed every process I started.

Repros are in `test/audit/audit-41.test.ts` as `it.fails`, named by ID. I ran each one as a plain `it` and
confirmed that it fails on its stated assertion. For A41-01, I also removed the first assertion and confirmed that
the second fails on its own (`200 vs exit 1`). The tests that need the shim are skipped where there is no `cc`.

**Totals:** 0 critical, 1 high, 0 medium, 3 low. One new SG row (SG190, A41-01).

## Findings

### Critical

None found.

### High

**A41-01: the reminder offers the move-back while `atlas serve` or `atlas mcp` has the index open. Following it
makes the dashboard answer 200 from a mixed index while every CLI command refuses that index as malformed, and
the remedy deletes it. The index is then left corrupt. If the dashboard reads first, the moved-back WAL is
silently discarded, and the next write makes the dashboard fail with a bare 500.** High.
- **Evidence:** a replaced index beside a killed writer's WAL. The first `atlas search` sets the WAL aside. Then
  `atlas serve --cwd A` starts and prints `… if its writes belong there, move it back to <db>-wal before anything
  writes the index, otherwise delete it`. Every CLI command run while the server is up prints the same text.
  `reportAside` looks only at the index's size and mtime and at whether `<db>-wal` has bytes. It never looks at a
  live holder, and a server that has not written has a 0-byte `-wal`. The user then follows the reminder with
  `mv …foreign-* <db>-wal`. What happens next depends on which process opens the index next:
  - **The CLI opens next** (8/8 trials with `scripts/sm3.sh`, at 0.5 s and 2 s after start, with or without an
    earlier CLI read):
    - `atlas search` and `atlas index` exit 1 with `index <db> is unreadable (database disk image is malformed):
      it may have been replaced beside a <db>-wal it does not belong to; delete <db> with its -wal and -shm and run
      \`atlas index\``.
    - In the same moment, `/api/stats` answers 200 `{"files":4,"symbols":25,"edges":15,"docs":4}`. Those are the
      set-aside WAL's 4 docs, mixed into the replacement, which had `docs:0` a moment earlier.
    - `/api/search` answers 200.
    - In the first trial, a later `atlas search` exited 0 from the same mix. Once the server stopped, the index
      read `wrong # of entries in index idx_symbols_qualified` with 24 `STALE-WAL` rows and 4 docs, and every
      command refused it as malformed.
  - **The dashboard reads first** (`scripts/sm2.sh`, 4/4 trials):
    - The moved-back WAL is ignored, because the live `-shm` says the WAL is empty. The CLI exits 0 and nothing
      says so on any surface. The reminder is gone, because its file was moved.
    - `atlas index` then exits 0 and overwrites the WAL. `/api/stats` now answers 500 `{"error":"disk I/O error"}`
      (bare: no file, cause or remedy) until the server restarts. The dashboard holds the old 0-byte WAL inode.
  - **Baseline:** without the move, the same `atlas index` beside the server leaves `/api/stats` at 200.
  - The same happens with a held `atlas mcp` (`scripts/mcp-hold.mjs`). After the move, `atlas_search` and
    `atlas_index` return `isError: false`. The CLI then exits 1 as malformed while the server keeps answering.
    After the server stops, the moved-back WAL is consumed with no message.
- **Impact:** this is A31-01's class (an answer from a mixed index with success), on the dashboard, and it is
  reached by doing what Atlas says. The two surfaces disagree at the same moment: HTTP 200 against CLI exit 1. The
  CLI's remedy (delete the index while a server holds it) leads to A27-01's bare `disk I/O error`. The README's
  move-back text does not say to stop the servers, and `atlas serve` and `atlas mcp` are the processes users leave
  running.
- **Test:** `A41-01`. As a plain `it`, it fails with `expected 'atlas: /tmp/atlas-audit41-…' not to match /move
  it back/`. With that assertion removed, it fails with `200 vs exit 1: expected true to be false`.
- **Repro:**
  1. `atlas index A` and `atlas index B` (B = A + `replacementOnlyFn`).
  2. Run the killed writer on `A/.atlas/index.db`.
  3. `cp B/.atlas/index.db A/.atlas/index.db`, then `atlas search add --cwd A` (this sets the WAL aside).
  4. `atlas serve --cwd A --port 4741 &`, then `sleep 1`.
  5. `mv A/.atlas/index.db-wal.foreign-* A/.atlas/index.db-wal`.
  6. `atlas search add --cwd A` exits 1 (malformed), and `curl localhost:4741/api/stats` answers 200 with `"docs":4`.
- **Location:**
  - `src/core/db/database.ts:357-382` (`reportAside`: no holder check);
  - `:117-120` (`checkLeftoverWal` skips the check for a live holder, so the moved-back WAL is never judged);
  - `README.md:241-243` (the move-back text);
  - `DECISIONS.md` SG150 line.
- **Fix (SG190):**
  - Offer the move-back only when `holders()`/the probe finds no live connection. Otherwise say "stop every Atlas
    process on the project first".
  - Better: have Atlas do the move-back itself (for example `atlas index --restore-wal`), under
    `<db>.open.lock`, re-checking the WAL. Then the user never renames files under a live connection.

### Medium

None found.

### Low

**A41-02: `openDatabase` throws the `cannot check` refusal as three different kinds of error, depending on what
stopped the check. Two of them are not `SqliteError`s, and one has no `code`.** Low.
- **Evidence:** all of these come from the built library (`scripts/lib.mjs`), beside a killed writer's WAL. The
  message has the same shape each time, `index <db>: cannot check <db>-wal, … it is kept: …`, but the thrown value
  differs:
  - **full disk:** `SqliteError`, `code: 'SQLITE_IOERR_SHMSIZE'` (AUDIT-37 pin);
  - **`EIO` from read 0:** `SqliteError`, `code: 'SQLITE_IOERR_CORRUPTFS'`;
  - **`EIO` from read 3, 10, 20 or 40** (`readAll`): Node's `Error`, `code: 'EIO'`, `errno: -5`, `syscall: 'read'`;
  - **a one-read `EIO` window on a foreign WAL** (`a page could not be read: …`) and **0-byte reads**
    (`short read of …`): a plain `Error` with no `code`.

  The user-facing surfaces agree, because the CLI, `serve` and `mcp` print `message` only (pinned). A caller of
  `@atlas/core` has no stable way to tell "the WAL is kept, retry later" from any other failure.
- **Impact:** the same as A37-05, widened by SG150. An embedder that branches on `SqliteError` or `code` misses two
  of the four shapes.
- **Test:** `A41-02`. As a plain `it`, it fails with `eio: expected false to be true`.
- **Location:** `src/core/db/database.ts:264-281` (`integrityOk`: `new Error('a page could not be read…')`,
  `readAll`'s errors rethrown as they are), `:310-324` (`readAll`).
- **Fix:** throw one error type, for example a `SqliteError`-compatible error with
  `code: 'SQLITE_IOERR'` (or an exported `WalCheckError` with `cause`), for every refusal at this step.

**A41-03: the `cannot check` cause and remedy do not fit SG150's new causes. The remedy says "free disk space" for
an I/O error. The cause names a deleted temporary file, so the text changes on every run. Ordinary corruption is
called "a page could not be read". One cause spans two lines.** Low.
- **Evidence:**
  - **`EIO`:** `… (EIO: i/o error, read); it is kept: free disk space (or fix the cause) and retry`. The README now
    says "fix the cause and retry".
  - **0-byte reads:** `… (short read of <dir>/index.db.26609.1793088905004.check at byte 0 of 1736704) …`. That is
    the check's hard link, which is deleted before the message is printed. The pid and the timestamp differ on
    each surface and on each run: `search`, `index`, `drift`, `docs --list`, `serve` and `mcp` all printed
    different names in one run of `scripts/lib.sh surfaces`.
  - **Window `EIO` on a foreign WAL:** the result is `… (a page could not be read: SQLITE_CORRUPT: database disk
    image is malformed) …` (the first check's ordinary corruption, labelled as an unreadable page). Another window
    gave `… (a page could not be read: *** in database main ***\nTree 3 page 3: unable to get the page. error
    code=8458) …`, so the CLI's one-line `atlas: …` message becomes two lines on stderr and in the MCP server log.
- **Impact:** the remedy points at the wrong cause, and a log or a test cannot match the text. These are cosmetic.
  Every surface still refuses, and the WAL is kept.
- **Test:** `A41-03`. As a plain `it`, it fails with `expected 'atlas: index /tmp/atlas-audit41-…' not to match
  /\.check\b/`.
- **Location:** `src/core/db/database.ts:264-279`, `:318`.
- **Fix:**
  - Name `index.db` or `index.db-wal`, not the link.
  - Flatten newlines.
  - Make the remedy fit the cause: "free disk space and retry" for `FULL`/`SHMSIZE`/`EDQUOT`/`EFBIG`, and "fix the
    disk (an I/O error) and retry" otherwise.
  - Say "the two checks differ" rather than "a page could not be read" when the first result is ordinary
    corruption.

**A41-04: DECISIONS records only half of SG150, and its SG140 entry now describes a rule SG150 replaced.** Low.
- **Evidence:**
  - **SG150 entry:** `DECISIONS.md` has one SG150 line: "(A36-02): the reminder stops offering the move-back once
    the index has changed …". It records none of the A36-01 half: two checks that must fail the same way, every
    byte read back with plain reads, an `error code=` row that is not corruption counting as unreadable, and
    `SQLITE_CORRUPT` from an `EIO` while the schema loads.
  - **SG140 entry:** the paragraph above still says "only a check that ran and reported corruption
    (`SQLITE_CORRUPT*`/`SQLITE_NOTADB` or a result other than `ok`) counts as 'does not fit'". Since SG150, a result
    other than `ok` sets the WAL aside only when it repeats and the files read back. Otherwise the open is refused.
  - **The README index-files section is accurate about:**
    - the causes ("cannot run or cannot read the files … an I/O error");
    - the WAL being kept;
    - the `-<state>` name;
    - the two reminders.
  - **It is inaccurate about two remedies:**
    - The move-back "to recover its writes" cannot work under SG150. A WAL is set aside only when two full checks
      found it corrupt with readable files, so moving it back beside the unchanged index is refused as malformed
      (A37-01). With a server running, it gives A41-01.
    - The README gives "fix the cause and retry", but the message says "free disk space (or fix the cause) and
      retry" (A41-03).
- **Test:** `A41-04` (documentation). As a plain `it`, it fails with `expected 'SG150 (A36-02): the reminder stops
  of…' to match /EIO|I\/O error|read error/`.
- **Location:** `DECISIONS.md:666-676`, `README.md:234-245`.

## Scope checks

- **`cannot check … (EIO: i/o error, read); it is kept` (SG150), every surface (pinned):** with the shim failing
  the check's reads from read 3:
  - `search`, `index`, `drift --json`, `docs --list` and `serve` exit 1, with the line (prefixed `atlas: `) on
    stderr and nothing on stdout;
  - `atlas mcp` exits before the handshake, with the same line on its stderr, and the SDK client sees `MCP error
    -32000: Connection closed`;
  - the WAL stays, nothing is set aside, and with the disk back the next `search` exits 0 with no stderr.

  The other causes (`SQLITE_IOERR_CORRUPTFS`, `a page could not be read: …`, `short read …`) behave the same on
  every surface. Only their text and error type differ (A41-02, A41-03). `nameCorrupt` and `nameBusy` leave all of
  them alone. Because the refusal happens at open, there is still no MCP `isError` or HTTP 500 for it (A37-04).
- **`-wal.foreign-<ms>-<size>-<mtimeNs>`:** the notice and the reminder print the full name on stderr only. The
  name matches `fileState` (for example `…foreign-1793088930368-1736704-1793088929895421381`).
- **"move it back" / "delete it":**
  - **The CLI:** says "move it back" on every open until a write. After `atlas index` (CLI) or `atlas_index`
    (MCP), the next CLI open says `… may have been written since: moving it back would corrupt the index; delete
    it`. Following "delete it" gives a clean exit 0 with no reminder.
  - **`atlas mcp` and `atlas serve`:** print the reminder once at startup and never say that it changed. Tool
    results, `/api/health` and `/api/stats` never mention it (A37-01).
- **Exit codes:** unchanged. Every refusal at open exits 1, and `drift` keeps 0/1/2. The CI workflow fails on any
  code other than 0 or 2, so an I/O refusal turns CI red.

## Re-verified

`audit-27`, `audit-31` and `audit-37` as they are: 30 tests, green in 1m35s. Every `it.fails` still fails.
- **A37-01** (the reminder cannot be followed; a write overtakes it; MCP and HTTP are silent): open.
  - With no server running, the move-back is still refused as malformed with the delete remedy.
  - `atlas index` still prints "move it back … before anything writes the index" and then writes (exit 0). Since
    SG150, the next open says "delete it".
  - With a server running, following the reminder now gives A41-01.
- **A37-02** (an index renamed over a held one is refused with the foreign-WAL remedy): open. The `it.fails` still
  fails on `/delete .* with its -wal and -shm/`.
- **A37-03** (60 s wait on `.open.lock`, then blames a writer): open, unchanged (`OPEN_LOCK_MS` is still 60 000).
- **A37-04** (the README promises MCP `isError`/HTTP 500 for refusals at open): open. The README sentence is
  unchanged, and SG150's new causes also exit before serving (pinned above).
- **A37-05** (the replaced-WAL refusal is a plain `Error`; `openDatabase` writes to the host's stderr): open,
  widened by A41-02.
- **A31-03** (a replacement renamed in under a running `atlas mcp`): open, as in AUDIT-37. It is refused while the
  holder runs, and the old index wins after it stops.
- **A31-04** (`atlas serve` on a 0-byte index: 500 `no such table`, `/api/health` ok): open. The check skips a
  0-byte file.
- **A27-01** (bare `disk I/O error` on a reset beside a writing `atlas mcp`): open. A41-01 reaches the same bare
  text on `/api/stats`.
- **A27-02** (a server answers from, and writes to, a deleted or renamed-over file): open.
- **A27-03** (`immediate()` blocks the MCP event loop while it waits): open. The `it.fails` still fails.

Scratchpad harness (`audit-41/scripts/`):
- `lib.sh` (`mk`, `kw`, `foreign`, `surfaces`, `hold`/`call`);
- `lib.mjs`, `mcp.mjs`, `mcp-hold.mjs`;
- `serve-moveback.sh`, `sm2.sh`, `sm3.sh`;
- the shim is `audit-41/eio/shim.c`.
