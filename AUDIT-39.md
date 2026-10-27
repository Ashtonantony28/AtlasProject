# AUDIT-39: soundness (round 12, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `8bd4405` (SG150 #80 and AUDIT-37 merged) on
`claude/atlas-audit-39`. Date: 2026-10-27.

Question: can Atlas silently lose committed index data, answer wrongly with success, or corrupt its index? Scope:
SG150 in `src/core/db/database.ts`:
- `integrityOk` sets a WAL aside only when two checks fail with the same result, every byte of the index and its
  WAL reads back (`readAll`), and no error other than corruption appears;
- the set-aside file is named `<db>-wal.foreign-<ms>-<size>-<mtimeNs>` (`fileState`);
- `reportAside` offers the move-back only while the index's size and mtime still match and it has no `-wal` with
  frames.

Also re-checked: A37-01, A37-02, A36-03, A34-03, A34-04, A29-01, A29-02, A31-04, A25-02, A25-03, A21-01 and A21-02.

Method:
- **Real processes and real repos.** I built the CLI from this tree into the scratchpad (`audit-39/dist`) and built
  the pre-SG150 tree (`aaefa5f`) beside it (`audit-39/sg140src/dist`) for the upgrade path. I used copies of
  express, flask and got from the scratchpad clones, the sample fixture, and AUDIT-36's bank of 18 killed-writer
  WALs (mcp, docs ×2, force; 7 projects) and 18 replacement indexes. A "killed writer" commits an `UPDATE` plus
  one doc per file and SIGKILLs itself (`kw.cjs`).
- **Foreign WALs (A33-01/A34-03 regressions).** `cross.sh` puts each bank WAL with its `-shm` beside each
  replacement index and beside its own index, and runs `openDatabase` from the built tree (`open.mjs`). I ran all
  342 pairs three times on fresh copies.
- **Transient errors.** An `LD_PRELOAD` shim (`eio/win.c`) fails a window of `pread` calls with `EIO`, or returns
  half the bytes. It hit either the check's hard link (`.check`) or its WAL link (`.check-wal`), from read 0 to 800,
  for 1, 3 or all later reads. That is 312 runs, on an own WAL and on a foreign WAL. The real kernel `EIO` repro
  (`eio-loop.sh`, AUDIT-36) shrinks the loop device under a mounted ext4.
- **Corruption that is not an I/O error.** One byte of rot in a b-tree page the killed writer does not touch
  (`latent.sh rot`), and an `index.db` truncated to half (`latent.sh trunc`), on the sample, express, flask and got.
- **The move-back guard.** A loop-mounted ext4 made with `-I 128` has 1 s timestamps (`stat` shows
  `.000000000`). `coarse.sh` puts a `cp` and an `atlas index` in the same second. `coarse-own2.sh` sets a killed
  writer's own WAL aside, then runs `atlas index` after an edit in the same second. Each script then follows the
  reminder. `upgrade.sh` has SG140 set a WAL aside (A36-01's `EIO`), then runs SG150.
- **Regressions.** I ran the audit-21, -25, -29, -31, -34, -36 and -37 files as they are (73/73 pass, 2m09s), then
  with every `it.fails` turned into `it`.

I unmounted every mount, detached the loop devices, and killed every process I started.

The harness scripts are in the session scratchpad under `audit-39/scripts/`:
- `open.mjs`, `cross.sh`, `kw.cjs`, `q.cjs`, `steps.cjs`;
- `win.sh`, `eio-loop.sh`;
- `latent.sh`, `coarse.sh`, `coarse-own.sh`, `coarse-own2.sh`, `upgrade.sh`;
- the shim is `audit-39/eio/win.c`.

Every finding also has an in-repo test.

Repros are in `test/audit/audit-39.test.ts`. Each `it.fails` asserts the correct behaviour. I ran the file 3 times
with each `it.fails` as a plain `it`: each failed every time, on the assertion that names its defect (messages
below). The tests are deterministic and need no privileges:
- one byte written into an index page stands in for a bad page on a disk that returns wrong data;
- `utimesSync` to a whole second stands in for a filesystem with 1 s timestamps;
- a window `pread` shim, built with `cc` in the test, stands in for a transient `EIO` (skipped without `cc`).

Plain `it` blocks pin what was attacked and held.

**Summary: 0 critical, 0 high, 1 medium, 2 low.**
- What holds:
  - A36-01 is fixed. On the real loop device shrunk to 1000, 1100 or 1200 blocks, `atlas search` is refused with
    `cannot check … (EIO: i/o error, read); it is kept`, exit 1, and nothing is set aside. Once the device is
    back, 24/24 rows return and the integrity check gives `ok`.
  - No transient error sets an own WAL aside, and none keeps a foreign one. In 312 shim runs:
    - own WALs: kept with all 24 rows and 4 docs, or refused with the cause;
    - foreign WALs: set aside, or refused with the cause (the next clean run sets them aside);
    - an error in only one of the two checks is never taken for corruption.
  - No regression of A33-01/A34-03. In the 342-pair matrix, each of the three runs gave:
    - 291 set aside and 51 kept (18 own; 33 foreign, which is A34-03);
    - 0 refused as "cannot check" and 0 refused as malformed;
    - identical results line for line.

    No corrupt foreign WAL is kept and refused forever, and none flips between runs.
  - The name is matched on the file name only (`<basename>-wal.foreign-` prefix, `-<size>-<mtimeNs>` suffix). Dashes
    or digits in the directory, or in a symlinked index's target name, do not matter. Each field is bounded by `-`,
    so one state cannot match another state's suffix.
- The medium (**A39-01**): the "two identical failures, every byte readable" rule cannot tell a foreign WAL from a
  bad page in `index.db` itself. A killed writer's own WAL beside an index with one rotted page is renamed aside as
  "does not belong". The index then answers with exit 0 without the writer's rows and docs. On the sample,
  express, flask and got, `atlas drift` then says `no docs found in the index`.
- The lows:
  - **A39-02**: the move-back guard is the index's size and mtime. Atlas index files keep their size on a write,
    and a 1 s filesystem keeps the mtime for a write in the same second. On a real ext4 with 128-byte inodes, the
    reminder still says "move it back" after `atlas index` has written. Following it gives A36-02's result.
  - **A39-03**: a WAL set aside before SG150 (`foreign-<ms>`, no state) is always called unsafe to move back. That
    includes A36-01's victims: a killed writer's own WAL that SG140 set aside on an `EIO`. Moving those back
    restores every row (sample 24/4, express 778/141, got 1090/96). The new message says to delete them.
- Still open: A37-01, A37-02, A36-03, A34-03, A34-04, A29-01 (2), A29-02, A31-03, A31-04, A25-02, A25-03, A21-01 (2)
  and A21-02. Their `it.fails` still fail when run as plain `it`.

No new PLAN rows (no critical or high finding).

## Re-verified (changes since AUDIT-36)

| Change | Attack | Result |
| --- | --- | --- |
| SG150: two checks, `readAll`, corruption codes only | A36-01's real repro: `eio-loop.sh` 1000, 1100, 1200 (ext4 loop device shrunk, `drop_caches`) | Refused, `cannot check … (EIO: i/o error, read); it is kept`, exit 1, 0 set aside. Device restored: exit 0, 24/24 rows, integrity `ok`. A36-01 fixed (its test is a plain `it`). |
| SG150: the same | `win.sh`: `EIO` or half reads on the check's link, reads 0–800, windows of 1, 3 or all; own and foreign WAL (204 runs) | Own: 64 kept (24/24 rows, 4 docs), 38 refused with the cause, 0 set aside. Foreign: 38 set aside, 64 refused, 0 kept. Pinned (one window each way). |
| SG150: the same | the same window shim on the check's WAL link (`.check-wal`, reads 0–20; 108 runs) | Own: 23 kept, 31 refused, 0 set aside. Foreign: 18 set aside, 36 refused, 0 kept. |
| SG150: same result twice | `cross.sh` ×3: 18 bank WALs with their `-shm` × (18 replacement indexes + own), through `openDatabase` | 291 set aside, 51 kept (18 own, 33 foreign: A34-03), 0 "cannot check", 0 malformed; the three runs identical. |
| SG150: same result twice | one byte of rot in `idx_edges_kind`, killed writer, `atlas search` (sample, express, flask, got) | **Own WAL set aside, exit 0, rows and docs gone (A39-01).** |
| SG150: `readAll` | `index.db` truncated to half after the kill (an interrupted copy) | Own WAL set aside ("does not belong"), then the open is refused as malformed with the remedy that deletes the index (A39-01's class; fails closed for answers). |
| SG150: size and mtime in the name | ext4 `-I 128` (1 s timestamps): `cp` + `atlas index` in one second (`coarse.sh`); own WAL set aside + edit + `atlas index` in one second (`coarse-own2.sh`) | **Reminder still says "move it back" after the write (A39-02).** Followed (sample): exit 1, `unreadable (database disk image is malformed) … delete …`; the file is a mix (`row 1 missing from index idx_symbols_qualified`). Runs that crossed a second boundary: "delete it". |
| SG150: reminder after a write | ext4/tmpfs with ns timestamps: set aside, `atlas index` | "may have been written since … delete it" (pinned in AUDIT-36's SG150 test). |
| SG150: names from before SG150 | `upgrade.sh`: SG140 + `EIO` (A36-01) sets an own WAL aside, then SG150 `atlas search` (sample, express, got) | **"moving it back would corrupt the index; delete it" (A39-03).** Moved back anyway: exit 0, all rows and docs, integrity `ok`. |
| SG150: name parsing | `endsWith('-<size>-<mtimeNs>')` on the file name only | Holds: a different size cannot match (each field is bounded by `-`); a legacy name or an empty state never matches. |
| A33–A37 pins | audit-21/25/29/31/34/36/37 files as they are | 73/73 pass (2m09s). |

## Critical

None found.

## High

None found.

## Medium

### A39-01 A bad page in index.db itself is taken as proof that its own WAL is foreign: the killed writer's WAL is renamed aside and the index answers without its rows and docs, exit 0

- **Evidence:**
  - **Why.** SG150 treats "two checks fail the same way and every byte reads back" as proof that the WAL does not
    belong. A bad page in `index.db` gives the same signature. Examples: a bit flip, a sector remapped with zeros,
    a sync client or FUSE drive that served wrong bytes, or an earlier partial mix (A37-02's checkpoint over a
    replacement). Plain reads succeed, and `PRAGMA integrity_check` reports the page the same way twice, with or
    without the WAL. `decideWal` then sees a killed writer's `-shm` that says never checkpointed. `setAside`
    renames the index's own WAL to `…-wal.foreign-<ms>-<size>-<mtime>` and prints `… does not belong to …`. The
    open goes on from the last checkpoint. `integrityOk` never checks `index.db` without the WAL, which is the one
    check that would tell the two cases apart.
  - **Real runs (`latent.sh <repo> rot`).** The steps:
    1. `atlas index`.
    2. The killed writer commits an `UPDATE` of every symbol and one doc per file.
    3. One byte at the start of `idx_edges_kind`'s last page is set to `0x01`. `integrity_check` then gives
       `Tree 16 page N: btreeInitPage() returns error code 11`.

    | Repo | `atlas search` | WAL rows after | `atlas index` | `atlas drift` | Moving it back |
    | --- | --- | --- | --- | --- | --- |
    | sample | exit 0, `0.023 function add`, "does not belong" | 24 → 0 rows, 4 → 0 docs | exit 0 | exit 1, `no docs found in the index` | exit 1, malformed, "delete …index.db" |
    | express | exit 0, `res.vary` | → 0, 0 | exit 0 | the same | the same |
    | flask | exit 0 | → 0, 0 | exit 0 | the same | the same |
    | got | exit 0 | → 0, 0 | exit 0 | the same | the same |

    The page stays bad, and nothing reports it. The user is told the WAL "does not belong", which is false.
  - **Truncated index (`latent.sh <repo> trunc`).** `index.db` is cut to half after the kill, as an interrupted copy
    or a full disk during `cp` leaves it. The own WAL is renamed aside ("does not belong"), then the open is
    refused as malformed with the remedy that deletes the index. Answers fail closed here, but the WAL is still
    moved and mislabelled.
  - **Why it matters.** The result is A36-01's (rows and docs dropped with exit 0, a false stderr line), reached by
    silent corruption instead of an I/O error. With a real model the lost docs cost tokens again. The precondition
    is rarer than an `EIO`, and the index is already damaged. That is why this is medium, not high.
- **Test:** `A39-01 a killed writer’s WAL beside an index.db with one bad page is not renamed aside as foreign, and
  its rows and docs are not dropped with exit 0`. It fails with `expected 'atlas: /tmp/atlas-audit39-…' not to match
  /does not belong to/`.
- **Repro (scratchpad):** `scripts/latent.sh sample rot` (or `express`, `flask`, `got`; `trunc` for the truncated
  index).
- **Fix:**
  - When the check with the WAL fails, run it once more on a hard link of `index.db` alone (no `-wal` link, so
    SQLite sees no WAL). Set the WAL aside only if `index.db` alone passes.
  - If `index.db` alone fails too, refuse with a message that names the index as corrupt (the page, and
    `sqlite3 .recover` or a rebuild), and keep the WAL.

## Low

### A39-02 The move-back is still offered after a write that keeps the index's size and mtime (1 s timestamps), and following it gives A36-02's result

- **Evidence:**
  - **Why.** `reportAside` offers the move-back while `index.db`'s size and mtime match the set-aside name. Atlas
    index files keep their size on a write. The sample stayed at 1,736,704 bytes across `atlas index` with no
    change, `atlas index` after an edit, and `atlas docs`; got and express behave the same. So mtime is the only
    guard. On a filesystem with 1 s timestamps, a write in the same second as the last write before the set-aside
    keeps it. Examples: ext4 with 128-byte inodes (`mkfs.ext4 -I 128`, or small filesystems made by older
    e2fsprogs), ext3, HFS+, NFS servers that store seconds. The guard also fails when a tool restores the mtime
    (`touch -r`, a backup restore).
  - **Real runs (loop-mounted ext4 `-I 128`, `stat` shows `.000000000`):**
    - `coarse.sh`: `cp B/.atlas/index.db A/.atlas/index.db; atlas index A` in one second. `atlas index` sets the WAL
      aside and writes (exit 0). The next `atlas search` prints `… was set aside …; if its writes belong there, move
      it back to …index.db-wal before anything writes the index`.
    - `coarse-own2.sh sample`: a killed writer's own WAL is set aside (named as `setAside` names it), then `atlas
      index` after an edit (exit 0, same second). The next open says "move it back". Followed: exit 1,
      `index … is unreadable (database disk image is malformed) … delete …index.db with its -wal and -shm`.
      `index.db` with that WAL is a mix: `row 1 missing from index idx_symbols_qualified`. Two later runs crossed
      a second boundary and got "delete it".
  - In A36-02, the same move-back after a write left got with a mix that passed the integrity check. That is an
    index answering from a mix with exit 0.
- **Test:** `A39-02 on a filesystem with 1 s timestamps, a write in the same second as the set-aside makes the
  reminder stop offering the move-back`. It sets the index's mtime to a whole second before the set-aside and after
  `atlas index`. It fails with `expected 'atlas: /tmp/atlas-audit39-…' not to match /move it back/`.
- **Repro:** `scripts/coarse.sh <dir on ext4 -I 128>` and `scripts/coarse-own2.sh <dir> sample` (root: `mkfs.ext4
  -I 128`, loop mount).
- **Fix:**
  - Treat a recorded mtime with zero nanoseconds as unknown, and never offer the move-back then.
  - Better: record something every write changes. Or refuse writers while a set-aside file still offers the
    move-back (the first fix A36-02 suggested), so the offer is never overtaken.

### A39-03 A WAL set aside before SG150 is always called unsafe to move back, including A36-01's victims whose WAL is the index's own

- **Evidence:**
  - **Why.** SG130/SG140 named set-aside files `<db>-wal.foreign-<ms>`. That name has no `-<size>-<mtime>`
    suffix, so `reportAside` never matches it, and it always prints `… which may have been written since: moving it
    back would corrupt the index; delete it`. That is true even when nothing has written the index since. The users
    who have such a file are those SG150 was fixing: SG140 set their killed writer's own WAL aside on an I/O error
    (A36-01).
  - **Real runs (`upgrade.sh`).** The SG140 CLI (`aaefa5f`) runs with an `EIO` on the check's 21st read. It sets the
    own WAL aside, exit 0. Then the SG150 CLI runs `atlas search`:

    | Repo | SG150 says | Moved back anyway |
    | --- | --- | --- |
    | sample | "moving it back would corrupt the index; delete it" | exit 0, 24/24 rows, 4 docs, integrity `ok` |
    | express | the same | 778 rows, 141 docs, `ok` |
    | got | the same | 1090 rows, 96 docs, `ok` |

    Following the new advice deletes the only copy of those rows and docs.
- **Test:** `A39-03 a killed writer’s own WAL that SG140 set aside (A36-01) is not called unsafe to move back while
  nothing has written the index`. It fails with `expected 'atlas: /tmp/atlas-audit39-…' not to match /moving it back
  would corrupt the index/`. A plain `it` pins that moving such a file back restores 24/24 rows and 4 docs.
- **Repro:** `scripts/upgrade.sh sample` (or `express`, `got`).
- **Fix:** for a name without a state, say that Atlas cannot tell whether the index has been written since. Give
  the test that decides: move it back, and if the next command refuses it as malformed, move it aside again and
  delete it. Do not tell the user to delete it outright.

## Notes (no test)

- **A37-01 now.**
  - The move-back with no write in between is still refused (`unreadable (database disk image is malformed) …
    delete …`, exit 1; sample).
  - `atlas index` still prints "move it back … before anything writes the index" and then writes (exit 0). Since
    SG150, the next open says "delete it" instead.
  - MCP tool results and the HTTP API still never mention the set-aside.
  - The `it.fails` still fails on its first assertion (`expected +0 not to be +0`).
- **A37-02 now.** Unchanged: the replaced-index refusal still gives the foreign-WAL remedy. The `it.fails` fails
  with `… not to match /delete .* with its -wal and -shm/`.
- **For an own WAL that SG150 sets aside (A39-01), the move-back is refused anyway.** The opener that set it aside
  deletes the `-shm` when it closes. The moved-back WAL then has no `-shm`, so `neverCheckpointed` is false, and
  the index's own bad page fails the check: it is refused as malformed. So the reminder's offer can only be
  followed when the check passes, which is the A36-01/A39-03 case.
- **`readAll`.** It reads to the size `fstat` gave when it opened the file. A file that grows meanwhile is read to
  that size. A file that shrinks gives `short read of … at byte …`, which is refused (fail closed). Holes in a
  sparse file read as zeros, as SQLite sees them. It runs only after a failed first check, so it never runs for an
  own WAL that fits. For a foreign WAL it adds one full read and one more `integrity_check` under the open lock
  (AUDIT-35's cost, roughly doubled). That is performance, not soundness, and I did not measure it at scale.
- **Messages.**
  - For an `EIO`, the "cannot check" refusal still says "free disk space (or fix the cause)".
  - When a foreign WAL's two checks differ because of a transient error, the cause reads `a page could not be
    read: <first result>`, even when the first result was ordinary corruption (`wrong # of entries in index …`).
  - Both refuse and keep the WAL, and the next clean run decides.
- **No hard links.** Unchanged from AUDIT-36: the check runs on the path itself, its recovery marks the real
  `-shm`, and a foreign WAL is refused as malformed instead of set aside.
- **Still open.** I ran the audit-21, -25, -29, -31, -34, -36 and -37 files with `it.fails` → `it`. These still
  fail with their recorded messages:
  - A21-01 (2), A21-02, A25-02 and A25-03;
  - A29-01 (2): `expected 'disk I/O error' to match /atlas (serve|mcp)|another process/`;
  - A29-02: `expected 1 to be +0`;
  - A31-03: refused with `another process still has the replaced index open`, as in AUDIT-37;
  - A31-04: `expected 'no such table: files' not to match /no such table/`;
  - A34-03: `expected 'DOC-FOR-src/math.ts\n' not to match …` (33 foreign pairs still kept in the matrix);
  - A34-04 and A36-03: `… not to match /^atlas: disk I\/O error$/m`;
  - A37-01..A37-05: as in AUDIT-37 (A37-03 still waits about 64 s).
