# AUDIT-36: soundness (round 11, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `aaefa5f` (SG140 merged) on
`claude/atlas-audit-36`. Date: 2026-10-27.

Question: can Atlas silently lose committed index data, answer wrongly with success, or corrupt its index? Scope:
SG140 in `src/core/db/database.ts`:
- `integrityOk` fails closed: only `SQLITE_CORRUPT*`/`SQLITE_NOTADB` or a result other than `ok` counts as "does not
  fit"; any other error is rethrown as "cannot check …; it is kept";
- `holders` matches `/proc/locks` on `major:minor:inode`, decoding `st_dev` with glibc's encoding, and gives up
  ("unsure", so the probe decides) when a lock is on the same inode number on another device;
- `reportAside` prints a reminder for each `<db>-wal.foreign-*` on every open.

Also re-checked: A34-03, A34-04, A29-01, A29-02, A31-03, A31-04, A25-02, A25-03, A21-01 and A21-02.

Method:
- **Real processes and real repos.** I built the CLI from this tree into the scratchpad (`audit-36/dist`) and used
  copies of express, flask, got, attrs, t3 and trpc from the scratchpad clones, plus the sample fixture. A "killed
  writer" is one of:
  - `atlas mcp` (built, over stdio with the SDK client) that ran `atlas_index` after an edit and was SIGKILLed;
  - `atlas docs --offline -v` SIGKILLed after 10, 20, 40 or 60 modules;
  - `atlas index --force` SIGKILLed after 1.5 s or 3 s;
  - a process that commits an `UPDATE`/`INSERT` and SIGKILLs itself, as in AUDIT-31/33/34.
- **Error classification.** I looked for both directions of a wrong verdict:
  - a foreign WAL whose check throws something other than corruption (it would be kept in place and the index
    refused forever with "free disk space and retry"). `bank.sh` made 18 killed-writer WALs (7 projects) and 18
    replacement indexes (fresh, K = 2 files edited, one file added so ids shift, the sample, an `atlas init` index with no
    rows). `cross.sh` ran `integrityOk`'s exact steps (`cls.cjs`) on all 324 foreign pairs and on each WAL's own index (342 checks);
  - a real I/O error read as corruption. An `LD_PRELOAD` shim (`eio/eio.c`) fails `pread` with `EIO` (or returns a
    short read) on the check's hard link after N reads. The real repro (`eio-loop.sh`) shrinks the loop device of a
    mounted ext4 under the index, so reads past it fail with the kernel's `EIO`;
  - a full 40 MB tmpfs (A34-01's repro) and a tmpfs with its inodes exhausted (no hard links possible).
- **Liveness.** I checked `holders`' device decoding and the "unsure" rule:
  - 300 tmpfs mounts, so anonymous minor numbers go past 255 (`0:341`), with a live holder on the last;
  - an overlayfs mount (upper on this host's ext4);
  - two loop-mounted copies of one ext4 image (A34-02's repro);
  - an unrelated process locking a file on another tmpfs that has the same inode number as the index
    (`xinode.sh`).
- **The reminder.** `moveback.sh` sets a killed writer's own WAL aside (the `EIO` shim), runs nothing, `atlas
  search`, `atlas index` or `atlas index` after an edit, then does what the reminder says (moves the file back),
  then reads.
- **Regressions.** I ran the audit-21, -25, -29, -31, -33 and -34 files as they are (71/71 pass), then with every
  `it.fails` turned into `it`.

The harness scripts are in the session scratchpad under `audit-36/scripts/`:
- `bank.sh`, `cross.sh`, `cls.cjs`;
- `eio-loop.sh`, `moveback.sh`, `xinode.sh`;
- `kw.cjs`, `whold.cjs`, `holder.cjs`, `mcpkill.mjs`, `killafter.mjs`, `fts.cjs` (from AUDIT-34, pointed at this
  tree);
- the shim is `audit-36/eio/eio.c`.

Every finding also has an in-repo test.

Repros are in `test/audit/audit-36.test.ts`. Each `it.fails` asserts the correct behaviour. I ran the file 5 times
with each `it.fails` as a plain `it`: each failed every time, on the assertion that names its defect (messages
below). The tests are deterministic and need no privileges:
- an `LD_PRELOAD` shim, built with `cc` in the test, stands in for a disk that returns `EIO` (the tests that need
  it are skipped where there is no `cc`);
- a `--require` preload appends a line to what `readFileSync('/proc/locks')` returns: an unrelated lock on another
  device.

The real repros (a shrunk loop device, 300 tmpfs mounts, loop-mounted images) are below. Plain `it` blocks pin
what was attacked and held.

**Summary: 0 critical, 1 high, 1 medium, 1 low.**
- What holds:
  - A34-01 is fixed. On a full 40 MB tmpfs, a SIGKILLed `atlas docs` (60 modules) on express, flask and got is
    refused with `cannot check … (SQLITE_IOERR_SHMSIZE: disk I/O error); it is kept: free disk space …`, exit 1, and
    nothing is set aside. Once space is back, `docs --list` shows 60/60 on all three.
  - A34-02 is fixed. With two loop-mounted copies of one ext4 image and a holder on the second, a foreign WAL on
    the first is set aside and the replacement is answered (`replacementOnlyFn`, integrity `ok`).
  - No corrupt foreign WAL is reported as a check that could not run: 342/342 mixes give `ok`, a result row, or
    `SQLITE_CORRUPT` (16). An `EIO` on the check's first read, or on the WAL, is refused with the cause.
  - `st_dev` decoding matches `/proc/locks` for minors `0xbf` and `0x155`, and on overlayfs (`0:42` = `00:2a`).
    Majors are 12 bits in the kernel, so the high-bits branch of the decoding is never used.
- The high (**A36-01**): an I/O error after the check has started is read as corruption. `PRAGMA integrity_check`
  reports a page it cannot read as a result row (`unable to get the page. error code=8458`, i.e.
  `SQLITE_IOERR_CORRUPTFS`, or `failed to get page N`), and an `EIO` while the schema loads is thrown as
  `SQLITE_CORRUPT`. A killed writer's own WAL is then renamed aside as foreign, and the index answers from the last
  checkpoint with exit 0 (real kernel `EIO`: 24 rows and 4 docs → 0).
- The medium (**A36-02**): the reminder does not stop the write that overtakes it. `atlas index` prints "move it
  back … before anything writes the index" and then writes. The reminder keeps giving that advice afterwards.
  Following it leaves the index refused, with a remedy that deletes it (sample, express, flask; got stayed
  consistent).
- The low (**A36-03**): SG140's "unsure" rule turns the passive check off when any process on any other
  filesystem locks a file with the same inode number. A33-05 is then back in the holder's own namespace: a live
  writer's WAL is renamed aside and the CLI fails with a bare `atlas: disk I/O error`.
- Still open: A34-03, A34-04, A29-01 (2), A29-02, A31-03 (refused with the named message, as in AUDIT-34), A31-04,
  A25-02, A25-03, A21-01 (2) and A21-02. Their `it.fails` still fail when run as plain `it`.

PLAN rows: SG150 (A36-01, with A36-02).

## Re-verified (changes since AUDIT-34)

| Change | Attack | Result |
| --- | --- | --- |
| SG140: rethrow any error that is not corruption | A34-01 on real repos: 40 MB tmpfs, `atlas docs` SIGKILLed after 60 modules, disk filled with `dd`, `docs --list` | express, flask, got: exit 1 `cannot check … (SQLITE_IOERR_SHMSIZE …)`, 0 set aside; after `rm filler`: 60/60/60 docs. Pinned (A34-01 test). |
| SG140: a corrupt foreign WAL is never "cannot check" | `cross.sh`: 18 killed-writer WALs (mcp, docs ×2, force) from 7 projects × 18 replacement indexes, plus each WAL on its own index | 342 checks: 51 `ok` (18 own; 33 foreign, A34-03), 275 result rows, 16 `SQLITE_CORRUPT`, 0 other errors. CLI pinned. |
| SG140: `EIO` | shim on the check's link: `EIO` on read 1, on the `-wal`, after 2, 5, 10, 20, 50–400 reads; short reads | Read 1 and the `-wal`: `cannot check … (SQLITE_IOERR_CORRUPTFS …)`, kept (pinned). A short read of the `-wal`: `SQLITE_IOERR_SHORT_READ`, kept. **After 2 reads or more, or a short read of `index.db`: set aside (A36-01).** |
| SG140: inode exhaustion | tmpfs `nr_inodes=200`, filled with `touch` | Own WAL: no hard link, so the check ran on the path; kept (24 rows), no leftovers. Foreign WAL: refused with the malformed message (the check's recovery on the real `-shm` sets `nBackfillAttempted`, so it is not set aside). Fail closed. |
| SG140: match on device and inode | two loop-mounted ext4 copies, holder on `m2` (`07:01:22/24`), foreign WAL on `m1` | Set aside, `replacementOnlyFn`, integrity `ok`. A34-02 fixed (test pinned in AUDIT-34). |
| SG140: `st_dev` decoding | 300 tmpfs mounts; live holder on `0:191` and `0:341` (`/proc/locks` `00:bf`, `00:155`) | Matched: the check is skipped, and no `.open.lock` is created. overlayfs: `stat` `0:42` = `00:2a`. |
| SG140: "unsure" on a lock on another device | `xinode.sh`: live writer on `t300/P`, B renamed over it, an unrelated `lockf` on `t150/filler*` with the new index's inode number | Without that lock: refused with `another process still has the replaced index open` (pinned). **With it: set aside, `atlas: disk I/O error` (A36-03).** |
| SG140: reminder on every open | `moveback.sh` (own WAL set aside by the shim), then nothing / `search` / `index` / `index` after an edit, then the reminder followed | nothing, `search`, `index` with no change: moving back restores all 24 rows. **`index` after an edit: refused, `database disk image is malformed … delete index.db` (sample, express, flask); got kept 20 docs, consistent (A36-02).** |
| A33/A34 pins | audit-21/25/29/31/33/34 files as they are | 71/71 pass. |

## Critical

None found.

## High

### A36-01 An I/O error during the integrity check is read as corruption: a killed writer's own WAL is renamed aside and the index answers from the last checkpoint with exit 0

- **Evidence:**
  - **Why.** SG140 rethrows only errors that SQLite throws. Two cases slip through.
    - `PRAGMA integrity_check` does not throw when it cannot read a page during its walk. It reports the page as a
      result row:
      - `Tree 37 page 37: unable to get the page. error code=8458` (8458 is `SQLITE_IOERR_CORRUPTFS`, which SQLite
        returns for `EIO`);
      - or `Tree 29 page 29 cell 0: failed to get page 70`.

      `integrityOk` compares the result with `'ok'`, so the check counts as "does not fit".
    - An `EIO` while the schema loads (the second read) is thrown as `SQLITE_CORRUPT database disk image is
      malformed`, which matches `/^SQLITE_(CORRUPT|NOTADB)/`.

    `decideWal` then sees a killed writer's `-shm` that says never checkpointed (the normal tail of every run), and
    `setAside` renames the index's own WAL to `index.db-wal.foreign-<ms>`. It prints `… does not belong to …`, and
    the open goes on with the last checkpoint.
  - **Shim matrix (`cls.cjs` steps, sample).** The `EIO` comes after N successful reads of the check's link:

    | N | Result |
    | --- | --- |
    | 0, 1 | `SQLITE_IOERR_CORRUPTFS` thrown: refused, kept (pinned) |
    | 2 | `SQLITE_CORRUPT` thrown: set aside |
    | 5, 10 | row `unable to get the page. error code=8458`: set aside |
    | 50–400 | row `failed to get page N`: set aside |
    | short read of `index.db` | zero-filled page, rows: set aside |

    Only the first one or two reads of a check are refused as SG140 intends. The check reads the whole file (157 MB
    in AUDIT-34), so it is the read most likely to meet a transient error.
  - **Built CLI, real kernel `EIO` (`eio-loop.sh 1000`).**
    1. The sample with a killed writer's WAL is on an ext4 loop mount. `index.db` is in blocks 804–1227, its WAL in
       297–301.
    2. The backing file is truncated to 1000 blocks and `losetup -c` is run, then `drop_caches`. The kernel then
       fails reads past block 1000 with `EIO` (`attempt to access beyond end of device`).
    3. `atlas search add`: prints `… index.db-wal does not belong to …index.db; moved it to
       …index.db-wal.foreign-1793081040422`. The command then fails with `vectors blob read error for 1`, exit 1,
       because the device is still short.
    4. The device is restored (the cut blocks written back, `losetup -c`). `atlas search add` prints the reminder,
       then `0.023 function add (src/math.ts:4)`, exit 0. The WAL's rows: 0 of 24, integrity `ok`.
    - When the error is transient (the shim fails only the check), the first command itself answers with exit 0
      from the last checkpoint.
  - **Where it happens.** Examples:
    - a disk with a bad sector;
    - an NFS or SMB home directory mounted `soft` (a timeout returns `EIO`);
    - a FUSE drive (sshfs, cloud-sync clients with online-only files) that drops its connection;
    - a USB disk unplugged and replugged.

    A crash often comes with such an error, and the first command after it decides.
  - **Why it matters.** A34-01 had the same result, and SG140's accept criterion names `SQLITE_IOERR*` as "refuse,
    keep the WAL". Here the rows and docs are dropped with exit 0. The stderr line tells the user the WAL "does not
    belong", and the next write makes moving it back fail (A36-02).
- **Test:** `A36-01 an EIO while the check reads index.db keeps a killed writer’s own WAL: its rows and docs are not
  lost`. The shim fails the 21st read. It fails with `expected 'atlas: /tmp/atlas-audit36-…' not to match /does not
  belong to/`. It is skipped without `cc`.
- **Repro (scratchpad):** `scripts/eio-loop.sh 1000` (root: loop mount, `losetup -c`, `drop_caches`). Or:

  ```
  EIO_SUFFIX=.check EIO_AFTER=20 LD_PRELOAD=eio/eio.so atlas search add --cwd P
  ```
- **Fix:**
  - Treat a result row that carries an error code (`unable to get the page. error code=`, `failed to get page`,
    `btreeInitPage() returns error code`) as "cannot check" unless the code is `SQLITE_CORRUPT`.
  - Better: before renaming, run the check a second time, and read the whole file and WAL with plain `read()`. Set
    the WAL aside only if both checks report the same corruption and every read succeeded.
  - Map a thrown `SQLITE_CORRUPT` to "cannot check" when it comes from the schema load and the main file alone (no
    WAL) also fails to read.

## Medium

### A36-02 The set-aside reminder does not stop the write that overtakes it, and keeps recommending the move-back afterwards: following it leaves the index refused with a remedy that deletes it

- **Evidence:**
  - **Why.** SG140's PLAN row says "a WAL that was set aside is reported until the user acts, so the README's
    move-back recovery is not overtaken by the next write". `reportAside` only prints. In the process that prints
    it:
    - `atlas index` goes on and writes;
    - `atlas docs` goes on and writes;
    - `atlas mcp` goes on, and its first `atlas_index` writes. Its stderr is hidden by MCP clients.

    After the write, the reminder still says "if its writes belong there, move it back to …index.db-wal before
    anything writes the index". Nothing records that something has written since. The user cannot tell whether
    the advice is still safe. After A36-01 the set-aside WAL is the index's own, which is exactly when the user
    should follow it.
  - **Real runs (`moveback.sh`, own WAL set aside by the `EIO` shim, then the reminder followed):**

    | Repo, killed writer | Between set-aside and move-back | After the move-back |
    | --- | --- | --- |
    | sample, `UPDATE` | nothing / `atlas search` / `atlas index` with no change | exit 0, 24/24 rows |
    | sample, `UPDATE` | `atlas index` after a one-line edit (exit 0, reminder printed) | `search` and `docs --list` exit 1: `index … is unreadable (database disk image is malformed) … delete …index.db with its -wal and -shm and run \`atlas index\`` |
    | express, `atlas docs` (20) | `atlas index` after an edit | same refusal |
    | flask, `atlas docs` (20) | `atlas index` after an edit | same refusal |
    | got, `atlas docs` (20) | `atlas index` after an edit | exit 0, 20 docs, integrity `ok` (the pages happened not to overlap) |

    The refusal's remedy deletes the index and its docs. With a real model, those tokens are spent again. Moving the
    WAL aside again would have kept the index, but no message says so.
- **Test:** `A36-02 following the reminder after \`atlas index\` has run keeps the set-aside WAL’s rows and docs`. It
  renames the index's own WAL as `setAside` does, edits a file, runs `atlas index`, then follows the reminder
  printed by the next command. It fails with `atlas: index /tmp/atlas-audit36-…/index.db is unreadable (database
  disk image is malformed) …: expected 1 to be +0`. It passes once writers refuse while the file is set aside, or
  once the reminder stops recommending the move-back after a write.
- **Repro:** `scripts/moveback.sh sample kw index-edit` (or `express docs index-edit`).
- **Fix:**
  - While a `-wal.foreign-*` file is there, refuse to write (`atlas index`, `atlas docs`, `atlas_index`, `atlas
    mcp` at startup) with the reminder and an explicit `--discard-foreign-wal`-style way out.
  - Or record the index's checkpoint state (its WAL salt or change counter) in the set-aside file's name. Once the
    index has moved past it, say "cannot be moved back any more; delete it".
  - In the malformed message after a move-back, name moving the `-wal` aside as the first remedy, before deleting
    the index.

## Low

### A36-03 One unrelated lock on the same inode number on any other filesystem turns the passive check off and brings A33-05 back in the holder's own namespace

- **Evidence:**
  - **Why.** SG140's `holders` returns `undefined` ("unsure") when any `/proc/locks` entry has the file's inode
    number on another device, even when the entry for the file's own device is absent. `checkLeftoverWal` and
    `decideWal` then use `probe`. The probe tests only the file (A34-04): it locks a hard link of the *new* inode,
    which nobody holds, so it misses the live `-shm`. The live writer's WAL is then renamed aside, and the open
    fails on the `-shm` it shares with that writer.
  - **Where the numbers collide.** Inode numbers are small and recur on every tmpfs, loop image, container layer
    and snapshot. On a host with many such filesystems (CI runners, dev containers), one other process holding a
    lock on, say, inode 84 is enough. Before SG140 such a lock made the check skip (A34-02); now it disables the
    passive answer.
  - **Real processes (`xinode.sh`, two of 300 tmpfs mounts):**
    1. `whold.cjs` commits on `t300/P` and stays open.
    2. B's index is renamed over `t300/P/.atlas/index.db`. It gets inode 84.
    3. Without another lock: `atlas search` is refused with `index … is unreadable (another process still has the
       replaced index open) …`. The WAL stays (pinned).
    4. With `python3 lockf` on a file on `t150` that also has inode 84 (`/proc/locks`: `00:bf:84`):
       - `atlas: …index.db-wal does not belong to …; moved it to …index.db-wal.foreign-1793081305548`;
       - then `atlas: disk I/O error`, exit 1;
       - the holder's `/proc/<pid>/fd` now points at `index.db-wal.foreign-…`.
- **Test:** `A36-03 with /proc/locks present, a lock on another device does not bring back A33-05 …` adds
  `fd:7f:<new inode>` to the real `/proc/locks` through a preload. It fails with `expected 'atlas: /tmp/atlas-audit36-…'
  not to match /^atlas: disk I\/O error$/m`.
- **Repro:** `scripts/xinode.sh yes` (mounts two tmpfs under `audit-36/mm`; the run above used two of 300).
- **Fix:**
  - Decide per file: use the entries on the file's own device. Fall back to the probe only when the filesystem's
    lock device cannot be matched at all (for example, `/proc/self/mountinfo` shows its `st_dev` differs, as on
    btrfs subvolumes).
  - Probe the `-shm` as well (A34-04's fix), so the fallback is safe either way.

## Notes (no test)

- **Short reads.** A short read of `index.db` zero-fills the page in SQLite, so the check reports rows and the WAL
  is set aside (A36-01's class). A short read of the WAL is refused (`SQLITE_IOERR_SHORT_READ`).
- **A foreign WAL replayed onto an empty index.** A killed `atlas docs` WAL on the sample, put beside an index made
  by `atlas init` (schema only), passes `integrity_check`. It is kept, and its docs then point at files the index
  does not have. This is A34-03's class (33 of 324 foreign pairs kept, all same-repo except this one).
- **The "cannot check" message** says "free disk space (or fix the cause) and retry" for every cause, for example
  `SQLITE_IOERR_CORRUPTFS` on a failing disk. It is accurate enough, and the WAL is kept.
- **No hard links (inode exhaustion, FAT/exFAT, some FUSE/SMB mounts).** The check runs on the path itself. Its
  recovery rewrites the real `-shm` (`nBackfillAttempted`), so a foreign WAL can no longer be set aside. It is
  refused with the malformed message and a remedy that deletes the index. This fails closed. The index itself was
  intact (B's), so moving the `-wal` away would have been enough.
- **Still open.** I ran the audit-21, audit-25, audit-29, audit-31 and audit-34 files with `it.fails` → `it`. These
  still fail with their recorded messages:
  - A21-01 (2), A21-02, A25-02 and A25-03;
  - A29-01 (2): `expected 'disk I/O error' to match /atlas (serve|mcp)|another process/`;
  - A29-02: `expected 1 to be +0`;
  - A31-03: refused with the named message, as in AUDIT-34;
  - A31-04;
  - A34-03: `expected 'DOC-FOR-src/math.ts\n' not to match …`;
  - A34-04: `expected 'atlas: /tmp/atlas-audit34-…' not to match /^atlas: disk I\/O error$/m`.
