# AUDIT-42: soundness (round 13, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `6c68a67` (SG190 #86 and AUDIT-38 merged) on
`claude/atlas-audit-42`. Date: 2026-10-27.

Question: can Atlas silently lose committed index data, answer wrongly with success, or corrupt its index? Scope:
SG190 in `src/core/db/database.ts`:
- `reportAside` offers the move-back only when the private `inUse` sees no live connection. `inUse` reads
  `holders` (`/proc/locks`), and where that cannot tell it probes under `<db>.open.lock` (`lockOpens`). A probe
  that fails counts as held.
- The new reminder texts: "… which a running Atlas process has open: stop every Atlas process on the project
  (`atlas serve`, `atlas mcp`) first, then run any `atlas` command to see what to do with it", and "… if its writes
  belong there, stop every Atlas process on the project, then move it back to <db>-wal before anything writes the
  index, otherwise delete it".
- A read-only `openDatabase` reads `schema_version` once, so the connection holds the index from the open on. Any
  error from that read is ignored.

Also re-checked: A39-01, A39-02, A39-03, A36-03, A34-03, A34-04, A29-01, A29-02, A31-04, A25-02, A25-03, A21-01 and
A21-02.

Method:
- **Real processes.** I built the CLI from this tree into the scratchpad (`audit-42/dist`). The pre-SG190 build
  (`audit-41/dist`, `89d019a`) was the baseline. I used copies of the sample fixture. A "killed writer" commits an
  `UPDATE` of every symbol plus one doc per file, then SIGKILLs itself. A "replaced index" is a copy of another
  checkout's index (`B` = the sample plus `replacementOnlyFn`) over `A`'s after the kill. `atlas serve` was queried
  with curl. `atlas mcp --offline` was held open under the SDK client (`mcp-hold.mjs`, AUDIT-41).
- **Pid namespaces.** I ran `unshare --pid --fork --mount-proc` with `atlas serve` inside it and the CLI outside
  (`pidns.sh`), and the other way round (`nscli.sh`). From a child pid namespace, `/proc/locks` shows none of the
  parent's locks: a Python `lockf` held on the host is 1 line on the host and 0 lines in the child.
- **No `/proc/locks`.** I used `unshare -m` with a tmpfs over `/proc` (macOS/BSD stand-in), with and without a
  holder, and with `<db>.open.lock` held by another process (`noproc.sh`).
- **The read-only read.** `rolock.mjs` opens the index read-only through the built `openDatabase`, then another
  process runs an `UPDATE`, `wal_checkpoint(TRUNCATE)` and `BEGIN EXCLUSIVE` with a 0 ms busy timeout.
  `garbage.sh` runs `atlas serve` and `atlas search` on an index replaced by random bytes, cut to half, or replaced
  by a non-Atlas SQLite file, on both builds.
- **The residual races the SG190 author noted.**
  - `startrace.sh` runs the move-back (`mv`) 0 to 600 ms after starting `atlas serve`, in 17 runs.
  - `mcpidx.sh` holds an `atlas mcp`, calls `atlas_index`, then stops it.
  - `ownrelaunch.sh` sets a killed writer's own WAL aside (named as `setAside` names it). The user then stops
    every Atlas process and moves the WAL back. In one variant an MCP client has started `atlas mcp` again
    before the move.
- **Regressions.** I ran the audit-21, -25, -29, -31, -33, -34, -36, -37, -39 and -41 files as they are (97/97
  pass, 1m49s). Then I ran the re-checked files with every `it.fails` turned into `it`.

The scripts are in the session scratchpad under `audit-42/scripts/`:
- `lib.sh`, `pidns.sh`, `nscli.sh`, `noproc.sh`;
- `rolock.mjs`, `garbage.sh`;
- `startrace.sh`, `mcpidx.sh`, `ownrelaunch.sh`;
- `mcp.mjs`, `mcp-hold.mjs` and `lib.mjs` (from AUDIT-41).

I killed every process I started and removed the namespaces. No loop device or mount was used beyond the
per-command `unshare -m` tmpfs, which went away with its command.

Repros are in `test/audit/audit-42.test.ts`. Each `it.fails` asserts the correct behaviour. I ran the file with each
`it.fails` as a plain `it`: each failed on the assertion that names its defect (messages below). The tests are
deterministic and need no privileges:
- a `--require` preload makes `/proc/locks` read as an empty file, which is what a CLI in another pid namespace
  reads, or makes it missing (macOS/BSD);
- a connection opened in the test process stands in for a running `atlas serve` (read-only) or `atlas mcp`
  (writable);
- a `BEGIN EXCLUSIVE` on `<db>.open.lock` held by the test process stands in for another opener inside
  `openDatabase`.

Plain `it` blocks pin what was attacked and held.

**Summary: 0 critical, 0 high, 1 medium, 2 low.**
- What holds:
  - A41-01 is fixed where `/proc/locks` lists the holder. With `atlas serve` up (one query or none), every CLI
    command says "which a running Atlas process has open: stop every Atlas process …" and never "move it back".
  - With no `/proc/locks`, the probe sees the same holder.
  - After `atlas mcp` writes (`atlas_index`), the reminder says "delete it", both while it runs and after it
    stops.
  - The read-only read takes no lasting lock or transaction. Another process's `UPDATE`,
    `wal_checkpoint(TRUNCATE)` (busy 0) and `BEGIN EXCLUSIVE` all succeed at once with a 0 ms busy timeout while a
    read-only `openDatabase` connection is open.
  - The ignored error hides nothing. On random bytes, a half-truncated index and a non-Atlas SQLite file,
    `atlas serve` and `atlas search` give the same output on the SG190 build as on the baseline. The first query
    names the error (`unreadable (file is not a database)`, HTTP 500 with the same text).
  - No self-deadlock. `reportAside` runs before `checkLeftoverWal` takes `<db>.open.lock`, and `inUse` releases
    the lock before the open takes it. No path nests the two.
  - The serve start-up race fails closed. In 17 runs of `startrace.sh`, a `mv` that landed before `atlas serve`
    reached `leftoverWal` was checked and refused as malformed. That includes the two runs where serve had
    already printed the move-back offer. A `mv` after serve held the index was ignored by every reader. No run
    answered from the mix. The window between `leftoverWal` and the new read (a few ms) was never hit.
- The medium (**A42-01**): `inUse` trusts a `/proc/locks` that does not list every holder. A CLI in another pid
  namespace (a dev container) sees no lock from an `atlas serve` or `atlas mcp` on the host. It then offers the
  move-back while the server holds the index. Following it gives A41-01's split: the container's CLI exits 1 with
  the remedy that deletes the index, the host's CLI exits 0, and `/api/stats` answers 200.
- The lows:
  - **A42-02**: once moved back, a WAL that a live connection will not read is dropped with no message. One case
    is an MCP client that started `atlas mcp` again after the user stopped every Atlas process. Another is
    A42-01's hidden holder. For an own WAL that was set aside wrongly (A39-01, A36-01), every CLI command exits 0
    without its rows. The holder's next write then restarts the WAL over them. 24 rows and 4 docs are lost and no
    surface says so.
  - **A42-03**: where `holders` cannot tell (no `/proc/locks`, or A36-03's stray lock), a set-aside file makes
    every open take `<db>.open.lock` in `inUse`. A plain read then waits behind another opener. It waits 60 s and
    fails with `open: database is locked (another process is writing the index; …)` when that opener holds the lock.
    Without the set-aside file, the same read returns in 0.34 s.
- Still open: A39-01, A39-02, A39-03, A36-03, A34-03, A34-04, A29-01 (2), A29-02, A31-03, A31-04, A25-02, A25-03,
  A21-01 (2) and A21-02. Their `it.fails` still fail when run as plain `it`.

No new PLAN rows (no critical or high finding).

## Re-verified (changes since AUDIT-39 and AUDIT-41)

| Change | Attack | Result |
| --- | --- | --- |
| SG190: `inUse` via `holders` | A41-01's repro (`pidns.sh`, same namespace): set aside, `atlas serve`, CLI | "which a running Atlas process has open: stop every Atlas process …", no "move it back". A41-01 fixed (its test is a plain `it`, and passes). |
| SG190: `inUse` via `holders` | `atlas serve` inside `unshare --pid --fork --mount-proc`, CLI on the host | Host sees the child's locks: "has open". Holds. |
| SG190: `inUse` via `holders` | `atlas serve` on the host, CLI inside `unshare --pid --fork --mount-proc` (`nscli.sh`) | **Move-back offered while serve holds the index (A42-01).** |
| SG190: probe fallback | `unshare -m` + tmpfs over `/proc`: no holder, then `atlas serve` up (`noproc.sh`) | No holder: "move it back". Serve up: "has open". Holds. |
| SG190: probe under `lockOpens` | the same, with `<db>.open.lock` held by another process | **60.6 s, then exit 1 `open: database is locked …` (A42-03).** Without the set-aside file: 0.34 s, exit 0. With `/proc/locks`: 0.34 s. |
| SG190: probe under `lockOpens` | nesting with the open's own lock | `reportAside` runs before `lockOpens` in `checkLeftoverWal`. `inUse` releases before. No nesting, no self-wait. Holds. |
| SG190: read-only `schema_version` read | `rolock.mjs`: another process's `UPDATE`, `wal_checkpoint(TRUNCATE)`, `BEGIN EXCLUSIVE` with a 0 ms busy timeout | `4 rows`, `busy 0`, `ok`, all 0–1 ms. `inTransaction` false. Pinned. |
| SG190: errors ignored | `garbage.sh`: random bytes, half the file, a non-Atlas SQLite file; `atlas serve` + `atlas search`, SG190 vs `89d019a` | Identical on both builds: serve answers 500 naming `unreadable (file is not a database)` / `(database disk image is malformed)`; the search refusal is unchanged. Pinned. |
| SG190: reminder after a write | `mcpidx.sh`: held `atlas mcp`, `atlas_index`, stop | Before mcp: "move it back"; held: "has open"; after `atlas_index` (WAL 164 KB) and after stop: "may have been written since … delete it". Pinned. |
| SG190: residual — `mv` while `atlas serve` starts | `startrace.sh`, 17 delays 0–600 ms | Before serve's check: serve refuses as malformed, exit 1 (fails closed). Serve up: the WAL is ignored, `/api/stats` 200 `docs:0`, CLI exit 0, `index.db` alone `ok`. Next open after the stop: refused as malformed. No mix served. |
| SG190: residual — holder appears after the reminder | `ownrelaunch.sh`: own WAL set aside; `mv` back with every process stopped, or with `atlas mcp` started again | Stopped: 24 rows, 4 docs back. **Relaunched: exit 0 with no message, `atlas drift` "no docs found", and after `atlas_index` and the stop 0 rows, 0 docs (A42-02).** |
| A33–A41 pins | audit-21/25/29/31/33/34/36/37/39/41 files as they are | 97/97 pass (1m49s). |

## Critical

None found.

## High

None found.

## Medium

### A42-01 `inUse` trusts a `/proc/locks` that does not list every holder: from another pid namespace the move-back is offered while `atlas serve` holds the index

- **Evidence:**
  - **Why.** `inUse` takes `holders(path)` as the answer whenever it is not `undefined`. `holders` returns
    `{ db: false, shm: false }` when no line in `/proc/locks` names the index's inode. On Linux 4.13 and later,
    `/proc/locks` read from a child pid namespace leaves out every lock held by a process outside it. On the host,
    one `lockf` shows as 1 line; inside `unshare --pid --fork --mount-proc` it shows as 0. So a CLI in a dev
    container, beside an `atlas serve` or `atlas mcp` on the host (or in another container) sharing the project
    directory, is told no one holds the index. It prints the move-back text. That is the class A34-04 found for
    `decideWal`. SG190 now also uses it to choose the user's instructions.
  - **Real run (`nscli.sh`).**
    1. Set the WAL aside: a replaced index beside a killed writer's WAL, then `atlas search`.
    2. Start `atlas serve --cwd A` on the host.

    Then:

    | Step | Host | Container (`unshare --pid --fork --mount-proc`) |
    | --- | --- | --- |
    | `atlas search add` | exit 0, "which a running Atlas process has open: stop every Atlas process …" | exit 0, **"if its writes belong there, stop every Atlas process on the project, then move it back to …index.db-wal"** |
    | `mv …foreign-* index.db-wal` (in the container) | | |
    | `atlas search replacementOnlyFn` | exit 0 | exit 1, `unreadable (database disk image is malformed) … delete …index.db with its -wal and -shm` |
    | `/api/stats` | 200 `{"files":4,"symbols":25,"edges":15,"docs":0}` | |
    | serve stopped, then `atlas search` | exit 1, the same refusal (`index.db` alone passes `integrity_check`) | |

    The container's CLI is the one that offered the move-back. The two surfaces then disagree in the same moment
    (exit 1 against exit 0 and HTTP 200). The remedy deletes an index that a server still holds, which is A29-01
    (the dashboard's bare `disk I/O error`). For an own WAL (A39-01, A36-01), the same hidden holder drops the
    moved-back rows with no message (A42-02).
  - **Why medium, not high (A41-01 was high).** The offer still says "stop every Atlas process on the project".
    The user has to believe they did that, while the host's server is invisible from the container. Dev
    containers beside a host `atlas mcp` (started by an editor) are the common case AUDIT-34 named.
- **Test:** `A42-01 from a CLI whose /proc/locks does not list the holder (another pid namespace), the reminder does
  not offer the move-back while \`atlas serve\` holds the index`. A preload makes `/proc/locks` read as an empty
  file. It fails with `expected 'atlas: /tmp/atlas-audit42-…' not to match /move it back/`. A plain `it` pins that
  the real `/proc/locks`, and the probe where `/proc/locks` is missing, both see the same holder.
- **Repro (scratchpad, root):** `scripts/nscli.sh <port>`.
- **Fix:**
  - Treat "no lock listed" as unknown unless the reader can see every holder. One way is to call `probe` (under
    `lockOpens`) whenever `holders` lists no holder, as `inUse` already does for `undefined`. The cost is one
    probe per open that has a set-aside file, and only those opens.
  - Better, as PLAN's SG190 row suggested: Atlas does the move-back itself under `<db>.open.lock`, after a probe
    and a fresh check, so no reminder depends on what `/proc/locks` shows.

## Low

### A42-02 A moved-back WAL that a live connection will not read is dropped with no message: an own WAL's rows are lost after the user did what the reminder says

- **Evidence:**
  - **Why.** The move-back is a manual step. Atlas checks for holders when it prints the reminder, not when the
    user runs `mv`. If a connection holds the index at the moment of the `mv`, its live `-shm` says the WAL is
    empty. Every reader then ignores the moved-back frames. `checkLeftoverWal` skips its check beside a live holder
    (`liveWal(holders(path))`), and no set-aside file is left to report. The holder's next write starts the WAL
    over from its header, over the moved-back frames. Its close deletes the file.
  - A holder can appear between the reminder and the `mv` without the user starting one:
    - an MCP client (an editor, a desktop app) that starts `atlas mcp` again when it sees it gone;
    - an `atlas serve` the user cannot see (A42-01).
  - **Real run (`ownrelaunch.sh`, sample).** A killed writer's own WAL is set aside, as A39-01 (a bad page) or
    A36-01 (an I/O error) leaves it. The reminder says to stop every Atlas process, then move it back.

    | | stopped, then `mv` | `atlas mcp` started again, then `mv` |
    | --- | --- | --- |
    | `atlas search` | exit 0, stderr empty | exit 0, stderr empty |
    | `atlas drift --json` | exit 2 (the 4 docs are there) | exit 1, `no docs found in the index (run \`atlas docs\` first)` |
    | after `atlas_index` and the stop | 24 rows, 4 docs, no WAL | **0 rows, 0 docs, no WAL, no set-aside file** |

    Nothing on any surface says the moved-back WAL was not read. The rows and docs were the only copy (with a real
    model, the docs cost tokens again).
  - **Why low.** It needs a WAL set aside that was the index's own (A39-01, A36-01, A39-03), and a holder at the
    moment of the `mv`. A foreign WAL dropped this way loses nothing that belonged to the index.
- **Test:** `A42-02 an own WAL moved back while \`atlas mcp\` holds the index (an MCP client started it again) is
  reported, or its rows and docs survive the next write`. It fails with `stderr "", seen {"stale":0,"docs":0}:
  expected false to be true`. A plain `it` pins that the same move-back with every process stopped restores 24
  rows and 4 docs.
- **Repro:** `scripts/ownrelaunch.sh relaunch` (and `ownrelaunch.sh stop` for the baseline).
- **Fix:**
  - Do the move-back in Atlas under `<db>.open.lock`, refusing while any holder is live (PLAN's SG190
    alternative). Then there is no window between the check and the rename.
  - Short of that: when an opener sees a `-wal` with frames whose salts differ from a live `-shm`'s header (a
    WAL no live connection will read), say so on stderr and on every surface. Then the user can stop the holder
    before its next write.

### A42-03 Where `holders` cannot tell, a set-aside file makes every read wait on `<db>.open.lock`: 60 s and a false "another process is writing" when an opener holds it

- **Evidence:**
  - **Why.** `reportAside` runs on every open while a set-aside file matches the index's state. Where `holders`
    returns `undefined`, `inUse` takes `lockOpens(path)` to probe. That happens on macOS/BSD (no `/proc/locks`),
    in a sandbox without procfs, and with A36-03's stray lock on the same inode number on another filesystem. The
    lock waits up to `OPEN_LOCK_MS` (60 s), then throws `open: database is locked (another process is writing the
    index; retry when it finishes)` out of `checkLeftoverWal`. Before SG190, a read with no leftover WAL never
    took that lock. Another opener can hold it for the whole of an integrity check (AUDIT-35: 1.6 s at 10k dense
    symbols, more on larger indexes), or for as long as that opener is stopped (Ctrl+Z, a debugger) inside
    `openDatabase`.
  - **Real run (`noproc.sh`, `unshare -m` + tmpfs over `/proc`).** Another process holds `BEGIN EXCLUSIVE` on
    `<db>.open.lock`:

    | `atlas search add` | Result |
    | --- | --- |
    | set-aside file present, `/proc/locks` present | 0.34 s, exit 0 |
    | set-aside file present, no `/proc/locks` | **60.56 s, exit 1, `atlas: open: database is locked (another process is writing the index; retry when it finishes)`** |
    | no set-aside file, no `/proc/locks` | 0.34 s, exit 0 |

    No writer was running. The message blames one, and the read needed no lock at all.
  - **Why low.** It fails closed (no wrong answer, no lost data). It needs both a platform or host where
    `holders` cannot tell, and a set-aside file that is still offered back.
- **Test:** `A42-03 without /proc/locks (macOS, BSD), a read beside a set-aside WAL does not wait 60 s for another
  opener and fail as "database is locked"`. It fails after 60 s with `atlas: open: database is locked (another
  process is writing the index; retry when it finishes): expected 1 to be +0`. A plain `it` pins that without the
  set-aside file the same read does not wait.
- **Repro:** `scripts/noproc.sh <port>` (root, for `unshare -m`).
- **Fix:** in `inUse`, take the open lock with a 0 ms timeout. If another opener holds it, say "cannot tell" and
  print the "has open" text (or the plain "stop every Atlas process first" text) instead of waiting. A reminder
  must never block or fail the command that prints it.

## Notes (no test)

- **The window SG190's author named (a `mv` while `atlas serve` starts).** The window is between `leftoverWal`
  and the new `schema_version` read. It spans `new Database` and loading `sqlite-vec`, a few ms. A `mv` there would
  be replayed by serve without a check. None of the 17 `startrace.sh` runs landed in it, and none served a
  mix. In two runs serve printed the move-back offer itself (`reportAside` runs before it holds) and then
  refused the WAL that arrived. That is the right outcome, but serve's own start-up output tells the user to move
  the WAL back.
- **The probe that counts as held.** `probe` returns `{ db: true }` when `fileInUse` throws, for example where
  hard links fail (`EPERM` on FAT/exFAT and some SMB mounts). With no `/proc/locks` there (macOS with an external
  exFAT drive), every command says "has open: stop every Atlas process …, then run any `atlas` command to see
  what to do with it". It says so again after everything is stopped, so it never gives the move-back. That fails
  safe, but it can push the user to delete an own WAL. This is from reading the code; there was no FAT tool in
  this container.
- **The ignored read can leave a running server unseen.** If the read fails for a reason other than a bad file,
  the connection holds nothing until its first query. Examples are `SQLITE_BUSY` after 5 s (another connection's
  WAL recovery on a large WAL) and a transient `EIO`. For `atlas serve`, that first query is the first HTTP
  request, so A41-01's text can come back until then. I did not reproduce a 5 s busy on a read-only open.
- **`inUse` reads `liveWal` (file and `-shm` both locked).** `decideWal` treats a lock on the `-shm` alone as a
  live connection to a renamed-over file (A33-05). `inUse` does not, so it would offer the move-back beside such
  a holder. To reach that, the set-aside name must match a file renamed over a held index. I found no path that
  does this without a hand-made copy with a preserved mtime.
- **A user who ignores "has open".** If the user moves the WAL back while `atlas serve` holds the index (the
  reminder said not to), every reader ignores the frames (`/api/stats` 200 `docs:0`, CLI exit 0). After the
  stop, the next open refuses the WAL as malformed with the remedy that deletes the index. `index.db` alone
  passes `integrity_check`. No mix is served, unlike A41-01 before SG190.
- **Still open.** I ran the audit-21, -25, -29, -31, -34, -36 and -39 files with `it.fails` → `it`. These still
  fail with their recorded messages:
  - A21-01 (2), A21-02, A25-02 and A25-03;
  - A29-01 (2): `expected 'disk I/O error' to match /atlas (serve|mcp)|another process/`;
  - A29-02: `expected 1 to be +0`;
  - A31-03: refused with `another process still has the replaced index open`, as in AUDIT-39;
  - A31-04: `expected 'no such table: files' not to match /no such table/`;
  - A34-03: `expected 'DOC-FOR-src/math.ts\n' not to match …`;
  - A34-04 and A36-03: `… not to match /^atlas: disk I\/O error$/m`;
  - A39-01: `… not to match /does not belong to/`;
  - A39-02: `… not to match /move it back/`;
  - A39-03: `… not to match /moving it back would corrupt the index/`.

  SG190 changes none of them. A39-02 still applies to the new move-back text: on 1 s timestamps the text still
  offers the move-back after a same-second write.
