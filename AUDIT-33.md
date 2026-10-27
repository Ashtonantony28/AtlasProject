# AUDIT-33: soundness (round 9, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `e2a6fd5` (SG120 merged; SG105 merged in
`72cd743`) on `claude/atlas-audit-33`. Date: 2026-10-27.

Question: can Atlas silently lose, duplicate or misreport index data, or show something stale as current? Scope:
the two fixes merged since AUDIT-29, and the findings that are still open:
- SG105: `switchToWal` stats the file once, before its first try, and retries a refused switch while it was empty
  then;
- SG120 in `src/core/db/database.ts`:
  - `dropForeignWal`: a `-wal` is looked at only when `index.db`'s ctime is newer than the WAL's mtime. Then:
    - a probe (`fileInUse`: a hard link opened in exclusive locking mode) checks whether anyone holds the file;
    - `neverCheckpointed` reads the `-shm`: matching salts, `nBackfill` and `nBackfillAttempted` both 0;
    - a "never checkpointed" WAL is unlinked after an inode/mtime recheck; otherwise `checkIntegrity` runs a
      read-only `PRAGMA integrity_check`;
  - `nameCorrupt` (CLI top level, `drift`, the MCP tool wrapper, the HTTP handler);
  - `closeOnSignal` in `index`, `docs` and `mcp`;
- open findings: A29-01, A29-02, A31-03, A31-04, A25-02, A25-03, A21-01 and A21-02.

Method:
- **Real processes and real repos.** I built the CLI from this tree into the scratchpad, and built the pre-SG120 tree
  (`68fb2c2`) from `git archive` the same way. I used copies of express, flask and got from the scratchpad clones.
  A "killed writer" is one of two things:
  - `atlas mcp` (built, over stdio with the SDK client) that ran `atlas_index` after an edit and was then SIGKILLed,
    as an editor force-quitting it does;
  - a process that commits an `UPDATE symbols SET docstring = 'STALE-WAL-' || id` and SIGKILLs itself, as in
    AUDIT-31.
- **Legitimate WALs.** I looked for anything that makes `index.db`'s ctime newer than its own WAL's mtime:
  - copying or moving the project or the three index files: `cp -r`, `cp -a`, `tar c | tar x`, `mv` in place and
    to another directory;
  - `touch`/`chmod` beside a live writer in another process, and in the same process;
  - Atlas's own probe link.
- **Foreign WALs.** I replaced `index.db` with another checkout's index, or with an older backup of the same index,
  beside a stale WAL. I varied:
  - a symlinked `index.db` (the target in another directory);
  - a missing or empty `-shm`;
  - a read-only bind mount (`mount --bind -o ro`, so `link()` fails);
  - a 1-second-timestamp ext4 (`mkfs.ext4 -I 128`, loop-mounted);
  - the WAL never checkpointed, or with a checkpoint started (a reader pinned the rest).
- **Races.** 2–4 processes run `openDatabase` (read-write and read-only) at the same instant on a replaced index
  beside a never-checkpointed foreign WAL. There were 160 trials, plus a 30-trial single-opener control. For SG105:
  40 trials of 8 creators and 3 readers each, beside a stale WAL.
- **Signals.** I sent SIGINT, SIGTERM, SIGHUP, and two SIGINTs 5 ms apart:
  - to `atlas index --force` at 0.3, 0.7 and 1.1 s on express, flask and got (48 runs);
  - to `atlas mcp` during an in-flight `atlas_index {force}` (12 runs).

  Each time I compared the next `atlas index` with a fresh index of the same tree (files, symbols, edges,
  embedded set and integrity, as digests).
- **Surfaces.** I checked which errors reach users unnamed.

The harness scripts (`mcpkill.mjs`, `walstate.mjs`, `e1.sh`, `race.sh`, `opener.mjs`, `sigrun.mjs`,
`mcpinflight.mjs`, `mvlive.mjs`) are in the session scratchpad under `a33/scripts/`. Every finding also has an in-repo
test.

Repros are in `test/audit/audit-33.test.ts`. Each `it.fails` asserts the correct behaviour. I ran each one as a
plain `it` (three times), and each failed on the assertion that names its defect (messages below). Plain `it`
blocks pin what was attacked and held.

**Summary: 0 critical, 2 high, 1 medium, 2 low.**
- What holds:
  - SG120's signal handling. All SIGINT/SIGTERM stops of `atlas index` and `atlas mcp` died by the signal, left no
    `-wal` and an index with integrity `ok`, and the next run equalled a fresh index (60/60).
  - The probe sees a live holder in another process, and in the same process (its close does not drop the holder's
    locks).
  - The SG120 path that keeps a WAL whose checkpoint started refuses a different replacement with the named message.
  - SG105 lost no write: 320/320.
- The highs:
  - **A33-01, a regression from SG120.** Copying or moving an index with its own WAL loses the WAL's commits. SG120
    reads "ctime newer than the WAL" as "replaced", but `cp`, `cp -a`, `tar` and `mv` all make that true for the
    WAL's own index. The README tells users to move the three files together.
  - **A33-02, the SG120 check races itself.** The probe cannot tell another opener's probe from a live holder, so
    the second opener skips the check and replays the foreign WAL. Of 160 racing trials, 34 answered from the mix
    with success and left the replacement permanently corrupt.
- The medium (A33-03): on any error the check gives up silently, and SQLite replays the foreign WAL (A31-01
  unchanged). The triggers are a symlinked `index.db`, a missing `-shm`, and a directory where `link()` fails.
- The lows:
  - **A33-04:** a replacement within one timestamp tick of the WAL is not detected (1 s filesystems: 10/10).
  - **A33-05:** SG120 unlinks a live `atlas mcp`'s WAL when its index is renamed over. Every CLI command then fails
    with a bare `disk I/O error` until the server exits.
- Still open: A29-01, A29-02, A31-03 (changed, see A33-05), A31-04, A25-02, A25-03, A21-01 (2 tests) and A21-02.
  Their `it.fails` still fail when run as plain `it`.

PLAN rows: SG130 (A33-01) and SG135 (A33-02, A33-03 and A33-04 share its fix).

## Re-verified (changes since AUDIT-29)

| Change | Attack | Result |
| --- | --- | --- |
| SG120 `closeOnSignal` (`index`) | SIGINT, SIGTERM, double SIGINT at 0.3/0.7/1.1 s of `atlas index --force` on express, flask, got (36 runs); `SIGTERM` pin in-test | Every run died by its signal (no exit-code change; a background job still exits 130, as before SG120). SIGINT/SIGTERM left no `-wal`. A second SIGINT during the closing checkpoint left a `-wal` 2/9 times, with integrity `ok`. The next run equalled a fresh index 36/36. |
| SG120 `closeOnSignal` (`mcp`) | SIGTERM/SIGINT at 0.2/0.6/1.0 s into an in-flight `atlas_index {force}` on express, got (12 runs); pin in-test | 12/12 died by the signal, no `-wal`, the next run equalled a fresh index. No hang and no double close. |
| SIGHUP (not handled) | as above (9 runs) | Died by SIGHUP with a 4.2–4.6 MB `-wal` left (A31-02 residual, Notes). The next run converged 9/9. |
| SG120 probe vs live holders | another process that committed and keeps the index open, then `touch index.db`; a second `openDatabase` in the holder's own process | The WAL is kept and replayed (pinned). The in-process probe's close leaves the holder's lock held (pinned). |
| SG120 drop of a never-checkpointed WAL | the A31-01 repro on fine-grained ext4 | The replacement is read (pinned by audit-31). Regression for the WAL's own index: A33-01. |
| SG120 keep + integrity check | a WAL whose checkpoint had started, beside another checkout's index or a backup with edits (express, flask, got) | Refused on the CLI with the named message, 3/3. Beside a byte-identical backup the WAL replays consistently (Notes). |
| SG120 `nameCorrupt` | corrupt replacements on the CLI, a racing opener | Named. Racing openers that hit corruption got the named `SQLITE_CORRUPT` message (6 opens). `SQLITE_IOERR_SHORT_READ` is still bare (A29-01, A33-05). |
| SG105 retry | 40 trials × (8 writers + 3 readers) opening a missing index beside a stale WAL at the same instant | 320/320 writer rows kept, all WAL, integrity `ok`. Readers got 22 `SQLITE_CANTOPEN` (file not yet created) and 58 `no such table: files` (the A29 note and A31-04). AUDIT-29's racing-creators test passes. |

## Critical

None found.

## High

### A33-01 An index copied or moved together with its own WAL loses the WAL's commits (regression from SG120)

- **Evidence:**
  - **Why.** `dropForeignWal` treats "`index.db`'s ctime is newer than the WAL's mtime" as "the file was replaced".
    Copying or moving the files makes that true for the WAL's own index:
    - `cp -a`, `rsync -a` and `tar` preserve the WAL's mtime but give the new `index.db` a new ctime;
    - `mv` updates the moved inode's ctime but keeps its mtime;
    - `cp -r` copies in directory order, so the WAL may be written before `index.db`.

    If the writer that left the WAL was killed (SIGKILL, OOM, crash, an editor force-quitting `atlas mcp`), its
    `-shm` says "never checkpointed", and the WAL is unlinked as foreign.
  - **What a killed writer leaves.** This is the normal tail of every run, not an edge case: the WAL generation
    after the last completed checkpoint. After `atlas_index`, the shm read `nBackfill = nBackfillAttempted = 0`
    with matching salts on all three repos (149, 248 and 342 frames). The index stays consistent but reverts to
    the last checkpoint.
  - **Built CLI.** `atlas index`, edit one file, `atlas_index` via `atlas mcp`, SIGKILL, then copy or move. Then
    `atlas search <new fn> --cwd <copy>`:

    | Repo | in place | `cp -r` | `cp -a` | `tar` | `mv` ×3 in place |
    | --- | --- | --- | --- | --- | --- |
    | express | found | found (lost in an earlier run) | **lost**, exit 0 | **lost** | **lost** |
    | flask | found | **lost** | **lost** | **lost** | **lost** |
    | got | found | found | **lost** | **lost** | **lost** |
    | any, pre-SG120 (`68fb2c2`) | found | found | found | found | found |

    Every "lost" exits 0 with an unrelated top hit (`getMajorVersion`, `version`, `defaultInternals`). The copy's
    integrity is `ok`. The next `atlas index` re-parses the file and recovers the symbol.
  - **Docs are not recoverable.** I SIGKILLed `atlas docs` on express after 60 modules had been written. In place,
    `atlas docs --list` shows 60 docs. After `cp -a`, it says `no docs yet` (60 → 0). `exportDocs` only runs at the
    end of a run, so with a real model those tokens are spent again.
  - **It contradicts the docs.** DECISIONS (SG120) names `chmod`/`touch` as the only false positive. The README
    says "The three move together", which is exactly the move that loses them.
- **Tests:**
  - `A33-01 cp -a of a project … keeps the commits in its index.db-wal` fails with `expected +0 to be 24`.
  - `A33-01 renaming index.db, -shm and -wal … keeps the WAL's commits` fails with `expected +0 to be 24`.
  - A plain `it` pins the in-place replay.
- **Repro:**
  1. `atlas index express`, then append a function to `lib/application.js`.
  2. `node mcpkill.mjs express atlas_index '{}' SIGKILL` (an SDK client calls `atlas_index`, then
     `kill -9`s the server).
  3. `cp -a express copy`.
  4. `atlas search auditThirtyThreeMarker --cwd copy --limit 1` prints
     `0.010 function getMajorVersion (test/support/utils.js:75)`, exit 0. On `express` itself it prints
     `0.023 function auditThirtyThreeMarker (lib/application.js:633)`.
- **Fix:** do not infer "replaced" from ctime alone.
  - Better, record the identity of the file the WAL belongs to: for example, Atlas writes `index.db`'s inode, or a
    random id kept in the database (`PRAGMA application_id`/`user_version` or a row), into a sidecar or the WAL's
    first commit, and compares it.
  - Or drop only when the WAL's frames cannot belong to the file: page 1 in the WAL whose schema cookie or change
    counter is older than the file's.
  - At minimum, never unlink: rename the WAL aside (`index.db-wal.foreign-<ts>`) and say so on stderr, so a wrong
    guess can be undone.

### A33-02 Two openers racing on a replaced index: one replays the foreign WAL, answers from the mix, and makes the index permanently corrupt

- **Evidence:**
  - **Why.** `fileInUse` cannot tell another opener's probe (an exclusive lock held for a moment) from a live
    holder. When two processes run SG120's check at the same time:
    1. One probe fails, and that process returns early: no drop and no integrity check.
    2. It waits out the lock in `new Database`/`switchToWal`.
    3. SQLite replays the foreign WAL into its view.
    4. Meanwhile the other process's recheck passes (replay does not write the WAL) and unlinks the WAL under it.

    A read-write opener's close then checkpoints the mixed pages into `index.db`. The same skip happens when the
    other process is inside `checkIntegrity` (a shared lock).
  - **Real processes.** `openDatabase` from the built `dist` ran at one instant on a fresh copy of the A31-01
    state (sample, killed writer, another checkout's index copied over). The control and the race:

    | Openers | Trials | Trials where openers answered from the mix (`replacementOnlyFn` and 24 `STALE-WAL-` rows) with success | Final `index.db` corrupt (`wrong # of entries in index idx_symbols_qualified`) | Opens that got the named `SQLITE_CORRUPT` |
    | --- | --- | --- | --- | --- |
    | 1 writer (control) | 30 | 0 | 0 | 0 |
    | 2 writers | 60 | 11 | 11 | 1 |
    | 1 writer + 1 read-only | 60 | 16 | 16 | 1 |
    | 3 writers + 1 read-only | 40 | 7 | 7 | 4 |

    In those 34 trials, every opener but 6 returned success from the mix, and in all 34 the index was left corrupt.
    Every later `atlas index` fails until `rm .atlas/index.db*`.
  - **How likely.** Simultaneous opens are common: an editor starting `atlas mcp` per window, `atlas serve` beside a
    CLI command, a shell loop or a CI matrix. It needs a replaced index beside a stale WAL, the A31-01 setup SG120
    exists to handle.
- **Test:** `A33-02 an opener whose probe meets another opener's probe does not replay the foreign WAL`.
  - Deterministic: a second process holds exactly `fileInUse`'s probe (an exclusive-mode open of a hard link) while
    the CLI starts.
  - It fails with `expected '0.016 function add (src/math.ts:4)…' to match /replacementOnlyFn/`.
- **Repro:** `race.sh 60 2 0` (scratchpad, `scripts/race.sh`). For each trial it:
  1. copies an indexed sample;
  2. runs the killed writer and copies the other checkout's index over;
  3. starts 2 `opener.mjs` at the same millisecond.

  11/60 trials print `{"repl":1,"stale":24}` for both openers and
  `FINAL wrong # of entries in index idx_symbols_qualified`.
- **Fix:** serialise the check across processes and keep the decision until SQLite has opened. For example:
  - Take an exclusive lock that every opener takes first (the `index.db.lock` file Atlas already has, or a
    dedicated `index.db.open-lock`). Probe, drop or verify, and open under it.
  - Treat a failed probe as "retry the check", not "skip it": loop until either a real connection holds the file
    (it is in WAL mode with a non-zero read mark in the `-shm`) or the check completes.

## Medium

### A33-03 The foreign-WAL check gives up silently, and SQLite replays the WAL: symlinked `index.db`, missing `-shm`, no `link()`

- **Evidence:** `dropForeignWal` is "best effort: on any error it is left to SQLite". It also looks for the WAL
  beside the path, while SQLite resolves symlinks. In each case below, A31-01 is back unchanged: wrong answers
  with exit 0, then a permanently malformed index.
  1. **Symlinked `index.db`** (the index on another disk): `.atlas/index.db → /store/real.db`. The WAL is
     `/store/real.db-wal`. Atlas stats `.atlas/index.db-wal`, finds none and returns.
     - `atlas search replacementOnlyFn` exits 0 with `add`. Its close checkpoints the mix into `real.db`.
     - `atlas index` then fails with the corrupt message. That message names `.atlas/index.db-wal`, which does
       not exist, so following it (`rm .atlas/index.db*`) deletes the symlink and orphans `real.db*`.
     - This happens whether or not the WAL's checkpoint had started.
  2. **`-shm` missing** (not copied, deleted as junk, or excluded by a backup or sync tool). `readHead` throws
     `ENOENT`, and the catch returns `false`: no drop and no integrity check. Search exits 0 with `add` (both WAL
     states), and the next `atlas index` fails as corrupt. With an *empty* `-shm`, the same replacement is refused
     with the named message (pinned). The two cases are inconsistent.
  3. **`link()` fails** (a read-only checkout or mount, filesystems without hard links: FAT/exFAT, some FUSE/SMB
     shares). On a `mount --bind -o ro` copy, `openProjectIndex(root, { readonly: true })` (what `atlas serve`
     runs) answered `{"repl":1,"stale":24}`: the replacement's symbol and the foreign WAL's docstrings, with no
     error.
  - The README says: "When it cannot tell, … every surface fails with one message".
- **Tests:**
  - `A33-03 a symlinked index.db …` and `A33-03 … with no -shm …` both fail with
    `expected '0.016 function add (src/math.ts:4)…' to match /replacementOnlyFn/`.
  - A plain `it` pins the empty-`-shm` refusal.
- **Repro (symlink):**
  1. `atlas index A` and `atlas index B` (B has `replacementOnlyFn`).
  2. `mv A/.atlas/index.db store/real.db && ln -s $PWD/store/real.db A/.atlas/index.db`.
  3. Run the killed writer on `A/.atlas/index.db`.
  4. `cp B/.atlas/index.db A/.atlas/index.db`.
  5. `atlas search replacementOnlyFn --cwd A` prints `0.016 function add (src/math.ts:4)`, exit 0.
- **Repro (no -shm):** the same without the symlink, plus `rm A/.atlas/index.db-shm` before the `cp`.
- **Fix:**
  - `realpathSync` the index path before every check, so the WAL Atlas checks is the one SQLite opens (the AUDIT-29
    note).
  - When a WAL is present and any step cannot decide (no `-shm`, `link` fails, unreadable), fail closed: run
    `checkIntegrity` (it is read-only), or refuse with the named message. Do not return `false`.

## Low

### A33-04 A replacement within one timestamp tick of the WAL's last write is not detected

- **Evidence:**
  - **Why.** The check needs `ctime(index.db) > mtime(-wal)`. On filesystems with 1 s (ext4 with 128-byte inodes,
    HFS+, many NFS/SMB setups) or 2 s (FAT) timestamps, a replacement made in the same second as the WAL's last
    write has an equal ctime and is ignored. The same happens when the WAL was written by a host whose clock is
    ahead.
  - **1 s ext4 loop mount, sample.** Killed writer, then `cp B/.atlas/index.db W/.atlas/index.db` at once.
    10/10 runs: `dbCtimeAfterWalMtime: false`, and `atlas search replacementOnlyFn` exits 0 with `add`. The next
    `atlas index` fails as corrupt.
  - **Default ext4 here.** Timestamps are coarse (one tick is a few ms). A rename made right after an in-process
    `atlas_index` was ignored in one of my first A33-05 runs: the CLI read the old index, the A31-03 symptom.
  - A kill-then-restore script hits this.
- **Test:** `A33-04 … ctime does not exceed the WAL's mtime …`. It emulates the coarse tick by setting the WAL's
  mtime 1 s after `index.db`'s ctime. It fails with `expected '0.016 function add (src/math.ts:4)…' to match
  /replacementOnlyFn/`.
- **Fix:** same as A33-01. A file-identity check does not depend on timestamps.

### A33-05 SG120 unlinks the WAL of a live `atlas mcp` whose index is renamed over; the CLI then fails with a bare `disk I/O error`

- **Evidence:**
  - **Setup.** `atlas mcp` holds A and has just run a small `atlas_index` (WAL never checkpointed, 554 frames).
    Then `mv B/.atlas/index.db A/.atlas/index.db`.
  - **What SG120 does.** The probe tests the *new* inode, which nobody holds, and the `-shm` says "never
    checkpointed", so `atlas search` unlinks the live server's WAL. Afterwards the server holds an fd on
    `index.db-wal (deleted)` (from `/proc/<pid>/fd`). SQLite then reads the server's `-shm` against a new empty WAL,
    and the result is `atlas: disk I/O error`, exit 1. That happens on every CLI command until the server exits.
  - **The server.** It keeps answering from, and writing to, the old index (`holderSecondFn` indexed and found via
    MCP, never visible to the CLI).
  - **Pre-SG120.** The CLI answered from the old index with exit 0 and checkpointed it over B (A31-03).
  - DECISIONS (SG120) says "a live WAL is never deleted, because a live holder fails the probe". That is false
    when the path's inode changed under the holder.
  - After the server exits, `atlas index` works and the result is B plus a re-index, which is what the user asked
    for.
- **Test:** `A33-05 the WAL of a live holder is never unlinked, and the CLI never fails with a bare disk I/O error`
  fails with `expected 'atlas: disk I/O error' not to be 'atlas: disk I/O error'`.
- **Fix:**
  - Before unlinking, also probe the `-shm`'s DMS lock: a live connection on any inode holds a shared lock on byte
    128 of `index.db-shm`.
  - Map `SQLITE_IOERR_SHORT_READ` at open to "another Atlas process (`atlas serve`/`atlas mcp`) still has a
    replaced or deleted index open; stop it". This shares A29-01's fix.

## Notes (no test)

- **A byte-identical backup beside a WAL whose checkpoint started.** The WAL is replayed and passes the integrity
  check. Restoring a backup taken just before a crash therefore brings the crash's commits back (express, flask,
  got: 111/164/155 rows). This is consistent, since the WAL applies to an identical base. A backup with any edits
  was refused 3/3. `integrity_check` is structural only. It does not compare FTS or `vec0` contents with
  `symbols`, so a structurally valid mix is not caught by design.
- **Atlas's own probe bumps the index's ctime.** `linkSync`/`rmSync` change the link count, which can matter in a
  narrow interleaving:
  1. an opener stats (ctime newer, after a holder's completed checkpoint);
  2. the holder restarts its WAL with a commit;
  3. the opener links.

  The holder's new WAL is now older than the file's ctime. If the holder is then SIGKILLed before writing again,
  the next opener drops that commit. I did not reproduce it: the window is the few µs between `statSync` and
  `linkSync`. A33-01's fix removes it.
- **SIGHUP is not handled.** Closing the terminal or an SSH session that runs `atlas index` leaves a 4.2–4.6 MB
  `-wal` (9/9). In place this is harmless (replayed). It is the input that A33-01 and A33-04 need, and the README
  says only "Ctrl-C or SIGTERM".
- **A killed probe leaves a link.** A SIGKILL between `linkSync` and `rmSync` leaves `index.db.<pid>.<ms>.probe`, a
  second hard link to the index. This is like `createWalFile`'s leftover tmp file (AUDIT-25/29).
- **`touch`/`chmod` beside a killed writer** drops its last commits, as DECISIONS documents (`chown -R` in dev
  containers is the common case). The same holds beside a *live* writer that is SIGKILLed later. A33-01 is the same
  mechanism reached by ordinary copies and moves.
- **Background jobs.** `atlas index &` in a non-interactive shell exits 130 on `kill -INT` both before and after
  SG120, so there is no exit-status change.
- **Still open.** I ran the audit-21, audit-25, audit-29 and audit-31 files with `it.fails` → `it`: all 10 of these
  tests still fail with their recorded messages.
  - A21-01 (2), A21-02, A25-02, A25-03, A29-01 (2), A29-02 and A31-04: unchanged.
  - A31-03: unchanged for its test, where the server's WAL had been checkpointed, so it is kept and passes the
    integrity check, and the CLI reads `Counter.increment`. When the server's WAL was never checkpointed it becomes
    A33-05.
