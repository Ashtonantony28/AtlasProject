# AUDIT-32: Test coverage (round 8)

This audit checks whether the code changed since AUDIT-28 is really tested:
- SG105: `switchToWal` in `src/core/db/database.ts` now takes the file size once, before its first
  `journal_mode = WAL`, and retries a refused switch (`SQLITE_BUSY` / `SQLITE_IOERR_DELETE_NOENT`) every 10 ms up
  to the 5 s busy timeout whenever the file was empty then (before: only while it was still 0 bytes at the refusal);
- SG105's test change: the short-gaps test in `test/db/locking.test.ts` varies its pause and now allows two waits
  of 400 ms or more and none of 900 ms or more (before: every wait under 400 ms);
- the open coverage findings A28-02..05, A24-02..05, A12-07 and A12-11.

Base: `72cd743` on `claude/atlas-audit-32` (SG105, AUDIT-26..29 merged). Node 22.22, 4 vCPU.
The auditor wrote none of this code.

Method:
- `npm run test:coverage` on the base suite, and once more with `--exclude 'test/audit/**'`.
- 35 hand mutations, one at a time, each one or two exact string replacements in a scratch copy of the tree (its
  own git repo), restored with `git checkout` and checked clean with `git status -- src` after every mutant. The
  worktree's `src/` was never edited. The harness and the mutant list are in the session scratchpad, not committed.
- Each mutant ran first against the suite without `test/audit/` (`npx vitest run --bail 1 --exclude
  'test/audit/**'`). Survivors ran against `test/audit/` without `audit-32`, then against `audit-32.test.ts`.
- 9 mutants target SG105; 8 re-check `immediate` and the switch (including I02, since its killing test was
  relaxed); 18 rebuild the AUDIT-28/24/20/16 mutants behind A28-02/03, A24-02/03, A20-02..07 and A16-06..09.
- Timing-dependent kills were repeated: I02 6 times, S07 6 times, S01 10 times (5 of them pinned to 2 CPUs with a
  busy loop on each).
- `test/db/locking.test.ts`, `test/ingest/concurrency.test.ts` and audit-29's racing-creators test ran 20 times
  each under `taskset` with busy loops (see "Determinism under load").

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core` | **98.6%** (5285/5362) | 92.8% (2750/2962) | 98.8% (336/340) | 90% / 88% / 96% |
| `src/core`, without `test/audit` | 98.1% (5261/5362) | 91.2% (2600/2850) | 98.5% (336/341) | |
| all of `src/` | 94.8% (6353/6702) | 92.2% (3088/3351) | 97.9% (379/387) | none |

(Base suite, before `audit-32`; with it, the same lines and 2751/2963 branches.) The thresholds pass. Nothing moved
since AUDIT-28: SG105 changed 4 lines, and `database.ts` is still 100% by lines. Line coverage again hides the gap:
reverting SG105 passes every product test.

**Mutations:**
- 35 run, none equivalent.
- **SG105, 9 mutants:** the suite without `test/audit` kills **6 (67%)**, the whole base suite **8 (89%)**.
  `audit-32.test.ts` kills the last one: **9/9**. The one that matters most, S01 (SG105 reverted), is killed only
  by `audit-28`.
- **`immediate` and the switch re-checked, 8 mutants:** 1 killed without `test/audit` (I02, 6/6 runs: the relaxed
  short-gaps test still catches it), 8/8 by the base suite.
- **Carry-overs, 18 mutants:** 0 killed without `test/audit`, 18/18 with it (unchanged since AUDIT-28).
- **All 35:** 7 (20%) killed without `test/audit`, 34 (97%) by the base suite, **35/35** with `audit-32`.

**Totals:** 0 critical, 0 high, 1 medium, 2 low. No new SG rows.

## Coverage

### Uncovered in the changed code (full suite)

| File | Uncovered | What it is |
| --- | --- | --- |
| `db/database.ts` | 191 (branch) | `MIGRATIONS` empty (unchanged) |

`switchToWal` (lines 104-118) is fully covered by lines and branches.

### Covered only by `test/audit/`

Without `test/audit/**` (64 files, 572 tests), these become uncovered:
- `db/database.ts` branches 90 (`createWalFile`'s `catch`, A24-03, unchanged) and **113** (the
  `SQLITE_IOERR_DELETE_NOENT` alternative of `transient`: in-process only `audit-28` runs it; the product race test
  runs it in child processes, which coverage does not see);
- `ingest/indexer.ts:181-182` (an unparseable run stamp, A20-05) and `374-377` (the `onFile` payload of a parse
  failure, A16-09);
- `graph/resolver.ts` branches at 199, 302, 344, 345; `ingest/lock.ts:29` (A16-06); `ingest/walker.ts:67-68`
  (A16-08); `vector/textForSymbol.ts:78-79`;
- `cli/commands/indexCmd.ts:49,51` (A16-10), `searchCmd.ts:41-57`, `serveCmd.ts:27-36`, `core/index.ts:1-5`;
- branches in `drift/detect.ts:191-193`, `graph/export.ts:113-125`, `graph/modules.ts`, `parse/ts.ts` and
  `synth/*` (same as AUDIT-28).

## Mutation results

"Killed by" names the first failing test. "audit-32" means only the new test kills it.

### SG105 (`switchToWal`, `database.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| S01 | SG105 reverted: the size is taken at the refusal, inside the `catch` | killed | `audit-28` A28-01 only (passes 572 product tests; passes `db/locking` 10/10, 5 of them under load) |
| S02 | Any existing file counts as empty (`?.size !== undefined`) | killed | `db/locking` rollback-mode file fails at once |
| S03 | Never empty (no retry) | killed | `db/locking` empty file waited out |
| S04 | A one-page file counts as empty (`size <= 4096`) | **SURVIVED** | audit-32 S04 |
| S05 | `throwIfNoEntry: true` (an in-memory index throws `ENOENT`) | killed | `audit-16` Q01 only (also `audit-24` D07) |
| S06 | Size of `<db>-wal` instead of the index | killed | `db/locking` empty file waited out |
| S07 | `SQLITE_IOERR_DELETE_NOENT` not retried | killed | `db/locking` SG90 six-process race (6/6 runs, about 15 `ERR … disk I/O error` each) |
| S08 | `SQLITE_BUSY` not retried | killed | `db/locking` empty file waited out |
| S09 | No deadline (retried forever) | killed | `cli/busy` `journal mode` exit 1 (30 s timeout) |

### `immediate` and the switch, re-checked (`database.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| I02 | `busy_timeout` not lowered while polling | killed | `db/locking` short gaps, 6/6 runs (e.g. waits `532 180 431 109 56 19 1039 136 130 79 54 1032`: 4 of 400 ms+, max 1039) |
| I10 | `LOCK_POLL_MS = 100` | killed | `audit-25` busy failure at any write only (also `audit-28` I02/I03/I10) |
| I05 | Any error from `BEGIN` retried for 5 s | killed | `audit-28` I05 only |
| N01 | No once-guard in `nameBusy` | killed | `audit-28` N01 only |
| D07 | `:memory:` guard dropped | killed | `audit-24` D07 only |
| D13 | `SQLITE_BUSY_SNAPSHOT` unnamed | killed | `audit-23` `nameBusy` surface only (also `audit-24` D13) |
| W09 | Switch retries without sleeping | killed | `audit-28` W03–W10 only |
| W10 | Switch polls every 1 s | killed | `audit-28` W03–W10 only |

### Callers of `immediate` and the docs naming (A28-02, A28-03)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| X01 | Start stamp deferred | killed | `audit-25` busy failure at any write only |
| X03 | Retry blanking deferred | killed | `audit-28` X01–X07 only |
| X05 | Resolve deferred | killed | `audit-25` busy failure at any write only |
| X06 | Embedding batch deferred | killed | `audit-25` busy failure at any write only |
| X09 | `deleteFile` deferred | killed | `audit-28` X08–X11 only (`audit-25`'s 150 ms holds no longer catch it first) |
| X10 | `deleteFile` in no transaction | killed | `audit-28` X08–X11 only |
| X11 | `upsertDoc` in no transaction | killed | `audit-28` X08–X11 only |
| N04 | `importPersistedDocs` outside the named block | killed | `audit-28` N04 only |

### Carry-overs (rebuilt AUDIT-24, AUDIT-20 and AUDIT-16 mutants)

| Finding | Mutant | Without `test/audit` | Killed by |
| --- | --- | --- | --- |
| A24-02 SG55 | V03 embed `lastYield` never updated | survives | `audit-24` V03/V04 |
| A24-02 SG55 | V10 in-flight refusal says `raise tokenBudget` | survives | `audit-23` SG55 refusal (also `audit-24` V08–V11) |
| A20-02 yield cadence | Y01 `YIELD_MS = 60_000` | survives | `audit-20` Y01/Y02/Y04 |
| A20-03 carried-edge identity | C02 key without kind | survives | `audit-20` C02 |
| A20-04 run key | K05 `exclude` not in the key | survives | `audit-20` K01–K09 |
| A20-06 client cache | R05 a client per call | survives | `audit-20` R05/R06 |
| A20-07 `--budget` remap | E03 any error rewrapped | survives | `audit-20` E03 |
| A16-06 lock errors | L02 non-BUSY reported as "gave up" | survives | `audit-16` L03 |
| A16-03 old vectors | P02 vectors kept on re-parse | survives | `audit-25` busy failure at any write (first), `audit-16` |
| A16-08 unreadable `.gitignore` | W08 fatal | survives | `audit-16` W08 |

To reproduce one mutant, for example S01:

```
# in src/core/db/database.ts, delete
#   const empty = statSync(dbPath, { throwIfNoEntry: false })?.size === 0;
# before `for (;;) {`, and insert the same line before
#   if (!transient || !empty || Date.now() >= deadline) throw err;
npx vitest run --exclude 'test/audit/**'                 # 64 files, 572 passed: survives
npx vitest run test/audit/audit-28.test.ts -t A28-01     # fails: journal mode: database is locked (another process is writing the index; retry when it finishes)
git checkout -- src/core/db/database.ts
```

## Findings

### Critical

None.

### High

None.

### Medium

**A32-01: SG105's fix is pinned only by `audit-28`. Reverting it passes all 572 product tests, and the product
race tests did not catch it in 10 runs, 5 of them under load.** Medium.
- Class: untested guarantee (S01; branch `database.ts:113` audit-only in-process).
- Evidence:
  - SG105 fixed A28-01 (high): an opener whose racer had written page 1 by the time of the refusal gave up with
    `journal mode: database is locked`. Its acceptance said "the A28-01 `it.fails` flips", and the fix flipped it
    in `test/audit/audit-28.test.ts`. No test outside `test/audit/` changed except the short-gaps bound.
  - S01 (the size taken in the `catch` again, i.e. the pre-SG105 code) passes `npx vitest run --exclude
    'test/audit/**'` (572 passed). `db/locking`'s two six-process race tests are the only product tests that can
    reach the window, and they need a racer to write page 1 between another opener's refusal and its stat: S01
    passed `test/db/locking.test.ts` 5/5 idle and 5/5 under `taskset -c 0,1` with a busy loop on each CPU. AUDIT-28
    saw the failure once in 9 loaded runs.
  - In-process, the `SQLITE_IOERR_DELETE_NOENT` alternative (`database.ts:113`, CI's bare `disk I/O error`) is run
    only by `audit-28`'s second A28-01 test. Its removal (S07) is still killed by the product race test, 6/6 runs,
    so the code path is pinned, but not the SG105 case of it.
  - So a refactor of `switchToWal` that moves the stat back can bring back a high-severity race with no product
    test failing, only an audit file.
- Repro: mutant S01 above (survives the product suite; killed only by `audit-28.test.ts` "A28-01 an opener whose
  switch was refused retries once the other opener has switched the file").
- Fix: move the two `A28-01` tests (and the `W03–W10`/`W06`/`W07` switch tests they share hooks with) from
  `test/audit/audit-28.test.ts` into `test/db/locking.test.ts`, or a new `test/db/walSwitch.test.ts` with the
  `pragma`/`statSync` hooks.

### Low

**A32-02: A one-page file that is not empty passed every test as "empty".** Low.
- Class: untested boundary (S04).
- Evidence: with `size <= 4096` in place of `size === 0`, a one-page rollback-mode file that another program holds
  is retried for 5 s before failing, instead of failing at once (SG65's "a file another program created in rollback
  mode fails at once"). The product test and `audit-28` W06 both use `CREATE TABLE`, a two-page (8192-byte) file,
  so the boundary was never checked. All 911 base tests passed with S04.
- Repro (plain `it`): `S04` in `audit-32.test.ts` (a 4096-byte file made by `PRAGMA user_version = 7`, every switch
  refused with `SQLITE_BUSY`: one try, `journal mode: database is locked`, under 1000 ms). With S04 it fails after
  5020 ms: `expected 488 to be 1 // Object.is equality` (488 tries).
- Fix: move it beside the rollback-mode test in `test/db/locking.test.ts`.

**A32-03: Carry-overs.** Low.
- A28-02 (SG80 callers): X01, X03, X05, X06, X09, X10, X11 still pass every product test. X09 (`deleteFile`
  deferred) is now caught only by `audit-28`'s statement trace: `audit-25`'s 150 ms holds no longer catch it.
- A28-03: I05, N01, N04, W09, W10 still pinned only by `audit-28`.
- A24-02 (V03, V10) and A24-03 (D07, D13; `database.ts:90`) still pinned only by `audit-23`/`audit-24`.
- A20-02..07 (Y01, C02, K05, R05, E03) still pinned only by `audit-20`; A16-06..09 (L02, P02, W08) only by
  `audit-16`/`audit-25`.
- S05 (an in-memory index failing at the stat) is killed only by `audit-16` Q01 and `audit-24` D07: no product
  test opens a writable `:memory:` index.
- A12-07 (`extends: "./base"` prefers a directory): still open. Its `it.fails` still fails
  (`npx vitest run test/audit/audit-12.test.ts -t A12-07`: 1 passed).
- A12-11: still open. The stale `it.todo` at `audit-8.test.ts:290` is still there; the audit-only ranges are the ones
  under "Covered only by `test/audit/`".

## Determinism under load

The lock and race tests ran 20 times each, all three loops at once, each under `taskset` with a busy-loop node
process pinned to every CPU (four in all):

| Test | CPUs, runs 1–10 | CPUs, runs 11–20 | Passed | Wall clock per run |
| --- | --- | --- | --- | --- |
| `test/db/locking.test.ts` (21 tests) | 0,1 | 0 | **20/20** | 35–44 s |
| `test/ingest/concurrency.test.ts` (13 tests) | 2,3 | 2 | **20/20** | 43–51 s |
| `audit-29` "writers and readers opening the same fresh index at once" | 3 | 3 | **20/20** | 6–8 s |

Besides these 60, the base suite and the lock files ran about 50 more times during the mutation pass, and every
failure was a mutant's own. No `journal mode: database is locked` (A28-01) and no short-gaps failure (A28-04).
The relaxed short-gaps bound still separates a working poll from SQLite's busy handler: I02 failed it in 6/6 runs
with 4 waits of 400 ms+ and a 1039 ms maximum.

Remaining margins (unchanged): `immediate` must give up between 4.9 s and 6 s; "waits out a ~1 s hold" needs more
than 900 ms and the SG90 empty file more than 800 ms of a 1000 ms hold; the rollback-mode file must fail in under
1000 ms and a migrated index open in under 750 ms. All held on one pinned CPU with a busy loop.

## Re-verified (AUDIT-28, AUDIT-24)

| Finding | Status | Evidence |
| --- | --- | --- |
| A28-01 switch gives up after a racer wrote page 1 | fixed (SG105) | `audit-28` A28-01 tests pass as plain `it`; 20/20 race runs under load; but pinned by audit only (A32-01) |
| A28-02 SG80 callers | **open** (audit only) | X01, X03, X05, X06, X09, X10, X11 survive without `test/audit` (A32-03) |
| A28-03 small SG80/SG90 behaviours | **open** (audit only) | I05, N01, N04, W09, W10 killed only by `audit-28` |
| A28-04 lock tests under load | fixed (SG105) | 60/60 runs above; I02 still killed |
| A28-05 / A24-02, A24-03, A24-05 carry-overs | **open** (audit only) | A32-03 |
| A24-04 tight bounds | improved | short-gaps bound relaxed; other margins unchanged and held under load |
| A12-07 | **open** | `it.fails` still fails |
| A12-11 | **open** | A32-03 |

## No finding

- **SG105's other cases.** Retrying a non-empty file (S02), never retrying (S03), stat of the wrong path (S06),
  dropping either code (S07, S08) and dropping the deadline (S09) are all killed by product tests.
- **SG105's acceptance names a second condition** ("or its header is not yet WAL") that the code does not implement.
  No case was found where it matters: nothing writes a database before `switchToWal`, and SQLite writes page 1 of an
  empty file in the same transaction that sets the WAL header bytes, so a file that is not empty before the first try
  is either already WAL (the switch is a no-op read) or another program's rollback-mode file, which should fail at
  once (S02, S04).
- **The relaxed short-gaps test** still kills I02 (6/6). I10 (`LOCK_POLL_MS = 100`) passes it, as before: with a
  100 ms `busy_timeout` SQLite's own handler still retries within the 25 ms gaps; it is killed by `audit-25`/`audit-28`.

## Verification

On `72cd743` (SG120 and AUDIT-33, merged to the base since, are not in this worktree) plus `AUDIT-32.md`, `test/audit/audit-32.test.ts` and the PLAN line, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npm run typecheck` | pass | 12 s |
| `npm run lint` | pass | 6 s |
| `npm run test:coverage` | 94 files, 912 passed, 1 todo; thresholds pass; `src/core` 98.6% lines, 92.8% branches (2751/2963) | 112 s |
| `npm run test:coverage` (base) | 93 files, 911 passed, 1 todo; thresholds pass | 104 s |
| `npx vitest run --coverage --exclude 'test/audit/**'` (base) | 64 files, 572 passed | 62 s |
