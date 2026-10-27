# AUDIT-44: API and SDK consistency, round 11

This audit checks how the CLI, the dashboard HTTP API (`atlas serve`), the MCP tools (SDK over stdio) and the
`@atlas/core` exports behave after SG190 and SG160, and whether `README.md` and `DECISIONS.md` match the code.
Since AUDIT-41 the only `src/` change is SG190 in `src/core/db/database.ts` (`git diff d86227e HEAD -- src`);
SG160 adds `test/db/leftoverWal.test.ts` and deletes `audit-38.test.ts`. SG190 changed:
- `reportAside` now asks `inUse` (`holders`, or a probe under `<db>.open.lock`) whether a live connection holds
  the index. If one does, the reminder says `… which a running Atlas process has open: stop every Atlas process
  on the project (\`atlas serve\`, \`atlas mcp\`) first, then run any \`atlas\` command to see what to do with
  it`. If none does, it says `… if its writes belong there, stop every Atlas process on the project, then move it
  back to <db>-wal before anything writes the index, otherwise delete it`;
- a read-only open runs `PRAGMA schema_version` once (errors swallowed), so `atlas serve` holds the index from the
  open on;
- the `cannot check` remedy is `free disk space (or fix the cause) and retry` only for `SQLITE_FULL`,
  `SQLITE_IOERR_SHMSIZE/WRITE/TRUNCATE`, `ENOSPC`, `EDQUOT` and `EFBIG`, and `fix the cause and retry` otherwise;
- a short read names the index (or its `-wal`), not the check's hard link.

Base: `ead477f` on `claude/atlas-audit-44` (SG190 #86 and SG160 #87 merged). Date: 2026-10-27. The auditor
wrote none of this code. `@modelcontextprotocol/sdk` 1.32.1, better-sqlite3 11.10.0, Node 22.

**Method.**
- I built the CLI with `tsc` into the scratchpad (`audit-44/dist`) and drove it on copies of `fixtures/sample`. I
  read stdout, stderr and the exit code separately.
- `atlas mcp --offline` ran as a long-running session under the stock SDK `Client` + `StdioClientTransport`
  (`scripts/mcp-hold.mjs`). `atlas serve` was queried with curl.
- I/O errors came from AUDIT-41's `LD_PRELOAD` shim (`audit-44/eio/shim.c`). It fails `pread` calls `EIO_FROM`
  to `EIO_FROM+EIO_COUNT-1` on the check's hard link. I added an `open` hook that fails a path suffix with a
  chosen errno.
- Inode exhaustion was real: a 64-inode tmpfs filled with empty files.
- A killed writer commits an `UPDATE` plus one doc per file and SIGKILLs itself. A replaced index is
  `cp B/.atlas/index.db A/.atlas/index.db` beside it.
- I killed every process I started and unmounted the tmpfs.

Repros are in `test/audit/audit-44.test.ts` as `it.fails`, named by ID. I ran each one as a plain `it` and
confirmed that it fails on its stated assertion. For A44-01, I also removed the first assertion and confirmed that
the second fails on its own (`expected 'wrong # of entries in index idx_symbo…' to be 'ok'`). The test that needs
the shim is skipped where there is no `cc`.

**Totals:** 0 critical, 0 high, 1 medium, 1 low. No new SG rows.

## Findings

### Critical

None found.

### High

None found.

### Medium

**A44-01: `atlas serve` and `atlas mcp` still print the move-back offer at startup, from the process that holds
the index from then on. Following it while that server runs ends as A41-01 did: the moved-back WAL is discarded
with no message, the next `atlas index` makes `/api/stats` fail with a bare 500, or, with no write, the index
fails `integrity_check` once the server stops and every command refuses it with a remedy that deletes it.**
Medium.
- **Evidence:** a replaced index beside a killed writer's WAL. The first `atlas search` sets the WAL aside.
  - `atlas serve --cwd A` starts and prints, on its own stderr, `… if its writes belong there, stop every Atlas
    process on the project, then move it back to <db>-wal before anything writes the index, otherwise delete
    it`. `reportAside` runs before the server's own connection exists, so `inUse` finds no holder. A stock
    `atlas mcp` session prints the same line (`scripts/mcp-hold.mjs`).
  - One line later the server holds the index. Since SG190 the read-only open reads `schema_version`, so the
    dashboard holds it before any request. A CLI command run now gets the correct `… which a running Atlas
    process has open: stop every Atlas process …` (pinned).
  - The user follows the server's line with `mv …foreign-* <db>-wal` while the server runs:
    - **No write** (`scripts/toctou3.sh`, 3/3 trials): `atlas search` exits 0 and `/api/stats` answers 200 with
      `docs:0`. After the server stops, the index reads `wrong # of entries in index idx_symbols_qualified` with
      the WAL's 4 docs mixed in. `atlas search` exits 1 with `index <db> is unreadable (database disk image is
      malformed): … delete <db> with its -wal and -shm and run \`atlas index\``.
    - **`atlas index` next** (`scripts/toctou2.sh`, CLI first or dashboard first, 2/2): the CLI exits 0 both
      times, and `/api/stats` answers 500 `{"error":"disk I/O error"}` (bare: no file, cause or remedy) until the
      server restarts. The moved-back WAL's writes are gone, and nothing on any surface says so.
  - **Baseline:** with the server stopped first, as the line says, the outcome is A37-01 (refused as malformed),
    not a mix.
- **Impact:** SG190's acceptance says that with `atlas serve` or `atlas mcp` running, no step of the reminder
  leaves an index that fails `integrity_check` after the server stops. The CLI half holds, but the servers' own
  line does not, and that line is what a user sees in the terminal or the MCP host's log of the process they leave
  running. The README says that while `atlas serve` or `atlas mcp` has the index open, the message "says to stop
  them first instead". Those two processes are exactly the ones that never print that form. MCP hosts also start
  and restart `atlas mcp` on their own. The text does begin with "stop every Atlas process on the project", so a
  careful reader avoids this. That is why this is medium, not A41-01's high.
- **Test:** `A44-01`. As a plain `it`, it fails with `expected 'atlas: /tmp/atlas-audit44-…' not to match /move it
  back/`. With that assertion removed, it fails with `expected 'wrong # of entries in index idx_symbo…' to be 'ok'`.
- **Repro:**
  1. `atlas index A` and `atlas index B` (B = A + `replacementOnlyFn`).
  2. Run the killed writer on `A/.atlas/index.db`.
  3. `cp B/.atlas/index.db A/.atlas/index.db`, then `atlas search add --cwd A` (this sets the WAL aside).
  4. `atlas serve --cwd A --port 4746 2> serve.err &`, then `sleep 1.5`; `serve.err` offers the move-back.
  5. `mv A/.atlas/index.db-wal.foreign-* A/.atlas/index.db-wal`, then `atlas search add --cwd A` (exit 0).
  6. Stop the server. `atlas search add --cwd A` exits 1 (malformed), and `PRAGMA integrity_check` reports
     `wrong # of entries in index idx_symbols_qualified`.
- **Location:**
  - `src/core/db/database.ts:124-127` (`checkLeftoverWal` calls `reportAside` before the caller's connection
    exists);
  - `:386-400` (the move-back form, chosen by `inUse` alone);
  - `src/web/server.ts` and `src/mcp/server.ts` (no other reminder);
  - `README.md:240-244`.
- **Fix:**
  - A long-running opener (`serve`, `mcp`; say an `OpenDbOptions.holds` flag) prints the "running Atlas process
    has open" form, naming itself.
  - Or the move-back is never offered as a manual `mv` (SG190's "better" option: Atlas does it under
    `<db>.open.lock` after re-checking).
  - Either way, the README sentence should say which processes print which form.

### Low

**A44-02: a `cannot check` refusal can still span two lines on stderr. The second line has no `atlas: ` prefix.
A41-03's other halves were fixed in SG190; this one was not.** Low.
- **Evidence:** a replaced index beside a killed writer's WAL (not yet set aside). One `EIO` on the check link's
  read 5, 6, 8, 10, 12, 15, 20 or 30 (`EIO_COUNT=1`; 3/3 at read 10) gives:

  ```
  atlas: index <db>: cannot check <db>-wal, left by a process that stopped (a page could not be read: *** in database main ***
  Tree 3 page 3: unable to get the page. error code=8458); it is kept: fix the cause and retry
  ```

  The exit code is 1, stdout is empty, and the WAL is kept. Reads 0 to 4 give one line
  (`SQLITE_IOERR_CORRUPTFS: disk I/O error`, or `a page could not be read: SQLITE_CORRUPT: …`).
- **Impact:** every other CLI error is one `atlas: …` line. A log scraper or CI step that greps `^atlas:` loses the
  cause's end and the remedy, and `atlas mcp` writes the same two lines to the host's log before it exits. This
  is cosmetic: every surface still refuses, and the WAL is kept.
- **Test:** `A44-02` (needs `cc`). As a plain `it`, it fails with `expected [ …(2) ] to have a length of 1 but got
  2`.
- **Location:** `src/core/db/database.ts:273` (`new Error(\`a page could not be read: ${first}\`)`, where `first`
  is the raw `integrity_check` text).
- **Fix:** flatten the result (`first.replace(/\s*\n\s*/g, '; ')`) before it is put in the message.

## Scope checks

- **SG190, `inUse` gating, the CLI (pinned):**
  - While an `atlas mcp` context holds the index, `atlas search --json` prints `… which a running Atlas process has
    open: stop every Atlas process on the project (\`atlas serve\`, \`atlas mcp\`) first …` on stderr and never
    "move it back". Its stdout JSON and exit code equal those of the same command once the server is closed.
  - Once the server is closed, the CLI offers `stop every Atlas process on the project, then move it back to
    <db>-wal …`.
  - AUDIT-41's SG190 pin covers a read-only connection that has not queried yet, and `atlas serve`.
- **The reminder and the surfaces' outputs (pinned):** for `search`, `search --json`, `drift --json`,
  `docs --list` and `graph --format json`, the reminder is exactly one extra first line on stderr. Stdout, the
  rest of stderr and the exit code are byte-identical to the same command with the set-aside file deleted. This
  includes `drift` with no docs, which exits 1 with `atlas drift: no docs found in the index …`. `atlas serve` and
  `atlas mcp` print the reminder once at startup, on stderr; tool results and `/api/*` never mention it (A37-01).
- **The read-only `schema_version` read:** only `atlas serve` (and library callers) open read-only. The read's
  errors are swallowed, so a refusal still surfaces at the first query, as before (A31-04 unchanged). The read
  takes no snapshot (autocommit): with `atlas serve` up, `atlas index` of a new file moves `/api/stats` from
  `files:4` to `files:5`.
- **Cause and remedy texts:**
  - `EIO` gives `(EIO: i/o error, read); it is kept: fix the cause and retry`, which matches the README's "fix the
    cause and retry" (AUDIT-41 pin).
  - A short read of the index names `<db>` and is the same on every run (A41-03, now a plain `it`).
  - A short read of the `-wal` is caught by SQLite first, as `(SQLITE_IOERR_SHORT_READ: disk I/O error)`, which is
    also stable.
  - Real inode exhaustion (a full 64-inode tmpfs) does not refuse. The read-only check runs without creating a
    `-shm`, keeps the killed writer's own WAL, and exits 0. So the `SQLITE_CANTOPEN` → `fix the cause` remedy is
    reached only with an injected `open` failure, which I do not count as a finding.
- **Exit codes and streams:** unchanged. Every refusal at open exits 1 with one `atlas: ` message on stderr (except
  A44-02), and `drift` keeps 0/1/2.
- **SG160:** `test/db/leftoverWal.test.ts` is test-only and changes no surface. It does not pin SG190's held/free
  reminder forms (`grep "running Atlas process"` finds nothing). They are pinned only by `audit-41` and `audit-44`
  (A32-01's class; for the coverage audit).

## Re-verified

`audit-3`, `-7`, `-11`, `-15`, `-19`, `-23`, `-27`, `-31`, `-37` and `-41` as they are: 115 tests, green in 91 s.
Every `it.fails` still fails.

| ID | Finding | Status | Evidence now |
| --- | --- | --- | --- |
| A41-02 | `cannot check` thrown as `SqliteError`, Node `Error` (`EIO`) or a plain `Error` with no code | open | `it.fails` still fails on `eio: expected false to be true`; SG190 did not touch the error types |
| A41-03 | cause and remedy: "free disk space" for I/O, `.check` link named, multi-line, mislabelled corruption | partly fixed | the link name and remedy are fixed (now a plain `it`); the multi-line cause remains (A44-02) |
| A41-04 | DECISIONS records only SG150's reminder half; SG140 entry says any non-`ok` result means "does not fit" | open | the SG150 line is unchanged apart from the appended SG190 sentence; the SG140 sentence is unchanged |
| A37-01 | the reminder cannot be followed; a write overtakes it; MCP and HTTP silent | open | `atlas index` still prints "move it back … before anything writes the index" and exits 0. With nothing running, the move-back is still refused as malformed (`exit=1`, delete remedy). Following it with a server up gives A44-01 |
| A37-02 | an index renamed over a held one is refused with the foreign-WAL remedy | open | `it.fails` still fails |
| A37-03 | 60 s wait on `.open.lock`, then blames a writer | open | `OPEN_LOCK_MS` is still 60 000. `inUse` now also takes the lock where `holders` cannot tell |
| A37-04 | the README promises MCP `isError`/HTTP 500 for refusals at open | open | the README sentence is unchanged; every refusal still exits before serving |
| A37-05 | the replaced-WAL refusal is a plain `Error`; `openDatabase` writes to the host's stderr | open | unchanged; SG190 adds more stderr text from `openDatabase` |
| A31-03 | a replacement renamed in under a running `atlas mcp` | open | `it.fails` still fails |
| A31-04 | `atlas serve` on a 0-byte index: 500 `no such table`, `/api/health` ok | open | unchanged by the new `schema_version` read: `/api/health` `{"ok":true,…}`, `/api/stats` `{"error":"no such table: files"}` |
| A27-01 | bare `disk I/O error` on a reset beside a writing `atlas mcp` | open | A44-01 reaches the same bare 500 on `/api/stats` |
| A27-02 | a server answers from, and writes to, a deleted or renamed-over file | open | `it.fails` still fails |
| A27-03 | `immediate()` blocks the MCP event loop while it waits | open | `it.fails` still fails |

## Notes

- `inUse` counts the caller's own process. A library embedder that holds one connection and opens a second sees
  the "a running Atlas process has open" form about itself. No CLI, MCP or HTTP path opens the index twice, so
  this is not a finding.
- Where `holders` cannot tell (no `/proc/locks`, for example on macOS, or overlayfs), `inUse` takes
  `<db>.open.lock` and probes through a hard link on every open with a matching set-aside file. In a read-only
  directory the probe's `link()` fails and reports a holder, so the "running Atlas process" form would be printed
  with none running. I did not reproduce this on Linux.
- Scratchpad harness (`audit-44/scripts/`):
  - `lib.sh` (from AUDIT-41), `mcp.mjs`, `mcp-hold.mjs`, `lib.mjs`;
  - `toctou.sh`, `toctou2.sh`, `toctou3.sh`;
  - the shim is `audit-44/eio/shim.c` (adds the `open` hook).
