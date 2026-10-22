# AUDIT-24: Test coverage (round 6)

This audit checks whether the code changed since AUDIT-20 is really tested:
- SG65: `createWalFile`, `BUSY_TIMEOUT_MS` and `nameBusy` in `src/core/db/database.ts`, and the step labels of
  `runIndex` in `src/core/ingest/indexer.ts` (new tests `test/db/locking.test.ts`, `test/cli/busy.test.ts`);
- SG55: the `sliceLines` cache in `src/core/vector/textForSymbol.ts`, the embed yields in `embedAll.ts`, and the
  in-flight refusal text in `metered` (`src/mcp/server.ts`);
- SG50: `carryEdges` and the reservations in `metered` (re-checked).

Base: `b945516` on `claude/atlas-sg65` (SG55, SG65, AUDIT-20/21 merged). Node 22.22, 4 vCPU.
The auditor wrote none of this code.

Method:
- `npm run test:coverage` on the base suite, and once more with `--exclude 'test/audit/**'`.
- 86 hand mutations, one at a time, each an exact string replacement in a scratch copy of the tree (its own git
  repo), restored with `git checkout` and checked clean with `git status -- src` after every mutant. The
  worktree's `src/` was never edited. The harness and the mutant list are in the session scratchpad, not committed.
- Each mutant ran first against the suite without `test/audit/` (`npx vitest run --bail 1 --exclude
  'test/audit/**'`). Survivors ran against `test/audit/` without `audit-24`, then against `audit-24.test.ts`.
- The AUDIT-20 and AUDIT-16 mutants behind A20-02..07 and A16-06..09 were rebuilt from their descriptions and
  re-run the same way.
- `test/db/locking.test.ts` and `test/ingest/concurrency.test.ts` ran 75 times each under three kinds of load
  (see A24-04).

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core` | **98.5%** (5230/5312) | 92.6% (2708/2925) | 98.5% (334/339) | 90% / 88% / 96% |
| `src/core`, without `test/audit` | 98.1% (5209/5312) | 91.2% (2575/2825) | 98.2% | |
| all of `src/` | 94.7% (6295/6649) | 91.9% (3043/3311) | 97.7% (377/386) | none |

(`src/core` with `audit-24`; the base suite gives the same lines and 2706/2924 branches.) The thresholds pass.
The changed files are almost fully covered by lines (`database.ts` 100%, `indexer.ts` 99.4%, `embedAll.ts` 96.6%,
`textForSymbol.ts` 94.8%).

**Mutations:**
- 86 run. 3 are equivalent: D09 (no `timeout`: better-sqlite3's default is also 5000 ms), D15 (`instanceof Error`
  dropped: only non-`Error` objects differ, and better-sqlite3 throws `SqliteError`) and D16 (a guard against a
  double prefix that no path produces). 83 count.
- **New code (SG65, SG55), 31 mutants:** the suite without `test/audit` kills **17 (55%)**, the whole base suite
  **23 (74%)**. `audit-24.test.ts` kills 7 of the 8 survivors: **30/31 (97%)**. D06 survives (see below).
- **All 83:** 25 killed without `test/audit`, 75 (90%) by the base suite, **82/83** with `audit-24`.
- By area, base suite → with `audit-24`: SG65 create 5/7 → 6/7 (D04 and D05 only by a timing test before), SG65
  busy wait 2/2, SG65 naming 2/4 → 4/4, SG65 steps 7/7, SG55 yield 2/4 → 4/4 (audit only before), SG55 slice 3/3
  (2 audit only), SG55 refusal 2/4 → 4/4 (audit only before). Re-checked: SG50 carry 9/9 (6 audit only), SG50
  metered 6/6 (1 audit only), every A20/A16 carry-over mutant 37/37, all by `test/audit` only.

**Totals:** 0 critical, 0 high, 2 medium, 3 low.

## Coverage

### Uncovered in the changed code (full suite)

| File | Uncovered | What it is |
| --- | --- | --- |
| `db/database.ts` | 86 (branch) | `createWalFile`'s `catch`: another process created the file first (A24-03; covered by `audit-24`) |
| | 124 (branch) | `MIGRATIONS` empty |
| `ingest/indexer.ts` | 121-122 | `dbFile` fallback when `realpath` fails (A16-04, unchanged) |
| `vector/embedAll.ts` | 93-94 | "embedding write did not persist" (unreachable) |
| | 73-74, 86 (branches) | a symbol whose file row or source is missing; `onProgress` |
| `vector/textForSymbol.ts` | 63-65 | `makeSourceLoader` on an unreadable file |

`createWalFile`'s fallback runs only in the child processes of the SG65 six-process test, so in-process coverage
never sees it.

### Covered only by `test/audit/`

Without `test/audit/**` (549 tests), these lines become uncovered:
- `ingest/indexer.ts:180-181` (an unparseable run stamp, A20-05) and `370-373` (the `onFile` payload of a parse
  failure, A16-09);
- `vector/textForSymbol.ts:78-79` (`readFileFromRoot` on an unreadable file);
- `cli/commands/docsCmd.ts:84` (the `raise --budget` remap), `indexCmd.ts:49,51` (A16-10), `searchCmd.ts:41-57`
  and `serveCmd.ts:27-36`;
- branches in `ingest/lock.ts:29` (non-BUSY error, A16-06) and `ingest/walker.ts` (A16-08).

## Mutation results

"Killed by" names the first failing test. "audit-24" means only the new tests kill it.

### SG65 creating a fresh index (`database.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| D01 | `createWalFile` not called | killed | `db/locking` creates it in WAL mode |
| D02 | Temporary file not switched to WAL | killed | `db/locking` creates it in WAL mode |
| D03 | Temporary file not removed | killed | `db/locking` creates it in WAL mode |
| D04 | `linkSync` → `renameSync` (replaces a file another process created) | killed | `db/locking` six processes (timing) |
| D05 | `catch` rethrows (EEXIST fails the open) | killed | `db/locking` six processes (timing) |
| D06 | Temporary name without the pid | **SURVIVED*** | none |
| D07 | `:memory:` guard dropped (a file named `:memory:` in the cwd) | **SURVIVED** | audit-24 D07 |

\* D06's first run was "killed" by the self-index smoke test (`integration/self-index`) while the stress runs
loaded the machine; it cannot affect that test, and it survives on re-run. Two processes would need the same
millisecond and path for the pid to matter; no test can force that, so none was added.

### SG65 busy wait and naming (`database.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| D08 | `timeout: 0` | killed | `db/locking` busy wait |
| D09 | `timeout` dropped (default 5000) | equivalent | |
| D10 | `BUSY_TIMEOUT_MS = 1000` | killed | `db/locking` fails after 5 s |
| D11 | Op stays `journal mode` during migrations | killed | `db/locking` fails naming `migrations` |
| D12 | `nameBusy` not called on open | killed | `db/locking` fails naming `migrations` |
| D13 | `startsWith('SQLITE_BUSY')` → `=== 'SQLITE_BUSY'` (`SQLITE_BUSY_SNAPSHOT` unnamed) | **SURVIVED** | audit-24 D13/D14 |
| D14 | Every error named (`UNIQUE constraint failed` → `index write: UNIQUE …`) | **SURVIVED** | audit-24 D13/D14 |
| D15 | `instanceof Error` dropped | equivalent | |
| D16 | Double-prefix guard added | equivalent | |

### SG65 step labels (`indexer.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| B01 | No `index write` label | killed | `cli/busy` |
| B02 | No `graph resolve` label | killed | `cli/busy` |
| B03 | No `embeddings write` label | killed | `cli/busy` |
| B04 | No final `run stamp` label | killed | `cli/busy` |
| B05 | `indexRepo` does not name the error | killed | `cli/busy` |
| B06 | Initial label `index write` | killed | `cli/busy` |
| B07 | Label reset to `run stamp` on a non-forced run | killed | `cli/busy` |

### SG55 (`embedAll.ts`, `textForSymbol.ts`, `server.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| V01 | Embed `YIELD_MS = 60_000` | killed | `audit-18` A18-02 only |
| V02 | No yield in the embed loop | killed | `audit-18` A18-02 only |
| V03 | `lastYield` never updated (yields after every batch once 50 ms passed) | **SURVIVED** | audit-24 V03/V04 |
| V04 | Yield after every batch | **SURVIVED** | audit-24 V03/V04 |
| V05 | Cache off (split per symbol, A18-01 again) | killed | `audit-18` A18-01 only |
| V06 | Cache keyed by length | killed | `audit-21` sliceLines only (also audit-24 V06) |
| V07 | Cache never refreshed | killed | `vector/textForSymbol` |
| V08 | No re-check: "retry when they finish" when no retry can pay | **SURVIVED** | audit-24 V08–V11 |
| V09 | Refusal does not mention the reservations | killed | `audit-18` A18-04 only |
| V10 | In-flight refusal says `raise tokenBudget` | **SURVIVED** | audit-24 V08–V11 |
| V11 | In-flight refusal not rewrapped | killed | `audit-19` A19-01 only |

### SG50 re-check (`indexer.ts`, `server.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| C01 | `carry?.()` dropped | killed | `ingest/concurrency` SG50 |
| C02 | Carry key without the kind | killed | `audit-20` C02 only |
| C03 | Carry key by `name` | killed | `audit-20` C03 only |
| C04 | `.shift()` → `[0]` | killed | `audit-20` C04/C06/C07 only |
| C06 | Carried edges lose `weak` | killed | `audit-20` C04/C06/C07 only |
| C07 | Carried edges lose `meta` | killed | `audit-20` C02 only |
| C08 | Edges into the module symbol carried too | killed | `audit-20` C08 only |
| C11 | `dst` not remapped | killed | `mcp/server` |
| C12 | Only a vanished `src` drops the edge | killed | `ingest/concurrency` SG50 |
| M01–M05 | Reservations ignored / never released / prompt or `max_tokens` not reserved / usage not recorded | killed | `mcp/server` reservation tests |
| M06 | Uncapped `max_tokens` sent | killed | `audit-17` A17-02 only |

### Carry-overs (rebuilt AUDIT-20 and AUDIT-16 mutants)

| Finding | Mutants | Without `test/audit` | With `test/audit` |
| --- | --- | --- | --- |
| A20-02 yield cadence | Y01–Y09 | 0/9 | 9/9 (`audit-20` Y01–Y04, Y03) |
| A20-03 carried-edge identity | C02–C04, C06–C08 | 0/6 | 6/6 (`audit-20`) |
| A20-04 run key walk options | K03–K09 | 0/7 | 7/7 (`audit-20` K01–K09) |
| A20-05 stamps | S01, S03, S06, S07, S09 | 0/5 | 5/5 (`audit-20`) |
| A20-06 client cache | R05–R07 | 0/3 | 3/3 (`audit-20`) |
| A20-07 `--budget` remap | E03 | 0/1 | 1/1 (`audit-20`) |
| A16-06..09 | L02, L03, L04, L07, P02, R03, R03b (R05), W08, I11, I12, Y06, Y07 | 0/12 | 12/12 (`audit-16`; L03 first by `audit-17` A17-05) |

To reproduce one mutant, for example V10:

```
# in src/mcp/server.ts, replace `'retry when they finish',` with `'raise tokenBudget',`, then:
npx vitest run                                  # 816 passed: survives
npx vitest run test/audit/audit-24.test.ts      # V08–V11 fails: expected '…; raise tokenBudget' to be '…; retry when they finish'
git checkout -- src/mcp/server.ts
```

## Findings

### Critical

None.

### High

None.

### Medium

**A24-01: Only the index run and the open name `SQLITE_BUSY`. `atlas docs` still fails with a bare `atlas: database
is locked`, after a 5 s busy wait that a 10k-file resolve transaction can outlast.** Medium.
- Class: defect against SG65 ("CLI errors name the statement that got `SQLITE_BUSY`").
- Evidence:
  - `nameBusy` is called in `openDatabase` and `indexRepo` only. `atlas docs` writes outside both:
    `importPersistedDocs` and `synthesizeDocs` call `upsertDoc` on the connection from `openProjectIndex`. It
    takes no index lock, so it runs alongside an `atlas index` process or an MCP `atlas_index`.
  - A run's resolve is one write transaction. AUDIT-18 measured it at 4.6–5.4 s at 10k files, around
    `BUSY_TIMEOUT_MS` (5000). A `docs` write that lands in it waits 5 s and fails.
  - With a real model, the doc whose write fails has already been paid for, and the rest of the run is lost.
  - Repro (CLI): index a copy of `fixtures/sample`, hold `BEGIN IMMEDIATE` on its `.atlas/index.db` from another
    process for 8 s, and run `npx tsx src/cli/index.ts docs --offline --cwd <dir>`. It prints
    `atlas: database is locked` and exits 1 after 6.6 s. It does not say which step.
- Repro (test): `it.fails` `A24-01` in `audit-24.test.ts`. Run as a plain `it` it fails:
  `AssertionError: expected 'database is locked' to match /^[a-z ]+: database is locked$/` (after 5.4 s).
- Fix: name the docs writes (for example `docs write`), and either take the index lock for `docs` writes or
  write each doc in a short transaction after a busy wait longer than the longest run transaction.

**A24-02: SG55's guarantees are pinned only by audit tests, and four of its mutants passed every test.** Medium.
- Class: untested guarantee (V03, V04, V08, V10), and product tests that pin nothing of SG55 but the slice text
  (V01, V02, V05, V06, V09, V11 are killed only by `audit-18`, `audit-19` and `audit-21`).
- Evidence:
  - The embed loop's cadence is untested. With V03 or V04 it yields after every batch: 600 yields for 600
    batches, where the code yields about once per 50 ms. AUDIT-20 found the same gap in the parse loop (Y04).
  - The in-flight refusal's remedy is untested. With V10 every in-flight refusal says `raise tokenBudget`, the
    A18-04 text SG55 fixed. With V08 a call that no retry can pay says `retry when they finish`.
  - `test/vector/textForSymbol.test.ts` checks the text, not the cost: with the cache off (V05, A18-01 again) it
    passes.
- Repro (plain `it`): `V03/V04` (600 one-symbol batches give fewer than 150 event-loop turns, and fewer than one
  per 10 ms), `V06` (two sources of equal length), `V08–V11` (exact refusal text for a call that fits after the
  reservations settle, and for one that never fits).
- Fix: move A18-01, A18-02, A18-04 and the audit-24 SG55 tests into `test/vector/` and `test/mcp/`.

### Low

**A24-03: SG65's create race is tested only by chance.** Low.
- Class: untested branch (D04, D05, D07, D13, D14).
- Evidence:
  - `createWalFile`'s `catch` (another process created the index first) runs only in the child processes of the
    six-process test, so coverage never sees it (`database.ts:86`). D04 (`renameSync`, which replaces an index
    another process has started to migrate) and D05 (EEXIST thrown) are killed only when two of the six
    processes collide, which they did on these runs.
  - D07 (`:memory:` guard dropped) survives. Product tests that open `:memory:` then leave a 4 KB file named
    `:memory:` in the repo root.
  - `nameBusy` is tested only with `SQLITE_BUSY`. D13 (`SQLITE_BUSY_SNAPSHOT`, the code of the A20-01 race, left
    unnamed) and D14 (every error prefixed, so `UNIQUE constraint failed` reads `index write: UNIQUE …`) survive.
- Repro (plain `it`): `D04/D05` (another process's index appears while the temporary file is built; its rows are
  kept and it is migrated), `D07` (no file in the cwd), `D13/D14`.

**A24-04: The new tests are deterministic under load, but two bounds are tight.** Low.
- Evidence: 75 runs of each file, none failed.

  | Load | `db/locking.test.ts` | `ingest/concurrency.test.ts` |
  | --- | --- | --- |
  | the mutation runner's full-suite runs alongside | 25/25 | 25/25 |
  | four busy-loop node processes (one per vCPU) | 20/20 | 20/20 |
  | three copies of the loop at once (10 rounds each) | 30/30 | 30/30 |

  The SG32 `database is locked` failure (A20-01) did not recur in these 150 runs.
- Risk: "waits on the busy timeout" needs more than 200 ms of a 400 ms hold measured from after the holder
  prints `locked`, and "opening a migrated index never waits" needs the open in under 750 ms. Both passed on every
  run; a slower machine eats the first margin before the second. The six-process test spins on all CPUs for 2.4 s.
- One unexplained failure: the self-index smoke test (`integration/self-index`) failed once while the machine was
  loaded (D06 run). It passed on re-run and in every later run.

**A24-05: Carry-overs.** Low.
- A20-02..A20-07 are still pinned only by `test/audit/`. All 31 of their rebuilt mutants are killed by
  `audit-20`, and none by the 549 tests outside `test/audit/`.
- A16-06..A16-09: all 12 mutants are killed only by `audit-16` (L03 now first by `audit-17`).
- A12-07 (`extends: "./base"` prefers a directory): still open. Its `it.fails` still fails.
- A12-11: still open. The stale `it.todo` at `audit-8.test.ts:290` is still there. The audit-only ranges are now
  the ones listed under "Covered only by `test/audit/`".

## Re-verified (AUDIT-20)

| Finding | Status | Evidence |
| --- | --- | --- |
| A20-01 SG45 untested; SG32 flake | fixed (SG65) | G01/G03/G05 live in `db/locking`; D08, D10–D12 killed there; 150 lock-test runs under load, no flake |
| A20-02 yield cadence | pinned (audit only) | Y01–Y09: 0/9 without `test/audit`, 9/9 with |
| A20-03 carried-edge identity | pinned (audit only) | C02–C08: 0/6 without, 6/6 with; A21-01 (first-occurrence pairing) still open |
| A20-04 run key walk options | pinned (audit only) | K03–K09: 0/7 without, 7/7 with |
| A20-05 stamps | pinned (audit only) | S01–S09: 0/5 without, 5/5 with |
| A20-06 client cache | pinned (audit only) | R05–R07: 0/3 without, 3/3 with |
| A20-07 `--budget` remap | pinned (audit only) | E03 by `audit-20` only; `docsCmd.ts:84` audit-only |
| A20-08 / A16-06..09 | pinned (audit only) | 12/12 by `audit-16`/`audit-17` only |
| A12-07 | **open** | `it.fails` still fails |
| A12-11 | **open** | A24-05 |

## No finding

- **SG65 step labels.** All seven label mutants are killed by `cli/busy`.
- **SG65 busy wait.** `timeout: 0` and a shorter timeout are killed by `db/locking`.
- **SG50 reservations.** Five of six mutants are killed by `mcp/server`; M06 by `audit-17`.
- **Probe:** a fresh index another process creates between the existence check and the link is kept and migrated,
  and no temporary file is left.

## Verification

On `b945516` plus `AUDIT-24.md`, `test/audit/audit-24.test.ts` and the PLAN line, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npm run typecheck` | pass | 12.9 s |
| `npm run lint` | pass | 4.9 s |
| `npm run test:coverage` | 86 files, 823 passed, 1 todo; thresholds pass | 61.8 s |
| `npm run test:coverage` (base) | 85 files, 816 passed, 1 todo; thresholds pass | 52.8 s |
