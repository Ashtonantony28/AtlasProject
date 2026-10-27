# AUDIT-38: Test coverage (round 9)

This audit checks whether the code changed since AUDIT-32 is really tested, so that a regression turns a test red.
Scope: everything SG130, SG135, SG140 and SG150 added to `src/core/db/database.ts`:
- SG130/SG135: `checkLeftoverWal`, `decideWal`, `walOwner`, `leftoverWal`, `holders`, `probe`, `lockOpens`,
  `integrityOk`, `setAside`, `neverCheckpointed`;
- SG140: `integrityOk` fails closed (`integrityResult` rethrows anything but `SQLITE_CORRUPT*`/`SQLITE_NOTADB`), `holders`
  matches on device and inode and gives up ("unsure") on a lock on another device, `reportAside`;
- SG150: a second check, `readAll` of the file and WAL between the checks, the disagreement and row error-code rules,
  `fileState` in the set-aside name, and `reportAside` withdrawing the move-back once the index has been written;
- the open coverage findings A32-01 and A32-02.

Base: `52f5c25` on `claude/atlas-audit-38` (cut from `claude/atlas-sg150`: SG120, SG130/SG135, SG140 and the SG150
fix awaiting merge). Node 22.22, 4 vCPU, `cc` present. The auditor wrote none of this code.

Method:
- `npm run test:coverage` on the base suite, and once more with `--exclude 'test/audit/**'`.
- 64 hand mutations of `database.ts`, one at a time, each one or two exact string replacements in a scratch copy of
  the tree (its own git repo), restored with `git checkout` and checked clean with `git status -- src` after every
  mutant (all 64 clean). The worktree's `src/` was never edited. The harness (`run.mjs`) and the mutant lists
  (`mutants.mjs`, `mutants2.mjs`) are in the session scratchpad under `a38/`, not committed.
- The 61 scope mutants each ran against the **whole** base suite (101 files without `audit-38`, JSON reporter, no
  bail), so every failing test is recorded, then against `audit-38.test.ts` alone. Three more (K05, and V01/V02 for
  A32-01/02) ran against the suite without `test/audit`, then the audit file that pins them.
- The decisions that only a failing disk reaches were also attacked with real processes: the built-in CLI from this
  tree on a copy of the sample, a killed writer's own WAL beside it, and an `LD_PRELOAD` shim (`a38/shim/off.c`)
  that fails `pread` on the check's hard link with `EIO` at a byte range (a bad sector: every read of it fails) or on
  chosen reads only (an intermittent fault, as on a soft NFS/SMB mount or a flaky USB link).

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core` | 97.5% (5518/5662) | 92.1% (2832/3074) | 98.4% (359/365) | 90% / 88% / 96% |
| `src/core`, without `test/audit` | 94.4% (5344/5662) | 90.9% (2626/2890) | **94.8% (346/365): fails** | |
| `src/core`, with `audit-38` | 98.3% (5565/5662) | 92.7% (2880/3108) | 98.9% (361/365) | |
| `db/database.ts` | 84.6% (369/436) | 81.3% (135/166) | 34/36 | |
| `db/database.ts`, without `test/audit` | **50.2% (219/436)** | 81.1% (73/90) | **21/35** | |
| `db/database.ts`, with `audit-38` | 95.4% (416/436) | 91.5% (182/199) | 36/36 | |

Line coverage of `database.ts` understates what runs: most audit tests drive the CLI in child processes, which
coverage does not see. Mutation is the measure that counts here.

**Mutations (61 in scope):**
- **Without `test/audit`, 1 killed (2%)**: L02, by `db/locking`. SG120 to SG150 added no test outside `test/audit/`
  (`git log 72cd743..HEAD -- test/db test/ingest test/cli test/mcp` is empty), and with `test/audit` excluded
  `decideWal`, `lockOpens`, `integrityOk`, `integrityResult`, `readAll`, `setAside`, `fileState`,
  `neverCheckpointed`, `readHead`, `probe` and `fileInUse` never run.
- **Whole base suite, 25 killed (41%)**, every kill by `test/audit/` (audit-25, -27, -31, -33, -34, -35, -36). 36
  survive all 970 tests, among them 6 that drop a killed writer's own WAL with exit 0 on a disk I/O error (A38-01).
- **With `audit-38.test.ts`: 51 (84%).** 26 survivors are killed by the new file. The other 10 are equivalent or
  have no effect found (below).
- Extra: K05 survives the product suite (killed by `audit-38`); V01 (A32-01) and V02 (A32-02) still survive the 572
  product tests and are killed only by `audit-28` and `audit-32`.

**Totals:** 0 critical, 1 high, 3 medium, 2 low. One new SG row (SG160).

## Coverage

### Uncovered in the changed code (full base suite, in-process)

| Lines | What it is |
| --- | --- |
| 132-133, 135, 137 (branches) | `decideWal`'s `?? probe(path)` fallbacks, live-at-recheck return, the `before.shm` guard |
| 157-158 | `leftoverWal`'s `catch` |
| 182-183 | `holders` without a readable `/proc/locks` |
| 205-212, 430-447 | `probe` and `fileInUse` (run only in child processes) |
| 224-225, 229-233 | `lockOpens`: lock file not creatable; `BEGIN EXCLUSIVE` failing (non-busy: proceed; busy: `open:` refusal) |
| 255 | `integrityOk` without hard links |
| 266-267 | `a page could not be read`: the two checks disagree, or a row carries a non-corruption error code |
| 270-281 | `integrityOk`'s `catch`: every "cannot check … it is kept" refusal |
| 302-307 | `integrityResult`'s `catch`: `SQLITE_CORRUPT`/`NOTADB` thrown by SQLite |
| 318 (branch) | `readAll`'s short read |
| 336-337 | `setAside` when the rename fails |
| 348-349, 370-371 | `fileState`'s and `reportAside`'s `catch` |
| 368 (branches), 378 | `reportAside` when the index has a WAL of its own; the "may have been written since" message |
| 402-403 | `neverCheckpointed` without a readable `-wal`/`-shm` |

With `audit-38`, still uncovered: 157-158, 255, 275 (a cause whose message already starts with the code), 302-307
(reached only in the CLI processes of `audit-36`), 348-349, 370-371, 440-446 (`fileInUse` in-process), and the
`before.shm` throw at 133 in-process.

## Mutation results

"Base" is the whole suite before `audit-38` (first failing test named; "audit only" means no product test fails).
"audit-38" names the new test that kills it.

### SG150: the two checks, `readAll`, the row rules (`integrityOk`, `readAll`)

| ID | Mutation | Base | audit-38 |
| --- | --- | --- | --- |
| I03 | `readAll` of the file and WAL dropped | **SURVIVED** | I03 |
| I04 | `readAll` of the WAL dropped | **SURVIVED** | I04 |
| I05 | Second check dropped (`second = first`) | **SURVIVED** | I05, I06, I13 |
| I06 | A clean second check not trusted (falls to the comparison) | **SURVIVED** | I05, I06, I13 |
| I07 | Disagreeing checks not refused | **SURVIVED** | I07 |
| I08 | A row's non-corruption error code not refused | **SURVIVED** | I08 |
| I09 | Error code compared without `& 0xff` (extended `SQLITE_CORRUPT_*` refused) | **SURVIVED** | I08, I09 (the set-aside test) |
| I10 | Error code read from the second result | survived | equivalent (refused only when both are equal) |
| A01 | `readAll`: a 0-byte read ends the loop instead of throwing | **SURVIVED** | A01 |

### SG140: fail closed (`integrityOk`, `integrityResult`)

| ID | Mutation | Base | audit-38 |
| --- | --- | --- | --- |
| I11 | Any check error sets the WAL aside | killed, audit only (`audit-34` A34-01) | |
| I12 | Any check error keeps the WAL and opens | killed, audit only (`audit-34` A34-01) | |
| I14 | `SQLITE_BUSY` during the check reworded as "cannot check" | survived | no effect found |
| R01 | Check connection writable | killed, audit only (`audit-31` A31-01) | |
| R02 | `SQLITE_NOTADB` not corruption | survived | fail-closed change, no case found |
| R03 | Any thrown error is corruption | killed, audit only (`audit-34` A34-01) | |
| R04 | No `sqlite-vec` on the check connection | survived | equivalent (the check does not read `vec0`) |
| I01 | Check on the path, not hard links | killed, audit only (`audit-31` A31-01) | |
| I02 | A first `ok` read as corruption | killed, audit only (`audit-27`) | |
| I13 | Check links not removed | **SURVIVED** | I05, I06, I13 |

### SG130/SG135: the decision and the lock (`checkLeftoverWal`, `decideWal`, `lockOpens`, `probe`)

| ID | Mutation | Base | audit-38 |
| --- | --- | --- | --- |
| C01 | `reportAside` not called | killed, audit only (`audit-34` SG140) | |
| C02 | No re-check of `leftoverWal` under the lock | survived | no effect found (a WAL gone meanwhile checks `ok` on the path) |
| C03 | Lock released before the index is opened | **SURVIVED** | K01, K03, C03 |
| C04 | Lock not released when the check throws | killed, audit only (`audit-31`) | |
| C05 | No live-WAL return before the lock | killed, audit only (`audit-25`) | |
| D01 | Renamed-over guard (`before.shm`) dropped | killed, audit only (`audit-33` A33-05) | |
| D02 | Second `holders` look dropped | survived | no effect found (a race inside the lock) |
| D03 | `after` holders not required | **SURVIVED** | P01 |
| D04 | `neverCheckpointed` not required | killed, audit only (`audit-31`) | |
| D05 | Integrity result ignored | killed, audit only (`audit-27`) | |
| K01 | `lockOpens` a no-op | **SURVIVED** | K01, K03, C03 |
| K02 | Any `BEGIN EXCLUSIVE` error rethrown | **SURVIVED** | K02, K05 |
| K03 | `BEGIN` (deferred: no lock) | **SURVIVED** | K01, K03, C03 |
| K04 | Lock file not creatable: throws | **SURVIVED** | K04 |
| K05 | Lock busy after 60 s: proceeds unlocked | survived (product suite) | K02, K05 |
| P01 | A probe that cannot run means "nobody" | **SURVIVED** | P01 |
| P02 | Probe never reports the `-shm` | survived | no effect found (a held file still keeps the WAL) |
| O01 | `walOwner` ignores symlinks | killed, audit only (`audit-33` A33-03) | |
| L01 | Any WAL over 0 bytes counts | survived | equivalent (a 1–32-byte WAL has no frames) |
| L02 | An empty `index.db` counts | killed (`db/locking` race test) | |

### SG140: `holders`

| ID | Mutation | Base | audit-38 |
| --- | --- | --- | --- |
| H01 | Always "unsure" (probe always) | killed, audit only (`audit-25`) | |
| H02 | Matches the inode on any device | killed, audit only (`audit-34` A34-02) | |
| H03 | Never "unsure" | killed **only by an `it.fails`** (`audit-36` A36-03 starts passing) | equivalent to A36-03's fix |
| H04 | Minor's high bits dropped (minors over 255) | **SURVIVED** | H04 |
| H05 | Major's high bits dropped | survived | unreachable (kernel majors are 12 bits) |
| H06 | No `/proc/locks`: "nobody" instead of "unsure" | **SURVIVED** | P01 |
| H07 | `liveWal` = file **or** `-shm` held | killed, audit only (`audit-33` A33-02) | |

### SG130/SG150: set aside and report (`setAside`, `fileState`, `reportAside`, `neverCheckpointed`)

| ID | Mutation | Base | audit-38 |
| --- | --- | --- | --- |
| S01 | WAL deleted instead of renamed | killed, audit only (`audit-34`) | |
| S02 | A failed rename reported as done | **SURVIVED** | S02 |
| S03 | No state in the set-aside name | killed, audit only (`audit-36` SG150) | |
| S04 | Set-aside not reported | killed, audit only (`audit-34`) | |
| F01 | State = size only | killed, audit only (`audit-36` SG150) | |
| F02 | State = mtime only | survived | no case found (a write that keeps size changes mtime) |
| T01 | An own WAL does not withdraw the move-back | **SURVIVED** | T01 |
| T02 | Move-back always offered | killed, audit only (`audit-36` SG150) | |
| T03 | Move-back never offered | killed, audit only (`audit-36` SG150) | |
| T04 | Move-back offered when the state is unknown | **SURVIVED** | T01 |
| T05 | Wrong prefix (nothing reported) | killed, audit only (`audit-34`) | |
| N01 | Salts not compared | **SURVIVED** | N01 |
| N02 | Frame count not required | **SURVIVED** | N02 |
| N03 | `nBackfill` ignored | **SURVIVED** | N03 |
| N04 | `nBackfillAttempted` ignored | **SURVIVED** | N04 |
| N05 | No `-shm` counts as "never checkpointed" | **SURVIVED** | N05 |

### Carry-overs (A32-01, A32-02)

| ID | Mutation | Without `test/audit` | Killed by |
| --- | --- | --- | --- |
| V01 | SG105 reverted: the size taken in the `catch` | survives (572 passed) | `audit-28` A28-01 only |
| V02 | A one-page file counts as empty | survives | `audit-32` S04 only |

To reproduce one mutant, for example I03:

```
# in src/core/db/database.ts, delete the two lines
#     readAll(file);
#     readAll(`${file}-wal`);
npx vitest run                                           # 100 files, 970 passed: survives
npx vitest run test/audit/audit-38.test.ts -t I03        # fails: expected [Function] to throw … but it did not
git checkout -- src/core/db/database.ts
```

## Findings

### Critical

None.

### High

**A38-01: SG150's guards are unpinned. Six mutants that make a disk I/O error drop a killed writer's own WAL with
exit 0 pass all 970 tests.** High.
- Class: untested guarantee (I03, I04, I05, I07, I08, A01; branches `database.ts:263-267`, `318`; the `catch` at
  270-281 is not run in-process).
- Evidence:
  - SG150 fixed A36-01 (high): an `EIO` during the check was read as corruption and the WAL was renamed aside. Its
    tests are the `audit-36` shim tests (`EIO_AFTER` 0, 2, 5, 100). That shim fails **every** read after N, so the
    second check fails on its first read and throws `SQLITE_IOERR`. Each SG150 guard is then redundant, and
    removing any one of them passes: `readAll` (I03, I04, A01), the second check (I05), the disagreement rule (I07),
    the error-code rule (I08). No test outside `test/audit/` reaches `integrityOk` at all.
  - Real repros with the built-in CLI, the sample, and a killed writer's own WAL (24 rows), one mutant at a time in the
    scratch tree (`a38/shim/off.so`, failing `pread` on `index.db.<pid>.<ms>.check`):

    | Fault | Today | Mutant | Mutant's result |
    | --- | --- | --- | --- |
    | Bad sector at bytes 110592–114687 (page 28, read while the schema loads): both checks throw `SQLITE_CORRUPT` | exit 1, `cannot check … (EIO: i/o error, read); it is kept` | I03 | `… does not belong to …; moved it to …foreign-…`, exit 0 |
    | Intermittent: read 100 of check 1 and read 150 of check 2 fail | exit 1, `a page could not be read: … failed to get page 120` | I07 | set aside, exit 0 |
    | Intermittent: read 20 of each check fails, the plain read passes | exit 1, `a page could not be read: … error code=8458` | I08 | set aside, exit 0 |

    In each mutant run the 24 rows (and the WAL's docs) are gone from the answer, and the next write makes the
    move-back unsafe (A36-02).
  - So a refactor of `integrityOk` can bring back A36-01 (high, silent data loss) for bad sectors and intermittent
    faults, which are the usual cases on a failing disk or a soft network mount, with no test failing.
- Repro: mutant I03 above (survives 970 tests); the real repros are `a38/shim/off.c` with `EIO_LO=110592
  EIO_HI=114688` (I03) or `EIO_NTH=100,353` (I07) / `EIO_NTH=20,43` (I08).
- Test (plain `it`, correct today): `I03`, `I04`, `I05, I06, I13`, `I07`, `I08`, `I08, I09`, `A01` in
  `audit-38.test.ts`. They drive the check's verdicts through a `pragma` hook and `readSync` through an `fs` hook,
  in-process (coverage sees them, no `cc` needed). Each fails on its mutant, for example I03: `expected [Function] to
  throw error matching /cannot check …\(EIO: i\/o error, read\); it is kept/ but got 'index … is unreadable …'`.
- Fix (SG160): move these tests (and those of A38-02/03 below) out of `test/audit/` into a product suite,
  `test/db/leftoverWal.test.ts`, so a regression fails `npm test` outside the audit files.

### Medium

**A38-02: SG120–SG150 are pinned only by `test/audit/`. The product suite kills 1 of 61 mutants and fails the
functions threshold.** Medium.
- Class: untested guarantee (A32-01's class, for the whole leftover-WAL check).
- Evidence:
  - No product test changed since AUDIT-32. With `--exclude 'test/audit/**'`, `database.ts` is 50.2% by lines, 11
    of its functions never run, and `src/core` functions are 94.8% (`ERROR: Coverage for functions (94.79%) does not
    meet "src/core/**" threshold (96%)`).
  - Only L02 is killed by a product test. I02 (a killed writer's own WAL always read as corrupt, A33-01's data loss),
    D05, S01 (WAL deleted, not renamed), R01 (the check checkpoints into `index.db`) and I11/I12 (A34-01's data loss)
    pass all 572 product tests.
  - 24 of the 25 base kills are by audit files written as repros (`audit-25`…`audit-36`). Some of them, as written,
    accept either outcome (`expectReplacementOrRefusal`), or guard their assertions with an `if` (`audit-36` A36-02
    passes vacuously when the reminder no longer says "move it back"). They do turn red today, but they were written to
    show a defect, not to define the contract.
  - H03 (never "unsure") is killed only by `audit-36` A36-03's `it.fails` starting to pass; that is the direction of
    its fix, not a regression guard.
- Repro: `npx vitest run --exclude 'test/audit/**'` with I02 (`if (first === 'ok') return false;`): 572 passed.
- Fix (SG160): a product suite for the leftover-WAL check: own WAL kept (copied, moved, symlinked), foreign WAL
  set aside and reported, check cannot run (full disk) refused, live writer and renamed-over writer refused by name,
  checkpoint-started refused; plus the `audit-38` tests.

**A38-03: The fail-closed fallbacks of SG130/SG135 are unpinned: a failed rename, a probe that cannot run, the open
lock and the `-shm` rules can all be inverted with no test failing.** Medium.
- Class: untested guarantee (S02, P01, H06, D03, K01–K05, C03, N01–N05).
- Evidence:
  - S02 (a failed rename reported as done): the foreign WAL stays in place and SQLite replays it into the
    replacement; a writable open then checkpoints the mix into `index.db`. Reached when the `.atlas/` directory cannot
    be written (as root it cannot be produced with permissions; `renameSync` hooked with `EACCES` here).
  - P01 (a probe that cannot run means "nobody") with no `/proc/locks` (macOS, BSD) and no hard links (FAT/exFAT, some
    FUSE/SMB mounts): a live writer's WAL beside a renamed-over index is renamed aside (A33-05's loss). H06 does the
    same where `/proc/locks` is unreadable.
  - K01/K03 (no open lock at all) and C03 (released before the open) survive the whole suite, including `audit-33`
    A33-02 and `audit-34`'s three racing CLI processes: SG135's serialisation is not observed by any test. I found no
    mixed answer from removing it, which is why this is not high.
  - N01–N05: any one of the `-shm` rules (salts, frame count, `nBackfill`, `nBackfillAttempted`, missing `-shm`)
    can be dropped. `audit-31`'s checkpoint-started case sets both counters, so each masks the other; `audit-33`'s
    no-`-shm` case accepts a set-aside. Dropping one lets a WAL whose checkpoint started (part of it already in
    `index.db`) be removed, leaving a torn index.
- Tests (plain `it`): `S02`, `P01`, `K04`, `K02, K05`, `K01, K03, C03` (another process tries the open lock during
  the check and when the index is opened), `N01 … N04` and `N05`.
- Fix: SG160.

**A38-04: The move-back advice is pinned only for an index written by `atlas index`; after a write that leaves only
a WAL (a killed or live writer), any change that keeps offering it passes.** Medium.
- Class: untested boundary (T01, T04; `database.ts:368`, `378` not run in-process).
- Evidence: SG150's fix for A36-02 withdraws the move-back once `index.db`'s size or mtime changed **or** it has a
  `-wal` of its own. The only test (`audit-36` SG150) writes with `atlas index`, which checkpoints, so size and
  mtime change. A writer killed after a commit changes neither (checked in the test: same `size` and `mtimeNs`); its
  commit lives in the new `-wal`. With T01 or T04 the reminder says "move it back to …index.db-wal before anything
  writes the index". Following it overwrites that WAL, and the commit is lost.
- Test (plain `it`): `T01` (fails with T01 and T04: `expected 'atlas: …foreign-… was set aside …; if its writes
  belong there, move it back …' not to match /move it back/`).
- Fix: SG160.

### Low

**A38-05: `holders`' minor-number decoding is unpinned.** Low.
- Class: untested boundary (H04).
- Evidence: minors above 255 (anonymous devices on hosts with many tmpfs/overlay/FUSE mounts; `0:341` in AUDIT-36)
  are encoded in `st_dev`'s high bits. Dropping them (H04) makes every such lock "on another device", so `holders`
  is "unsure" and the probe misses a live writer's `-shm` (A33-05). AUDIT-36 checked it on real mounts; no test
  did. H05 (the major's high bits) is unreachable on Linux (12-bit majors).
- Test (plain `it`): `H04` (`/proc/locks` and `st_dev` both made to read `0:341`).

**A38-06: Carry-overs and survivors with no effect found.** Low.
- A32-01 open: V01 (SG105 reverted) passes the 572 product tests; killed only by `audit-28` A28-01. A32-02 open: V02
  killed only by `audit-32` S04.
- 10 survivors after `audit-38`: I10, L01, R04 equivalent; H05 unreachable; C02, D02 (races inside the lock), F02, I14,
  P02 and R02 (fail-closed) with no case found where the behaviour changes for the worse.
- `audit-36`'s EIO tests are skipped without `cc`. With `audit-38` every SG150 rule is pinned without `cc` too; I11, I12
  and R03 are also killed by `audit-34` A34-01 (no `cc`).

## Re-verified

| Finding | Status | Evidence |
| --- | --- | --- |
| A36-01 EIO read as corruption | fixed (SG150), **pinned by audit only and only for "every read after N"** | `audit-36` SG150 tests pass; I03–I08 survive them (A38-01) |
| A36-02 reminder after a write | fixed for checkpointed writes (SG150) | `audit-36` SG150 test passes; WAL-only writes unpinned (A38-04) |
| A36-03 "unsure" on another device | open | H03 makes its `it.fails` pass |
| A34-01 full disk | fixed, pinned (audit only) | I11, I12, R03 killed by `audit-34` A34-01 |
| A32-01 SG105 pinned by audit only | **open** | V01 survives 572 product tests; killed by `audit-28` |
| A32-02 one-page boundary | **open** (audit only) | V02 killed by `audit-32` S04 only |

## Verification

On `52f5c25` plus `AUDIT-38.md`, `test/audit/audit-38.test.ts` and the PLAN line, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npm run test:coverage` (base) | 100 files, 970 passed, 1 todo; thresholds pass | 177 s |
| `npx vitest run --coverage --exclude 'test/audit/**'` (base) | 64 files, 572 passed; functions threshold fails (94.79% < 96%) | 65 s |
| `npm run test:coverage` (with `audit-38`) | 101 files, 989 passed, 1 todo; thresholds pass | 178 s |
| `npm run typecheck && npm run lint && npx vitest run test/audit/audit-38.test.ts && git diff --exit-code src` | pass; 19 tests; `src/` unchanged | 24 s |

SG160 moved the `audit-38.test.ts` tests to the product suite (`test/db/leftoverWal.test.ts`) and deleted the audit file.
