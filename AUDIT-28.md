# AUDIT-28: Test coverage (round 7)

This audit checks whether the code changed since AUDIT-24 is really tested:
- SG80: `immediate(db, fn)` in `src/core/db/database.ts` (retry of `BEGIN IMMEDIATE` every ~10 ms up to 5 s,
  `busy_timeout` 10 while polling and 5000 after, a savepoint inside an outer transaction, no retry of an
  `SQLITE_BUSY` thrown by `fn`), its callers (indexer start stamp, per-file write, retry, prune and finish stamp;
  `resolveGraph`; the `embedAll` batches; `upsertDoc` and `deleteFile`), the `nameBusy` remedy suffix and the
  `docs write` naming in `src/cli/commands/docsCmd.ts`;
- SG90: `openDatabase` skipping the pre-made WAL file beside a `<db>-wal`, and `switchToWal` (retries
  `SQLITE_BUSY` / `SQLITE_IOERR_DELETE_NOENT` every 10 ms while the file is 0 bytes);
- the new tests in `test/db/locking.test.ts`, `test/ingest/concurrency.test.ts` and `test/helpers/lockHolder.ts`.

Base: `40b5534` on `claude/atlas-audit-28` (SG80, SG90, AUDIT-24/25 merged). Node 22.22, 4 vCPU.
The auditor wrote none of this code.

Method:
- `npm run test:coverage` on the base suite, and once more with `--exclude 'test/audit/**'`.
- 50 hand mutations, one at a time, each one or two exact string replacements in a scratch copy of the tree (its
  own git repo), restored with `git checkout` and checked clean with `git status -- src` after every mutant. The
  worktree's `src/` was never edited. The harness and the mutant list are in the session scratchpad, not committed.
- Each mutant ran first against the suite without `test/audit/` (`npx vitest run --bail 1 --exclude
  'test/audit/**'`). Survivors ran against `test/audit/` without `audit-28`, then against `audit-28.test.ts`.
- 12 AUDIT-24/20/16 mutants behind A24-02/03, A20-02..07 and A16-06..09 were rebuilt from their descriptions and
  re-run the same way.
- `test/db/locking.test.ts` and `test/ingest/concurrency.test.ts` ran repeatedly under three kinds of load
  (see A28-04).

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core` | **98.6%** (5285/5362) | 92.8% (2748/2961) | 98.8% (336/340) | 90% / 88% / 96% |
| `src/core`, without `test/audit` | 98.1% (5261/5362) | 91.2% (2596/2846) | 98.5% | |
| all of `src/` | 94.8% (6353/6702) | 92.1% (3084/3348) | 97.9% (379/387) | none |

(Base suite, before `audit-28`; with it, the same lines and 2746/2958 branches.) The thresholds pass. The changed
files are fully or almost fully covered by lines (`database.ts` 100%, `resolver.ts` 100%, `indexer.ts` 99.5%,
`repo.ts` 97.5%, `embedAll.ts` 96.5%). Line coverage again hides the gaps: a third of the new mutants pass every product test.

**Mutations:**
- 50 run. 1 is equivalent: I09 (`BEGIN EXCLUSIVE`, the same as `IMMEDIATE` in WAL mode; the audit-28 stub
  "kills" it only because the stub has no `.exclusive`). 49 count.
- **New code (SG80, SG90), 37 mutants:** the suite without `test/audit` kills **22 (59%)**, the whole base suite
  **29 (78%)**. `audit-28.test.ts` kills all 8 survivors: **37/37**.
- **Carry-overs, 12 mutants:** 0 killed without `test/audit`, 12/12 with it (unchanged since AUDIT-24).
- **All 49:** 22 killed without `test/audit`, 41 (84%) by the base suite, **49/49** with `audit-28`.
- By area, without `test/audit` → base suite → with `audit-28`: `immediate` 7/11 → 10/11 → 11/11, naming 3/5 →
  3/5 → 5/5, callers 4/11 → 8/11 → 11/11, SG90 8/10 → 8/10 → 10/10.

**Totals:** 0 critical, 1 high, 2 medium, 2 low.

## Coverage

### Uncovered in the changed code (full suite)

| File | Uncovered | What it is |
| --- | --- | --- |
| `db/database.ts` | 110 (branch) | `switchToWal`'s `SQLITE_IOERR_DELETE_NOENT` alternative (only the race test's child processes hit it; covered in-process by `audit-28`) |
| | 189 (branch) | `MIGRATIONS` empty |
| `ingest/indexer.ts` | 122-123 | `dbFile` fallback when `realpath` fails (A16-04, unchanged) |
| `vector/embedAll.ts` | 93-94 | "embedding write did not persist" (unreachable) |

### Covered only by `test/audit/`

Without `test/audit/**` (572 tests), these become uncovered:
- `db/database.ts:90` (branch): `createWalFile`'s `catch` (A24-03, unchanged);
- `ingest/indexer.ts:181-182` (an unparseable run stamp, A20-05) and `374-377` (the `onFile` payload of a parse
  failure, A16-09);
- `graph/resolver.ts` branches at 199, 302, 344, 345; `ingest/lock.ts:29` (A16-06); `ingest/walker.ts:67-68`
  (A16-08); `vector/textForSymbol.ts:78-79`;
- `cli/commands/indexCmd.ts:49,51` (A16-10), `searchCmd.ts:41-57`, `serveCmd.ts:27-36`, `core/index.ts:1-5`.

`docsCmd.ts:84` (the `raise --budget` remap) is no longer audit-only: SG80's busy test runs that `catch`. Its
`instanceof` check (E03) is still pinned only by `audit-20`.

## Mutation results

"Killed by" names the first failing test. "audit-28" means only the new tests kill it.

### SG80 `immediate` (`database.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| I01 | Nested call runs `fn` without a savepoint | killed | `db/locking` savepoint |
| I02 | `busy_timeout` not lowered while polling | killed | `db/locking` short gaps (timing) |
| I03 | `busy_timeout` never restored (stays 10 ms) | killed | `db/locking` waits ~1 s |
| I04 | `SQLITE_BUSY` thrown by `fn` retried | killed | `db/locking` no retry |
| I05 | Any error from `BEGIN` retried for 5 s | **SURVIVED** | audit-28 I05 |
| I06 | No deadline (retries forever) | killed | `ingest/concurrency` hold past the busy timeout |
| I07 | Gives up after ~10 ms | killed | `ingest/concurrency` run stamp hold |
| I08 | `BEGIN DEFERRED` | killed | `ingest/concurrency` run stamp hold |
| I09 | `BEGIN EXCLUSIVE` | equivalent | |
| I10 | Polls every 100 ms | killed | `audit-25` busy failure at any write only (also audit-28 I02/I03/I10) |
| I11 | Nested call goes through the retry loop | killed | `audit-25` busy failure at any write only (also audit-28 I11/I12) |
| I12 | Nested call lowers `busy_timeout` and never restores it | killed | `audit-25` busy failure at any write only (also audit-28 I11/I12) |

### Naming (`database.ts`, `docsCmd.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| N01 | No once-guard (named twice) | **SURVIVED** | audit-28 N01 |
| N02 | No remedy suffix | killed | `db/locking` fails naming `migrations` |
| N03 | `docs` errors not named | killed | `ingest/concurrency` docs past the busy timeout |
| N04 | `importPersistedDocs` outside the named block | **SURVIVED** | audit-28 N04 |
| N05 | `docs` named `index write` | killed | `ingest/concurrency` docs past the busy timeout |

### Callers of `immediate`

Each `immediate(db, fn)` replaced by `db.transaction(fn)()` (deferred), or by no transaction at all.

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| X01 | Start stamp deferred | killed | `audit-25` busy failure at any write only |
| X02 | Per-file write deferred | killed | `ingest/concurrency` index write hold |
| X03 | Retry blanking deferred | **SURVIVED** | audit-28 X01–X07 |
| X04 | Prune deferred | killed | `ingest/concurrency` prune hold |
| X05 | Resolve deferred | killed | `audit-25` busy failure at any write only |
| X06 | Embedding batch deferred | killed | `audit-25` busy failure at any write only |
| X07 | Finish stamp deferred | killed | `ingest/concurrency` finish stamp hold |
| X08 | `upsertDoc` deferred | killed | `ingest/concurrency` index and docs succeed |
| X09 | `deleteFile` deferred | killed | `audit-25` 150 ms holds after every file only (timing) |
| X10 | `deleteFile` in no transaction | **SURVIVED** | audit-28 X08–X11 |
| X11 | `upsertDoc` in no transaction | **SURVIVED** | audit-28 X08–X11 |

### SG90 (`database.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| W01 | Pre-made WAL file linked beside a stale `-wal` (A25-01 again) | killed | `db/locking` SG90 discarded |
| W02 | A `-shm` alone also skips the pre-made file | killed | `db/locking` `-shm` alone |
| W03 | Switch never retried | killed | `db/locking` empty file waited out |
| W04 | `SQLITE_IOERR_DELETE_NOENT` not retried | killed | `db/locking` SG90 six-process race (by chance; also audit-28 W03–W10) |
| W05 | `SQLITE_BUSY` not retried | killed | `db/locking` empty file waited out |
| W06 | Retried on a non-empty file too | killed | `db/locking` rollback-mode file fails at once |
| W07 | Retried forever | killed | `cli/busy` `journal mode` exit 1 (30 s timeout) |
| W08 | Gives up after ~10 ms | killed | `db/locking` empty file waited out |
| W09 | Retries without sleeping (CPU spin) | **SURVIVED** | audit-28 W03–W10 |
| W10 | Polls every 1 s | **SURVIVED** | audit-28 W03–W10 |

### Carry-overs (rebuilt AUDIT-24, AUDIT-20 and AUDIT-16 mutants)

| Finding | Mutant | Without `test/audit` | Killed by |
| --- | --- | --- | --- |
| A20-02 yield cadence | Y01 `YIELD_MS = 60_000` | survives | `audit-20` Y01/Y02/Y04 |
| A20-03 carried-edge identity | C02 key without kind | survives | `audit-20` C02 |
| A20-04 run key | K05 `exclude` not in the key | survives | `audit-20` K01–K09 |
| A20-06 client cache | R05 a client per call | survives | `audit-20` R05/R06 |
| A20-07 `--budget` remap | E03 any error rewrapped | survives | `audit-20` E03 |
| A16-06 lock errors | L02 non-BUSY reported as "gave up" | survives | `audit-16` L03 |
| A16-03 old vectors | P02 vectors kept on re-parse | survives | `audit-25` busy failure at any write (first), `audit-16` |
| A16-08 unreadable `.gitignore` | W08 fatal | survives | `audit-16` W08 |
| A24-02 SG55 | V03 embed yields after every batch | survives | `audit-24` V03/V04 |
| A24-02 SG55 | V10 in-flight refusal says `raise tokenBudget` | survives | `audit-24` V08–V11 |
| A24-03 SG65 | D07 `:memory:` guard dropped | survives | `audit-24` D07 |
| A24-03 SG65 | D13 `SQLITE_BUSY_SNAPSHOT` unnamed | survives | `audit-24` D13/D14 |

To reproduce one mutant, for example X03:

```
# in src/core/ingest/indexer.ts, replace
#   immediate(db, () => {\n      for (const id of retry) blank.run(id);\n    });
# with
#   db.transaction(() => {\n      for (const id of retry) blank.run(id);\n    })();
npx vitest run                                  # 870 passed: survives
npx vitest run test/audit/audit-28.test.ts      # X01–X07 fails: expected [ 'deferred: UPDATE files SET content_hash = …' ] to deeply equal []
git checkout -- src/core/ingest/indexer.ts
```

## Findings

### Critical

None.

### High

**A28-01: `switchToWal` gives up when the opener it raced has already written page 1, though a retry would
succeed at once. It failed the SG90 race test once under load.** High.
- Class: defect (race) in SG90's retry condition.
- Evidence:
  - Two processes open a 0-byte index (SG90's path: a stale `-wal` beside a deleted `index.db`, or any empty file).
    Both take a read lock; the first to ask for the write lock gets it, and the other gets `SQLITE_BUSY` at once
    (SQLite's deadlock rule: no busy wait for a read lock upgrading while another holds the write lock; measured:
    1 ms). `switchToWal` retries only `while the file is 0 bytes`, and checks that with `statSync` after the
    refusal. If the winner has written page 1 (4096 bytes) by then, the loser throws
    `journal mode: database is locked (another process is writing the index; retry when it finishes)`.
  - The loser has released its read lock by the time it stats, and the winner is in its own busy handler, which
    sleeps 1 ms or more first. So the window is the loser being descheduled for a few ms between the refusal and
    the stat. 4,200 racing opens of empty files (6 and 12 processes, with and without four busy-loop processes)
    gave 0 failures. But under load the product test hit it: in A28-04, `db/locking`'s SG90 race test ("processes
    opening the same index at the same instant all succeed") failed once in 9 runs with three test loops at once:
    `ERR 19 journal mode: database is locked (another process is writing the index; retry when it finishes)`.
    The round took well under the 5 s deadline and the code is `SQLITE_BUSY`, so the only exit left is the
    non-empty check.
  - A retry right after the failure opens the file in WAL mode in under 100 ms (checked in the repro).
  - So `rm .atlas/index.db` after a crash, then two `atlas` processes (an MCP server and a CLI, say) can fail one
    open, and the default suite is flaky under load. The same window is in "an empty file another process is
    switching" and the SG65 race test.
- Repro: `it.fails` `A28-01` in `audit-28.test.ts`. A second connection holds `BEGIN IMMEDIATE` on a 0-byte file;
  a `statSync` hook makes it commit and switch to WAL between the refusal and the size check (what a racing opener
  does). Run as a plain `it` it fails:
  ```
  × A28-01 an opener whose switch was refused retries once the other opener has switched the file 32ms
    → journal mode: database is locked (another process is writing the index; retry when it finishes)
  SqliteError: journal mode: database is locked (another process is writing the index; retry when it finishes)
   ❯ switchToWal src/core/db/database.ts:106:10
   ❯ Module.openDatabase src/core/db/database.ts:61:7
  ```
- Should exist: SG105 (proposed).
- Fix: retry a transient refusal until the deadline unless the file was already non-empty before the first
  attempt (stat once up front), or retry while `journal_mode` is not yet `wal` on disk (header byte 18 != 2).


### Medium

**A28-02: SG80's "take the write lock up front" is pinned by product tests only where a transaction reads before
it writes. Five callers that write first, and a standalone `upsertDoc` or `deleteFile` with no transaction at all,
pass all 572 product tests.** Medium.
- Class: untested guarantee (X01, X03, X05, X06, X09, X10, X11).
- Evidence:
  - The product tests hold the lock for ~1 s before each step and check that the run waits. A deferred
    transaction whose first statement is a write also waits there: SQLite runs its busy handler when the
    connection had no read snapshot yet. So reverting the start stamp (`INSERT INTO runs`), the resolve
    (`DELETE FROM edges`), an embedding batch (`DELETE FROM embeddings_vec`), the retry blanking (`UPDATE files`)
    or `deleteFile` (`UPDATE docs`) to `db.transaction(fn)()` passes. Only reads-first callers (per-file write,
    prune, finish stamp, `upsertDoc`) are caught.
  - What the reverts lose is SG80's other half: SQLite's handler sleeps up to 100 ms between tries and misses a
    writer's short gaps (the reason `immediate` polls every 10 ms). `db/locking` pins that for `immediate` itself
    (I02), not for its callers.
  - X01, X05 and X06 are caught only by `audit-25`, which counts `BEGIN IMMEDIATE`s to inject failures; X09 only
    by `audit-25`'s 150 ms holds (timing). X03 (the retry path of an extractor upgrade) is caught by nothing.
  - X10/X11: `upsertDoc` and `deleteFile` are exported. Called outside a run, with the `immediate` wrapper removed,
    `deleteFile`'s tombstone and delete are no longer one transaction and `upsertDoc`'s read-then-write is not
    atomic. Inside a run they are nested in the prune's transaction, so nothing notices.
- Repro (plain `it`): `X01–X07` traces every statement of an extractor-upgrade run (one parse failure, one pruned
  file, embeddings on) through better-sqlite3's `verbose` hook and asserts that every `INSERT`/`UPDATE`/`DELETE`
  runs inside `BEGIN IMMEDIATE`, and that each step's statement ran; `X08–X11` does the same for `upsertDoc`
  (insert and update) and `deleteFile` called on their own.
- Fix: move these two tests into `test/db/locking.test.ts` (or `test/ingest/`).

**A28-04: The lock tests are not deterministic under load: the short-gaps test failed once (530 ms against a
400 ms bound), besides the A28-01 race failure.** Medium.
- Evidence: 47 runs under three kinds of load; 2 failed.

  | Load | `db/locking.test.ts` | `ingest/concurrency.test.ts` |
  | --- | --- | --- |
  | the mutation runner's full-suite runs alongside | 5/5 | 4/4 |
  | four busy-loop node processes (one per vCPU) | 9/10 | 10/10 |
  | three copies of the loop at once (3 rounds each) | 8/9 | 9/9 |

  - Busy loops, run 2: "`immediate` takes the lock in a writer's short gaps" failed with waits
    `530 269 234 184 171 176 173 180 182 178 484 164: expected 530 to be less than 400`. A 250 ms hold plus a
    stalled poll is enough. No defect: the bound is tighter than a loaded 4-vCPU machine allows.
  - Three loops, run 3: the SG90 race test failed with `journal mode: database is locked`. That is A28-01.
  - `locking` took 33–59 s per run, `concurrency` 38–48 s. AUDIT-24's 150 runs saw no failure, but its
    short-gaps and SG90 tests did not exist yet.
- Risk:
  - `immediate` gives up "after more than 4.9 s and under 6 s", and the hold-past-timeout tests need more than
    4.9 s: the 5 s deadline is checked only between 10 ms polls, so the upper bound has 1 s of margin and the lower
    one 100 ms.
  - "Takes the lock in a writer's short gaps" needs every wait under 400 ms against 250 ms holds; a 150 ms stall
    of this process fails it.
  - "An index run waits out a ~1 s hold" needs more than 900 ms from when the hold was taken, and the SG90 empty
    file test more than 800 ms of a 1000 ms hold, both measured after the holder confirms.
  - The rollback-mode file must fail in under 1000 ms, and a migrated index open in under 750 ms (A24-04).
- Fix: widen the short-gaps bound (for example, under one hold plus 300 ms, or the median under 400 ms); with
  A28-01 fixed, run both files 50 times under load (SG105).

### Low

**A28-03: Four smaller SG80/SG90 behaviours passed every test.** Low.
- Class: untested branches (I05, N01, N04, W09, W10; W04 only by chance).
- Evidence:
  - I05: `immediate` retries any error from `BEGIN`, not only `SQLITE_BUSY`, for the full 5 s.
  - N01: `nameBusy`'s once-guard ("Names it once") can go; no product path names an error twice today.
  - N04: `importPersistedDocs` can move back outside the named block, so a busy write while `atlas docs` imports
    `.atlas/docs` into a fresh index fails with a bare `atlas: database is locked`. The product test's index has
    no persisted docs, so the first write is in `synthesizeDocs`.
  - W09/W10: `switchToWal` can spin without sleeping (5 s of 100% CPU) or poll every 1 s; the product tests check
    only that it eventually opens. W04 (`SQLITE_IOERR_DELETE_NOENT` not retried) is killed only when two of the six
    race processes collide on a stale WAL.
- Repro (plain `it`): `I05`, `I02, I03, I10`, `I06, I07` and `I11, I12` (a stub connection whose `BEGIN`
  fails as scripted, with a fast `Date.now` for the 5 s deadline); `N01`; `N04` (index, `docs --offline`, delete
  the index, re-index, hold the lock 6 s, `docs` fails naming `docs write` after 5 s); `W03–W10` (a
  `journal_mode = WAL` hook refuses an empty file for 200 ms with each code: opened in under 600 ms after 5–60
  tries), `W07` (refused for good: fails after the busy timeout naming `journal mode`) and `W06`.

**A28-05: Carry-overs.** Low.
- A24-02 (SG55) and A24-03 (`createWalFile`'s catch, `:memory:`, `SQLITE_BUSY_*` naming) are still pinned only by
  `audit-24` (V03, V10, D07, D13 rebuilt: all survive without `test/audit`).
- A20-02..A20-07 are still pinned only by `audit-20` (Y01, C02, K05, R05, E03 rebuilt).
- A16-06..A16-09 are still pinned only by `audit-16` (L02, P02, W08 rebuilt; P02 is now first killed by
  `audit-25`).
- A12-07 (`extends: "./base"` prefers a directory): still open. Its `it.fails` still fails.
- A12-11: still open. The stale `it.todo` at `audit-8.test.ts:290` is still there. The audit-only ranges are the
  ones under "Covered only by `test/audit/`".

## Re-verified (AUDIT-24)

| Finding | Status | Evidence |
| --- | --- | --- |
| A24-01 `docs` busy unnamed | fixed (SG80) | N03/N05 killed by `ingest/concurrency`; the import path was not named-tested (A28-03 N04) |
| A24-02 SG55 audit-only | **open** (audit only) | V03, V10 survive without `test/audit`, killed by `audit-24` |
| A24-03 create race by chance | **open** (audit only) | D07, D13 killed by `audit-24` only; `database.ts:90` audit-only |
| A24-04 tight bounds | **open** | A28-04 |
| A24-05 / A20-02..07 / A16-06..09 | **open** (audit only) | A28-05 |
| A12-07 | **open** | `it.fails` still fails |
| A12-11 | **open** | A28-05 |

## No finding

- **`immediate`'s core contract.** Savepoint nesting, the no-retry of a `fn` error, the deadline, the busy timeout
  restore and `BEGIN IMMEDIATE` itself are killed by `db/locking` and `ingest/concurrency`.
- **SG90's skip.** The stale-WAL skip and the `-shm`-alone case are killed by `db/locking` (W01, W02).
- **Probe:** `BEGIN IMMEDIATE` on a read-only connection succeeds (no error to retry); the one write path outside
  `immediate` is `clearDocTombstones` in `synthesizeDocs`, a single autocommit `DELETE` that waits on SQLite's
  busy handler and is named `docs write`.

## Verification

On `40b5534` plus `AUDIT-28.md`, `test/audit/audit-28.test.ts` and the PLAN line, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npm run typecheck` | pass | 9.8 s |
| `npm run lint` | pass | 6.4 s |
| `npm run test:coverage` | 90 files, 883 passed, 1 todo; thresholds pass; `src/core` 98.6% lines, 92.8% branches (2746/2958) | 94.3 s |
| `npm run test:coverage` (base) | 89 files, 870 passed, 1 todo; thresholds pass | 81.4 s |
