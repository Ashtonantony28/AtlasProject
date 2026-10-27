# AUDIT-34: soundness (round 10, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `1a80ba3` (SG130/SG135 merged) on
`claude/atlas-audit-34`. Date: 2026-10-27.

Question: can Atlas silently lose committed index data, answer wrongly with success, or corrupt its index? Scope:
SG130/SG135, the leftover-WAL check `checkLeftoverWal` in `src/core/db/database.ts`:
- `/proc/locks` liveness (`holders`: a WAL connection locks the file and its `-shm`);
- the `<db>.open.lock` serialisation (`lockOpens`, an exclusive SQLite lock held until the open is done);
- the integrity check with the WAL replayed, on a read-only connection through hard links (`integrityOk`);
- the `-shm` checkpoint-state decision (`neverCheckpointed`);
- the `-wal.foreign-<ms>` rename (`setAside`);
- symlink resolution (`walOwner`);
- the fallbacks without `/proc/locks` (`probe`/`fileInUse`) or without hard links.

Also re-checked: A29-01, A29-02, A31-03, A31-04, A25-02, A25-03, A21-01 and A21-02.

Method:
- **Real processes and real repos.** I built the CLI from this tree into the scratchpad and used copies of express,
  flask and got from the scratchpad clones, plus the sample fixture. A "killed writer" is one of:
  - `atlas mcp` (built, over stdio with the SDK client) that ran `atlas_index` after an edit and was SIGKILLed;
  - `atlas docs --offline -v` SIGKILLed after 30, 40 or 60 modules;
  - a process that commits an `UPDATE`/`INSERT` and SIGKILLs itself, as in AUDIT-31/33.
- **Legitimate WALs.** I re-ran AUDIT-33's copy/move matrix: `cp -r`, `cp -a`, `tar`, `mv` ×3 in place, a copy
  without `-shm`, and moving `.atlas/` to another directory. I re-ran the docs-loss repro AUDIT-33 did not re-run
  (`atlas docs` SIGKILL, then `cp -a` and `cp -r`). Then I looked for benign reasons the integrity check could fail:
  - a full filesystem (40 MB tmpfs, filled with `dd`), and `ulimit -f` with SIGXFSZ ignored;
  - a reader that cannot write the index files (`setpriv` to `nobody`, files 0644 root, directory 0777);
  - a 157 MB index (9,750 files, 70k symbols: six copies of six repos), with an opener SIGKILLed mid-check.
- **Liveness.** I checked which live holders `/proc/locks` misses or invents:
  - two loop-mounted copies of one ext4 image (the same inode numbers on two devices), a holder on one copy;
  - a CLI in another pid namespace (`unshare --pid --fork --mount-proc`), the holder outside it;
  - no `/proc` at all (`unshare -m` + a tmpfs over `/proc`), as on macOS/BSD.
- **Foreign WALs from real writers.** A killed `atlas_index` or `atlas docs` in checkout A. Then another checkout B
  (the same repo with K = 0, 1, 2, 5 or 20 files edited, or one file added so that file ids shift) is indexed and
  copied over A's `index.db`. That gave 33 trials. I also used symlink chains (a relative link to a link) and a
  directory symlink for `.atlas`.
- **Races.** N `openDatabase` processes (built `dist`) start at the same millisecond, under `race.sh`. There were
  220 trials:
  - beside a foreign WAL: 2 writers, 1+1, 3+1 and 0+4 read-only;
  - beside the index's own copied WAL: 2+1, 3+1 and 0+4.
- **Stalls.** I measured a stopped (SIGSTOP) holder of `.open.lock`, a SIGKILLed one, and the integrity-check cost
  at 157 MB.

The harness scripts are in the session scratchpad under `a34/scripts/`:
- `e1.sh`, `race.sh`, `fmix.sh` and `fmix2.sh`;
- `kw.cjs`, `holder.cjs`, `whold.cjs`, `fts.cjs`, `ichk.cjs` and `noproclocks.cjs`;
- `mcpkill.mjs`, `killafter.mjs`, `opener.mjs` and `walstate.mjs`.

Every finding also has an in-repo test.

Repros are in `test/audit/audit-34.test.ts`. Each `it.fails` asserts the correct behaviour. I ran the file 5 times
(11/11 each run). I also ran each `it.fails` as a plain `it` 5 times: each failed every time, on the assertion that
names its defect (messages below). The tests are deterministic and need no privileges:
- `ulimit -f 16` (SIGXFSZ ignored) stands in for a full disk;
- a `--require` preload replaces what `readFileSync('/proc/locks')` returns: another device's locks, or ENOENT.

The real repros (tmpfs, loop mounts, namespaces) are below. Plain `it` blocks pin what was attacked and held.

**Summary: 0 critical, 1 high, 2 medium, 1 low.**
- What holds:
  - A33-01 is fixed. Every copy or move kept the WAL's commits on express, flask and got (18/18). `atlas docs`
    SIGKILLed after 60 modules, then `cp -a`/`cp -r`, keeps 60/60 docs on all three repos (the AUDIT-33 docs-loss
    repro: 60 → 0 before).
  - A33-02 is fixed. In 220 racing trials there were 0 mixed answers, 0 corrupt indexes, 0 leftover links and 0
    errors. Every foreign trial set the WAL aside exactly once; every own-WAL trial kept all 24 rows.
  - A33-03 is fixed for symlinks (a two-level relative chain, `.atlas` itself a symlink), for a missing `-shm`, and
    for a reader that cannot write the files.
- The high (**A34-01**): `integrityOk` reads any error as "the WAL fails integrity". On a full disk (or quota,
  inode exhaustion, `ulimit -f`, an extension that fails to load), the check cannot create its 32 KiB `.check-shm`.
  The index's own WAL is then renamed aside as foreign, and its rows and docs are gone with exit 0 (60 docs → 0).
  The README's recovery (move it back) works only until the next write. After that, the index is refused as
  malformed.
- The mediums:
  - **A34-02:** `holders` matches `/proc/locks` by inode number and ignores the device. A lock on the same inode
    numbers on another filesystem has two effects:
    - the check is skipped, and the foreign WAL is replayed with exit 0 into a permanently corrupt index;
    - or a legitimate WAL is refused with a "delete the index" remedy.

    Examples of other filesystems: a btrfs/ZFS snapshot or clone, a copied disk image.
  - **A34-03:** a foreign WAL that only adds rows passes `PRAGMA integrity_check`. A killed `atlas docs` beside
    another checkout's index was kept in 13 of 18 trials, and its docs were grafted onto the replacement. With
    shifted file ids, every doc is shown for the wrong file with exit 0. DECISIONS (SG130) names only FTS/`vec0`
    contents and byte-identical backups as residuals.
- The low (**A34-04**): where `/proc/locks` is missing (macOS, BSD) or filtered (a CLI in another pid namespace,
  such as a container), A33-05 is back. A live process's WAL on a renamed-over index is renamed aside, and the CLI
  fails with a bare `atlas: disk I/O error` until that process exits.
- Still open: A29-01, A29-02, A31-04, A25-02, A25-03, A21-01 (2 tests) and A21-02. Their `it.fails` still fail when
  run as plain `it`. **A31-03 changed:** it is now refused with the named message (see the table).

PLAN rows: SG140 (A34-01).

## Re-verified (changes since AUDIT-33)

| Change | Attack | Result |
| --- | --- | --- |
| SG130: no timestamps, keep a WAL whose replay passes integrity | AUDIT-33's matrix after a killed `atlas_index` on express, flask and got: `cp -r`, `cp -a`, `tar`, `mv` ×3, no `-shm`, `.atlas` moved | 18/18 found the new symbol, exit 0, no `.foreign-` file. Shm state as in AUDIT-33 (149/248/342 frames, never checkpointed). |
| SG130 for docs | `atlas docs --offline` SIGKILLed after 60 modules, then `cp -a`/`cp -r`, `docs --list` | 60/60/60 on all three repos (was 60 → 0). Pinned. |
| SG135: `.open.lock`, holders read passively | `race.sh`: 2w, 1w+1r, 3w+1r, 0w+4r beside a foreign WAL (130 trials); 2w+1r, 3w+1r, 0w+4r beside the index's own copied WAL (90) | 0 mixed answers, 0 corrupt indexes, 0 errors. Foreign: one `.foreign-` file each, every opener saw the replacement. Own: all 24 rows every time. 3 CLI processes at once pinned. |
| SG135: fail closed | symlink chain `index.db → ../../store/link.db → ../store2/real.db` (own and foreign WAL); `.atlas` a symlink; no `-shm` (own WAL); reader `nobody` with 0644 root files | Own WAL kept (24 rows); foreign set aside beside `store2/real.db` or `store3/index.db`; the reader kept the WAL (the integrity check ran on the path itself, since `link()` fails under `protected_hardlinks`). Pinned. |
| SG135 fallback (no `/proc/locks`) | `unshare -m` + tmpfs over `/proc`, and a preload in-test | Copied own WAL kept; foreign WAL set aside. Pinned. With a live holder renamed over: A34-04. |
| Check-link leftovers | opener SIGKILLed 0.25/0.35/0.45 s into the 157 MB check | 2/3 left `index.db.<pid>.<ms>.check`, `-wal`, `-shm` (and `index.db.open.lock-journal`, 512 B). The next open kept the WAL (1,409 rows) in 971 ms and cleared the journal. The links stay (Notes). Pinned. |
| `.open.lock` left by a SIGKILL | holder in `BEGIN EXCLUSIVE` SIGKILLed | The next open is immediate. Pinned. A stopped holder: Notes. |
| Integrity-check cost | 157 MB index, 6.8 MB leftover WAL | First `atlas search` 899 ms against 331 ms without the check (≈570 ms). No stall. |
| A31-03 | AUDIT-31's test as plain `it` | **Changed.** It was a wrong answer with exit 0 (AUDIT-33); now it is refused with `index … is unreadable (another process still has the replaced index open)…`, exit 1. Following the message's remedy (`rm index.db index.db-wal index.db-shm`, `atlas index`) with the holder still running gives a fresh, healthy index. |

## Critical

None found.

## High

### A34-01 A WAL that belongs to the index is renamed aside as foreign whenever the integrity check cannot run (full disk, quota, `ulimit -f`), so its rows and docs are silently lost

- **Evidence:**
  - **Why.** `integrityOk` returns `false` for every error that is not `SQLITE_BUSY*`:
    - opening the read-only check connection;
    - creating or growing its `-shm`;
    - loading `sqlite-vec`;
    - running the pragma.

    `decideWal` reads that `false` as "the WAL does not fit this file". A killed writer's `-shm` says "never
    checkpointed" (that is the normal tail of every run; AUDIT-33), so `setAside` renames the index's own WAL to
    `index.db-wal.foreign-<ms>`. It prints `… does not belong to …`, and the open goes on with the last checkpoint.
    - On a full tmpfs, `ichk.cjs` (the same steps as `integrityOk`) fails with `SQLITE_IOERR_SHMSIZE disk I/O error`.
      The check's `.check-shm` must grow to 32 KiB, while the real `-shm` already has its size. With space back,
      the same check prints `ok`.
    - The same happens on `EDQUOT`, on inode exhaustion (the `-shm` needs a new inode; a hard link does not), on
      `EFBIG` under `ulimit -f`, and if `sqlite-vec` fails to load.
  - **Why it matters.** A full disk is a usual reason for the crash that leaves the WAL in the first place, and the
    first command after it decides. The read that follows succeeds (the existing `-shm` needs no growth), so the
    loss shows as a normal, slightly stale answer.
  - **Built CLI, 40 MB tmpfs, express:**
    1. `atlas index`, then append `auditThirtyFourMarker` to `lib/application.js`.
    2. `atlas_index` via `atlas mcp`, then SIGKILL.
    3. Fill the disk.
    4. `atlas search auditThirtyFourMarker` prints the stderr line, then `0.010 variable http
       (lib/response.js:20)`, exit 0.
  - **Docs are not recoverable.** `atlas docs --offline` SIGKILLed after 60 modules, then a full disk:
    `atlas docs --list` prints `no docs yet — run \`atlas docs\` first`, exit 0 (60 → 0). After freeing the space,
    it still says 0. With a real model those tokens are spent again.
  - **The README's recovery is fragile.** README: "move it back beside the index it came from to recover its
    writes".
    - Moved back before anything else writes: all 60 docs return.
    - After one `atlas index` that re-parsed 2 changed files: moving it back makes every command fail with
      `index … is unreadable (database disk image is malformed)` (`Rowid 2380 out of order`), so the index must be
      deleted.
    - `atlas index` and `atlas_index` write as soon as space is back, and nothing tells the user to move the WAL
      back first. The message says the WAL "does not belong", which steers users away from doing so.
  - **Under `ulimit -f 16`.** The open after the rename also fails, with a bare `atlas: disk I/O error` (exit 1).
    The WAL has already been renamed by then. The next command, with no limit, reads the last checkpoint with
    exit 0.
- **Test:** `A34-01 on a full disk (growing a file fails) a killed writer’s own WAL is kept: its rows and docs are not
  lost`. It runs the CLI under `ulimit -f 16` once, then reads normally. It fails with `expected { Object (stale,
  docs, ...) } to match object { stale: 24, docs: 4 }`.
- **Repro (scratchpad):**
  1. `mount -t tmpfs -o size=40m none full`
  2. `cp -r express full/repo && atlas index full/repo`
  3. `node mcpkill.mjs full/repo atlas_index '{}' SIGKILL` (after an edit), or `killafter.mjs 60 SIGKILL -- atlas
     docs --offline -v --cwd full/repo`
  4. `dd if=/dev/zero of=full/filler bs=1M`
  5. `atlas docs --list --cwd full/repo` prints `no docs yet`, exit 0.
- **Fix:**
  - Only a completed `PRAGMA integrity_check` that reports a problem may count as "does not fit". Any other error
    (`SQLITE_IOERR*`, `SQLITE_FULL`, `SQLITE_CANTOPEN`, `SQLITE_NOMEM`, `ENOSPC`/`EDQUOT`, an extension load
    failure) should refuse with a message that names the cause and keeps the WAL in place. Do not set it aside.
  - Or create and size the check's `-shm` first, and treat a failure there as "cannot check".
  - When a WAL is set aside, say so on every later open until the user acts. For example, refuse while a
    `.foreign-` file is newer than the last checkpoint, or print it with `atlas index`. Then the move-back recovery
    can be used before the next write.

## Medium

### A34-02 `/proc/locks` is matched by inode number on any device: a lock on another filesystem skips the check (foreign WAL replayed) or refuses an index beside its own WAL

- **Evidence:**
  - **Why.** `holders` collects `(\d+)` from ` maj:min:ino ` and compares it with the index's `st_ino`, dropping
    `maj:min`. Inode numbers are unique only per device. Both decisions read this set:
    - `liveWal` (file and `-shm` both "locked") skips the whole check;
    - a "locked" `-shm` without the file throws "another process still has the replaced index open".
  - **Where the numbers collide.** Inode numbers repeat across:
    - btrfs subvolumes and snapshots (each has its own `st_dev`, and inode numbers are kept by
      `btrfs subvolume snapshot`; Fedora's default layout has separate `root` and `home` subvolumes);
    - ZFS clones and LVM snapshots;
    - loop-mounted or VM images copied from one another;
    - any two small filesystems, where low inode numbers recur.

    The check runs only when a leftover WAL is present. A project and its snapshot or clone both opened by Atlas
    is the case that makes it deterministic.
  - **Real processes: two loop-mounted copies of one ext4 image.**
    1. On `img1`, the sample is indexed and a killed writer leaves its WAL. Then `cp img1 img2`, and both are
       mounted.
    2. A holder on `m2/P/.atlas/index.db` reads and stays open. `/proc/locks` shows
       `07:01:24 128 128` (its `-shm`) and `07:01:22 …` (its file); the files on `m1` are inodes 22 and 24 too.
    3. **Skip.** `cp B/.atlas/index.db m1/P/.atlas/index.db` (another checkout's index, same inode). Then
       `atlas search replacementOnlyFn --cwd m1/P` prints `0.016 function add (src/math.ts:4)`, exit 0, and no
       `.open.lock` is even created. Its close checkpoints the mix:
       `wrong # of entries in index idx_symbols_qualified`. The next `atlas index` fails with the corrupt message
       until `rm`.
    4. **False refusal.** The index is untouched, but `index.db` was rewritten to a new inode (`cp -a index.db t &&
       mv t index.db`, as editors' safe-save and sync tools do). The `-shm` is still inode 24. `atlas search add`
       exits 1 with `index … is unreadable (another process still has the replaced index open): … delete … with its
       -wal and -shm`. Following that remedy deletes the WAL's 24 committed rows. Once the holder on `m2` exits,
       the same command keeps them (24).
- **Tests:**
  - `A34-02 locks on the same inode numbers on another filesystem do not skip the check …` fails with
    `expected '0.016 function add (src/math.ts:4)…' to match /replacementOnlyFn/`.
  - `A34-02 a lock on the -shm’s inode number on another filesystem does not refuse an index beside its own WAL`
    fails with `expected 'atlas: index /tmp/atlas-audit34-…' to be ''`.

  Both feed the CLI a `/proc/locks` with the index's inode numbers on device `fd:7f`.
- **Repro (scratchpad `xdev/`):**
  1. `truncate -s 64M img1 && mkfs.ext4 -q img1 && mount -o loop img1 m1`
  2. Index the sample into `m1/P`, run `kw.cjs m1/P/.atlas/index.db`, then `umount m1 && cp img1 img2`, and mount
     both.
  3. `node holder.cjs m2/P/.atlas/index.db &`
  4. `cp B/.atlas/index.db m1/P/.atlas/index.db`
  5. `atlas search replacementOnlyFn --cwd m1/P` prints `add`, exit 0.
- **Fix:** match `maj:min:ino` against the file's `st_dev` and `st_ino`. `st_dev` encodes the major and minor
  numbers: `major = (dev >> 8) & 0xfff | (dev >> 32) & ~0xfff`, `minor = dev & 0xff | (dev >> 12) & ~0xff`.
  `/proc/locks` prints them in hex. Where the device cannot be matched (overlayfs, FUSE), fall back to the probe
  under the lock.

### A34-03 A foreign WAL that only adds rows passes the integrity check and is replayed: a killed `atlas docs` beside another checkout's index grafts its docs onto the wrong files with exit 0

- **Evidence:**
  - **Why.** `PRAGMA integrity_check` is structural. `atlas docs` adds rows to `docs` (new pages at the end of the
    file, plus page 1). When the replacement has the same schema (any Atlas index), the replayed pages often form a
    valid tree, so the WAL is "kept". The docs then point at the replacement's file ids. DECISIONS (SG130) lists
    the residual as "`integrity_check` does not compare FTS or `vec0` contents" and "a byte-identical backup". This
    case is ordinary table rows on a different index.
  - **Real writers (`fmix.sh`).** A = repo with a killed writer; B = the same repo with K files edited, indexed;
    B's index copied over A's.

    | Killed writer | Kept (mixed, exit 0) | Set aside |
    | --- | --- | --- |
    | `atlas docs` after 30 modules, K = 0/1/2/5/20 on express, flask, got | 10/15 (express and flask K ≤ 5; got K = 0, 1, 20) | 5/15 |
    | `atlas docs`, B has one file added (ids shift by one) | **3/3** | 0/3 |
    | `atlas_index` after an edit (`mcpkill.mjs`), K = 0/1/2/5/20 | 3/15 (K = 0 only: base identical, result consistent) | 12/15 |

    All "kept" results pass `PRAGMA integrity_check` and FTS5's own `integrity-check`.
  - **Wrong file, exit 0 (express, shifted ids).** `atlas docs --show aaa/first.js` prints
    `# module examples/auth/index.js …`, exit 0. Each of the 30 docs is attached to the file walked just before
    its own. `atlas drift` does flag them (30 stale, `drift check: failed`), so the next `atlas docs` should
    regenerate them (not run). With unshifted ids, the replacement silently gains another
    checkout's docs.
  - **A rewrite of existing values.** A killed writer re-ran `UPDATE symbols SET docstring = …` with unchanged
    values, so only the FTS triggers wrote, and its WAL held 3 FTS pages. Replayed onto B:
    - `PRAGMA integrity_check` is `ok`, so the WAL was kept, and `atlas search` exits 0;
    - `symbols_fts MATCH 'replacementOnlyFn'` returns `[]` where B alone returns rowid 3;
    - FTS5's `integrity-check` reports `database disk image is malformed`.
- **Test:** `A34-03 a killed \`atlas docs\` WAL beside another checkout’s index does not graft its docs onto other
  files` (sample, B with `a/first.ts` added). It fails with `expected 'DOC-FOR-src/math.ts\n' not to match
  /DOC-FOR-(?!src\/app\.ts\b)/`.
- **Repro:** `fmix2.sh express shift docs`, then `atlas docs --show aaa/first.js --cwd fmix/express-shift-docs-2/A`.
- **Fix:** a structural check cannot tell a WAL's database apart. Record identity. For example, at each WAL
  generation start (the first write after a checkpoint, which every Atlas writer does in one place), write a random
  id into the WAL that is also kept in the database (a `wal_owner` row or `PRAGMA application_id`/`user_version`
  bits). Under the lock, compare it with the main file before replaying. At minimum, also run FTS5
  `integrity-check` with the WAL replayed, and correct the DECISIONS/README residual.

## Low

### A34-04 Without a usable `/proc/locks` (macOS, BSD, another pid namespace), a live process's WAL on a renamed-over index is renamed aside and the CLI fails with a bare `disk I/O error` (A33-05)

- **Evidence:**
  - **Why.** SG135 refuses this case only through `/proc/locks` (the `-shm` locked without the file). Without
    `/proc/locks`, `probe` tests only the file. `fileInUse` locks a hard link of the *new* inode, which nobody
    holds, so it sets `db` and `shm` both `false`. The integrity check of the replacement with the live writer's
    WAL then fails, the `-shm` says never checkpointed, and the live WAL is renamed aside, as in A33-05.
  - **Where it happens.** In a pid namespace, `/proc/locks` exists but hides other namespaces' locks (Linux 4.13+),
    so the holder is invisible. One example: the CLI runs in a dev container while `atlas mcp` runs on the host.
  - **Real processes:**
    1. `whold.cjs` commits and keeps the sample's index open.
    2. `mv B/.atlas/index.db P/.atlas/index.db`.
    3. The results:
       - in the holder's pid namespace: refused with the named message (pinned in AUDIT-33);
       - from `unshare --pid --fork --mount-proc`: `… does not belong to …`, then `atlas: disk I/O error`, exit 1;
       - from `unshare -m` with no `/proc`: the same.
    4. `/proc/<holder>/fd` shows the holder still has `index.db-wal.foreign-<ms>` open. Once it exits, the CLI
       reads B, exit 0.
- **Test:** `A34-04 with no /proc/locks (macOS, BSD) the WAL of a live process on a renamed-over index is kept and the
  CLI names the cause` fails with `expected 'atlas: /tmp/atlas-audit34-…' not to match /^atlas: disk I\/O error$/m`.
- **Fix:**
  - Probe the `-shm` too: a live connection holds a shared lock on byte 128 of `index.db-shm`. `F_GETLK` (or an
    `F_SETLK` read lock on that byte through a separate open) answers that without SQLite.
  - Inside a pid namespace, do not trust `/proc/locks` to list every holder: probe as well.
  - Map `SQLITE_IOERR_SHORT_READ` to the A29-01 message.

## Notes (no test)

- **A stopped holder of `.open.lock` stalls every opener for 60 s.** One case is `atlas index` suspended with
  Ctrl-Z (SIGSTOP) during the integrity check. The waiting `atlas search` then fails after exactly 60 s with
  `atlas: open: database is locked (another process is writing the index; retry when it finishes)`. Nothing is
  writing, and `atlas mcp` clients time out first. A SIGKILLed holder releases the lock at once (pinned).
- **A SIGKILL during the check leaves hard links.** In 2 of 3 kills, `index.db.<pid>.<ms>.check` and its `-wal`
  and `-shm` stayed.
  - The `.check` link keeps the old index inode alive after a reset or replacement (157 MB here).
  - `.check-wal` keeps the whole WAL after SQLite deletes `index.db-wal`.
  - Later opens are not confused (pinned), and `rm .atlas/index.db*` removes them. That glob also removes
    `-wal.foreign-*` files, the only copy of what A34-01 set aside.
- **`/proc/locks` size.** This host lists 30,000 POSIX locks, mostly byte-range locks on one inode, from other
  sessions. `holders` reads and regex-scans the whole table on every open with a leftover WAL. That is cheap here,
  but not bounded.
- **Replacing a live index in place (`cp backup index.db` while `atlas mcp` runs)** is A31-03's class: the holder
  is live, so the check is skipped. README's restore steps say to stop Atlas first. Not re-tested.
- **Still open.** I ran the audit-21, audit-25, audit-29 and audit-31 files with `it.fails` → `it`. These still
  fail with their recorded messages:
  - A21-01 (2), A21-02, A25-02 and A25-03;
  - A29-01 (2): `expected 'disk I/O error' to match /atlas (serve|mcp)|another process/`;
  - A29-02 and A31-04.

  A31-03 changed, as shown in the table above.
