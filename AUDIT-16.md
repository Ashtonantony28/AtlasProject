# AUDIT-16: Test coverage (round 4)

This audit checks whether the code that changed since AUDIT-12 is really tested. That code is SG25–SG33:
- version fingerprints;
- callback scopes;
- Python roots and `PathsMatcher`;
- the token budget (SG28);
- the `indexRepo` per-DB queue (SG29);
- the walker's ignore semantics (SG30);
- destructured symbols (SG31);
- the index lock in `src/core/ingest/lock.ts` (SG32);
- interrupted runs (SG33).

Base: `fe4bf55` on `claude/atlas-audit-16`, with SG31–SG33 and AUDIT-13..15 merged. The auditor wrote none of this
code.

Method:
- `npm run test:coverage` (v8, `src/**`, thresholds from `vitest.config.ts`) on the base suite. I ran it once more
  with `--exclude 'test/audit/**'` to see what the product tests cover on their own.
- 77 hand mutations of the SG25–SG33 code, one at a time. Each ran against the full default suite
  (`npx vitest run --bail 1`) in a scratch copy of the tree (its own git repo), then was restored with
  `git checkout -- <file>`. After every mutant I checked that `git status -- src` was empty. The worktree's `src/` was
  never edited. Each mutation is one exact string replacement. The harness and the mutant list are in the session
  scratchpad, not committed.
- I re-ran every mutant that a test from `test/ingest/concurrency.test.ts` "killed". That test is flaky (A16-01), so
  those kills were false. I re-ran the AUDIT-12 survivors that its tests now kill.
- I ran each `it.fails` in `test/audit/audit-16.test.ts` once as a plain `it` and checked that it fails on its stated
  assertion. I ran each plain test against its mutant and checked that it fails there.

Repros are in `test/audit/audit-16.test.ts`:
- A plain `it` pins behaviour that is correct today, where a surviving mutant showed that no test checks it. The mutant
  ID is in the test name.
- An `it.fails` marks a real defect and asserts the correct behaviour.

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core` | **98.3%** | 92.1% | 98.5% | 90% / 88% / 96% |
| all of `src/` | 94.4% | 91.4% | 97.6% | none |

The thresholds pass. The new SG28–SG33 code is almost fully covered by lines:
- `budget.ts` and `synthesize.ts` have no uncovered line or branch.
- `lock.ts` has one uncovered branch: the non-BUSY error.
- `indexer.ts` has six uncovered lines.

Line coverage hides the gaps. In the queue and lock, most mutations survive the suite.

**Mutations:**
- 77 run.
  - 3 are equivalent: P01, W06 and W12.
  - 1 (R04) shows no difference, because A16-05 masks it.
  - So 73 count.
- The existing suite kills 56 of them, a kill rate of **56/73 (77%)**. AUDIT-12 measured 76%.
- 17 survive. `audit-16.test.ts` kills all 17 with plain tests.
- 9 of the 17 survivors are in the queue and lock (SG29/SG32), out of 14 mutants there. Q05 is killed only by an
  `it.fails` written for another finding (A14-01).

**Totals:** 0 critical, 1 high, 3 medium, 6 low.

## Coverage

Base: `npm run test:coverage` on `fe4bf55`: 76 files, 728 tests passed, 1 todo, in 46.6 s. With this audit: 77 files,
742 tests.

### By directory

| Scope | Lines | Branches | Functions | Lines without `test/audit` |
| --- | --- | --- | --- | --- |
| **All `src/`** | **94.4%** (6080/6440) | 91.4% (2912/3185) | 97.6% (363/372) | 93.9% |
| **`src/core`** | **98.3%** (5067/5155) | 92.1% (2597/2819) | 98.5% (323/328) | 98.1% |
| core/db | 98.1% (352/359) | 95.6% (86/90) | 95.2% (40/42) | 98.1% |
| core/drift | 100% (182/182) | 94.9% (74/78) | 100% (6/6) | 100% |
| core/graph | 98.7% (1005/1018) | 94.5% (709/750) | 100% (62/62) | 98.4% |
| core/ingest | 97.7% (427/437) | 96.1% (197/205) | 95.2% (20/21) | 97.7% |
| core/parse | 98.2% (1580/1609) | 91.8% (974/1061) | 100% (98/98) | 98.2% |
| core/qa | 100% (205/205) | 89.9% (71/79) | 100% (7/7) | 100% |
| core/synth | 99.1% (699/705) | 85.7% (264/308) | 100% (44/44) | 99.1% |
| core/vector | 96.6% (426/441) | 87.7% (164/187) | 97.0% (32/33) | 96.1% |
| `src/cli` | 94.8% (582/614) | 86.3% (182/211) | 90.9% (20/22) | 90.9% |
| `src/mcp` | 98.2% (271/276) | 93.6% (73/78) | 93.3% (14/15) | 98.2% |
| `src/web` | 40.5% (160/395) | 77.9% (60/77) | 85.7% (6/7) | 40.5% |

Compared with AUDIT-12 (`556e572`), `src/core` lines are unchanged at 98.3% and branches rose from 91.6% to 92.1%, on
85 more lines. `src/web` is still 40.5% (A4-16).

### Uncovered ranges in the SG25–SG33 code

| File | Uncovered | What it is |
| --- | --- | --- |
| `ingest/indexer.ts` | 110-111 | `dbFile` fallback when `realpath` fails |
| | 115, 117 (branches) | the in-memory DB key and its no-lock path: no test indexes an in-memory DB (A16-04) |
| | 241-244 | `onFile` payload of a parse failure (A12, still open; A16-09) |
| | 309 (branch) | `1 parse diagnostic`, singular (A16-09) |
| `ingest/lock.ts` | 29 (branch) | a non-`SQLITE_BUSY` error (A16-06) |
| `ingest/walker.ts` | 66-68 | a `.gitignore` that exists but cannot be read (A16-08) |
| `parse/ts.ts` | 922 | a pattern child that is neither a name nor a wrapper |

### Covered only by `test/audit/`

Without `test/audit/**`, these lines of the new code become uncovered:
- `cli/commands/indexCmd.ts:49,51`: the "after a resolver config change" and "after an interrupted run" lines. They are
  pinned by audit-12 X04 and audit-15.
- `ingest/indexer.ts:201,215`: the upgrade retry of unreadable paths, pinned by audit-12 I02/I03.

The five AUDIT-12 ranges are unchanged (A12-11). See A16-10.

## Mutation results

Each mutant ran against the full default suite. "Killed by" names the first test that failed. "audit-16" means a test
this audit added; each one was re-run against its mutant (`npx vitest run test/audit/audit-16.test.ts`) and fails
there.

### `ingest/lock.ts` (SG32)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| L01 | Never give up (`busy && now < deadline` → `busy`) | killed | audit-15 SG32 pinned (timeout) |
| L02 | Waiting connection not closed when giving up | **SURVIVED** | audit-16 L02 (A16-06) |
| L03 | Non-BUSY errors reported as "another run is writing" after the full wait | **SURVIVED** | audit-16 L03 (A16-06) |
| L04 | `timeout: 0` → `3000` (each poll blocks the event loop) | **SURVIVED** | audit-16 L04 (A16-02) |
| L05 | Release does not close the lock | killed | `freshness` A9-01 (timeout) |
| L06 | BUSY test inverted | killed | audit-15 SG32 pinned |
| L07 | Poll with `sleep(0)` (busy loop) | **SURVIVED** | audit-16 L07 (A16-02) |

### `ingest/indexer.ts`: queue (SG29, SG32)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| Q01 | In-memory DBs take a file lock (`<cwd>/:memory:.lock`) | **SURVIVED** | audit-16 Q01 (A16-04) |
| Q02 | Queue and lock keyed by `db.name`, not the real path | **SURVIVED** | audit-16 Q02/Q03 (A16-04) |
| Q03 | `dbFile` uses `resolve`, not `realpathSync` | **SURVIVED** | audit-16 Q02/Q03 (A16-04) |
| Q04 | A finished run always deletes the queue entry | **SURVIVED*** | audit-16 Q04/Q07 (A16-04) |
| Q05 | No in-process queue (lock only) | killed only by `audit-14` A14-01 `it.fails` | audit-16 Q04/Q07 (A16-04) |
| Q06 | Queue tail rejects after a failed run | killed | `audit-13` A13-03 |
| Q07 | In-memory DBs get a fresh key per call (no queue) | **SURVIVED** | audit-16 Q04/Q07 (A16-04) |

\* The first run "killed" Q04 through the flaky SG32 test (A16-01); on re-run it survives.

Q05 is caught today only because removing the queue happens to make the A14-01 `it.fails` pass: the perf audit's
timer then fires. Once SG34 makes index runs yield, that kill goes away.

### `ingest/indexer.ts`: interrupted runs, per-file writes, upgrade (SG25, SG32, SG33)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| R01 | Any unfinished run ever counts as interrupted | killed | audit-15 SG33 pinned |
| R02 | Interruption never a reason | killed | `audit-13` A13-03 |
| R03 | `interrupted` checked before `files changed` | **SURVIVED** | audit-16 R03/R05 (A16-07) |
| R04 | `COALESCE(MAX(id), 0)` → `MAX(id)` | no difference | masked by A16-05: an interrupted first index is re-parsed as an "upgrade" |
| R05 | `--force` after an interruption reported as `files changed` | **SURVIVED** | audit-16 R03/R05 (A16-07) |
| P01 | Per-file delete by the start-of-run snapshot, not by path | equivalent | the lock makes the snapshot current; by-path is defence in depth |
| P02 | Re-parse does not delete the file's old vectors | **SURVIVED** | audit-16 P02 (A16-03) |
| U01 | Downgrade not an upgrade (`<` for `!==`) | killed | `freshness` downgrade |
| U02 | (AUDIT-12 I02) unreadable dir not retried on upgrade | killed | `audit-12` I02 |
| U03 | (AUDIT-12 I03) read failure not retried on upgrade | killed | `audit-12` I03 |
| U04 | (AUDIT-12 M20) `RESOLVER_VERSION` out of the fingerprint | killed | `audit-12` M20 |
| U05 | (AUDIT-12 W07) cap exclusive | killed | `audit-12` W07 |
| U06 | (AUDIT-12 X04) no "after a resolver config change" | killed | `audit-12` X04 |
| A12-M14 | Package root before repo root | killed | `audit-12` M14 |
| A12-M18 | Root `src/` needs a root config | killed | `audit-12` M18 |
| A12-I10 | Diagnostic count read back as 0 | killed | `audit-12` I10 |
| A12-X03 | `--force` not a resolve reason | killed | `audit-12` X03 |
| I11 | "1 parse diagnostics" (no singular) | **SURVIVED** | audit-16 I11/I12 (A16-09) |
| I12 | No `onFile` for a parse failure | **SURVIVED*** | audit-16 I11/I12 (A16-09) |

### `ingest/walker.ts` (SG30)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| W01 | Config `exclude` checked after `.gitignore` | killed | `walker` skip rules (A5-03) |
| W02 | Shallowest set decides | killed | `walker` git parity |
| W03 | `unignored` falls through | killed | `walker` skip rules |
| W04 | `ig.test` (parent check per set) for `ownMatch` | killed | `walker-gitignore` random trees |
| W05 | Ignored directories walked | killed | `audit-9` git consistency |
| W06 | Local sets matched by path, not name | equivalent* | |
| W07 | Directory verdicts without the trailing `/` | killed | `audit-9` git consistency |
| W08 | `.gitignore` read failure throws | **SURVIVED** | audit-16 W08 (A16-08) |
| W09 | `\` patterns counted as segment-local | killed | `walker-gitignore` classifies |
| W10 | Merged local sets in reverse order | killed | `audit-9` git consistency |
| W11 | `ignored` verdict dropped | killed | `audit-9` A9-06 |
| W12 | No `existsSync` before reading `.gitignore` | equivalent | the `catch` returns null |

### Budget and synthesis (SG28)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| B01 | `<` → `<=` at the floor | killed | `audit-4` A4-05 |
| B02 | Floor ignores a smaller `maxTokens` | killed | `synth/budget` |
| B03 | `maxTokens` not capped | killed | `audit-13` SG28 holds |
| B04 | `budgeted` passes the uncapped params | killed | `audit-13` SG28 holds |
| B05 | `budgeted` never records usage | killed | `audit-13` A13-12 |
| B06 | `ceil` → `floor` in the estimate | killed | `synth/budget` |
| B07 | System prompt not estimated | killed | `audit-4` A4-05 |
| S01 | First refusal becomes a skip | killed | audit-15 SG28 pinned |
| S02 | `calls++` dropped (later refusals throw) | killed | `cli` docs → drift |
| S03 | Every refusal throws | killed* | `cli` docs → drift |
| S04 | Uncapped `perDocMax` sent | killed | `synth/completion` |
| S05 | System prompt not estimated | killed | `synth` bounded context |

### MCP, CLI and destructuring (SG29, SG31, SG33)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| C01 | `atlas_index` does not write a missing config | killed | `mcp/server` |
| C02 | `atlas_index` keeps the startup config | killed | `mcp/server` |
| C03 | No "after an interrupted run" | killed | audit-15 SG33 pinned |
| C04 | `docs` does not refuse an empty index | killed | audit-15 A11-01/03 pinned |
| D01–D08 | TS pattern names: shorthand, rest, `assignment_pattern`, `object_assignment_pattern`, order, initializer calls, `pair_pattern` key, plain identifiers | all killed | `parse/destructuring`, `audit-13` A13-01, audit-15 SG31 |
| Y01–Y05, Y08 | Python targets: splat, tuple, list, order, `exported`, top-level kinds | all killed | `parse/destructuring` |
| Y06 | Python target `endLine` = start line | **SURVIVED*** | audit-16 Y06/Y07 (A16-09) |
| Y07 | Python target signature = the bare name | **SURVIVED** | audit-16 Y06/Y07 (A16-09) |

\* The flaky SG32 test (A16-01) "killed" Q04, W06, S03, Y06 and I12 on their first run. On re-run, S03 is killed by a
real assertion and the other four survive.

Counted:
- 77 mutants, minus 3 equivalent (P01, W06, W12) and 1 with no difference (R04), leaves 73.
- Killed by the base suite: 56.
- Survivors: 17. `audit-16.test.ts` kills all 17, and also kills Q05 with a plain test.

To reproduce one mutant, for example L04:

```
# in src/core/ingest/lock.ts, replace `{ timeout: 0 }` with `{ timeout: 3000 }`, then:
npx vitest run                                  # 728 passed: survives
npx vitest run test/audit/audit-16.test.ts      # L04 fails (timer fired after 3018 ms)
git checkout -- src/core/ingest/lock.ts
```

## Test quality

- **A flaky test that hides a real defect.**
  - What happens: `test/ingest/concurrency.test.ts` "two `atlas index` processes … leave exactly one run's rows" fails
    when the machine is loaded, with `atlas: UNIQUE constraint failed: _migrations.version`. It failed in 1 of 6
    full-suite runs on the unmutated tree. It also failed in 5 of the 77 mutation runs, every time about 3 s in, on
    mutants that cannot affect it.
  - Why it matters: the failure is not in the test. Two processes that open a fresh index at the same moment race in
    `runMigrations` (A16-01).
  - Consequence for this audit: mutation kills credited to this test are false, so I re-ran them.
- **A kill that depends on another finding.** Q05, which removes the SG29 queue, is caught only by the
  `audit-14` A14-01 `it.fails`. Once SG34 lands, the queue has no test (A16-04).
- **Line coverage overstates SG32.** `lock.ts` shows 100% of lines. Even so, four of its seven mutants survive the suite:
  - the event-loop guarantee in its doc comment (L04);
  - the poll interval (L07);
  - the cleanup on give-up (L02);
  - non-BUSY errors (L03).
- **`it.fails` pins.** I ran both new `it.fails` once as a plain `it`. Both fail on their stated assertion:
  - A16-01: `expected [Function] to not throw an error but 'SqliteError: UNIQUE constraint failed: _migrations.version' was thrown`
  - A16-05: `expected { from: null, to: 3 } to be undefined`

  The AUDIT-12 `it.fails` (A12-07) still passes as `it.fails`.
- **Stale todo.** `audit-8.test.ts:290` `it.todo('A8-10 (M15) …')` is still there (A12-11, open).
- **Timing tests.** No timing test was added to the default suite. The L04 and L07 bounds are loose (300 ms for a
  50 ms timer; 2–12 polls in 500 ms). The mutants miss them by 10× or more.

## Findings

### Critical

None.

### High

**A16-01: Two processes opening a fresh (or newly migrated) index race in `runMigrations`. One fails with
`UNIQUE constraint failed: _migrations.version`, and the SG32 cross-process test is flaky because of it.** High.
- Class: real defect in an SG32 guarantee; flaky test.
- Evidence:
  - What the code does:
    - `openDatabase` runs `runMigrations` before `indexRepo` takes the index lock.
    - `runMigrations` reads `MAX(version)` outside any transaction (`db/database.ts:71`).
    - It then applies each pending migration in its own deferred transaction.
  - What goes wrong:
    - Two openers both read "0 applied", and both run migration 1.
    - The second one's `INSERT INTO _migrations` violates the primary key.
    - That `atlas index` exits 1 with `atlas: UNIQUE constraint failed: _migrations.version`.
  - SG32's goal was that "a second process waits instead of failing half-way". It holds only once the schema exists.
  - The same race applies to every future migration:
    - The first two processes to open an index after an upgrade that adds a migration both try to apply it.
    - With an `ALTER TABLE … ADD COLUMN` migration, the loser fails with "duplicate column".
    - Here a process can be `atlas index`, `atlas mcp` (which opens at startup), `atlas serve` (read-only, safe) or a
      CI matrix.
  - Measured:
    - 1 of 6 full-suite runs on the base tree (4 vCPU, scratch copy) failed this way.
    - 5 of 77 mutation runs failed this way.
    - Run alone, the test passed 4 of 4 times.
- Repro: `A16-01` in `audit-16.test.ts`. It is an `it.fails` and deterministic:
  - It wraps connection A's `MAX(version)` read so that connection B (`openDatabase` on the same file) applies every
    migration in between.
  - `runMigrations(A)` then throws `UNIQUE constraint failed: _migrations.version`.
- Should exist: SG45 (proposed below). Migrations run under a write lock:
  - `BEGIN IMMEDIATE`, re-read `MAX(version)` inside the transaction, apply what is still pending, with a busy
    timeout;
  - or `openDatabase` takes the index lock while it migrates.
  - Then the A16-01 `it.fails` flips, and the SG32 test passes 20 of 20 full-suite runs.

### Medium

**A16-02: Nothing tests that waiting for the index lock leaves the event loop free or polls at a bounded rate.** Medium.
- Class: untested guarantee that survives mutation (L04, L07).
- Evidence:
  - `lock.ts` says it "polls without blocking the event loop". That holds only because the lock connection has
    `timeout: 0`.
  - With a busy timeout (L04, `timeout: 3000`), each `BEGIN EXCLUSIVE` blocks the thread for up to 3 s. The MCP server
    then stops answering while it waits (compare A15-02 and A14-01). All 728 tests pass anyway, including the audit-15
    test of reads during a held lock, because those reads run in another process.
  - Polling with `sleep(0)` (L07) spins on SQLite for up to 10 minutes. It also survives.
- Repro: `L04`, `L07` in `audit-16.test.ts` (plain `it`):
  - L04: a 50 ms timer fires within 300 ms while `acquireIndexLock` waits.
  - L07: 2–12 `BEGIN EXCLUSIVE` attempts in a 500 ms wait.

**A16-03: No test checks that re-parsing a changed file removes its old vectors.** Medium.
- Class: untested data-integrity invariant (P02).
- Evidence:
  - The per-file transaction calls `deleteEmbeddingsForFile` before it deletes the file's symbols. `embeddings_vec` is
    a vec0 table, so no cascade removes its rows. Symbol ids are `AUTOINCREMENT`, so the ids are never reused.
  - If that call is dropped (P02), every edit leaves the old symbols' vectors in `embeddings_vec`:
    - They are near-duplicates of the new ones, so they take KNN slots in search.
    - The table grows with every edit.
  - All 728 tests pass. Only the prune path (file deleted) is tested (`ingest/prune.test.ts`).
- Repro: `P02` (plain `it`): edit a file, re-index, and check that every `embeddings_vec` rowid is a current symbol and
  that the counts match.

**A16-04: The in-process queue (SG29) is untested on its own: its real-path key, in-memory DBs and queue cleanup.**
Medium.
- Class: untested guarantees that survive mutation (Q01, Q02, Q03, Q04, Q07). Q05 is killed only by an unrelated
  `it.fails`.
- Evidence:
  - For a file DB, the SG32 lock also serialises runs inside one process, because SQLite locks per inode. That hides
    every queue mutant.
  - Q02 and Q03 break the PLAN's own SG32 claim, "the queue keys by the real path". If `.atlas/index.db` is a symlink
    to another file, the lock becomes `index.db.lock` instead of `<target>.lock`. Runs through the two spellings then
    no longer exclude each other, and nothing notices.
  - Branches 115 and 117 (the in-memory key and its "no lock" path) are never run:
    - With Q07, runs on one in-memory DB interleave.
    - With Q01, an in-memory run creates `<cwd>/:memory:.lock`.
  - Q04 makes a finished run drop the queue entry that a later run is waiting on.
- Repro, all plain `it`:
  - `Q02/Q03`: the lock is held on the real file, and a run through a symlinked `index.db` waits.
  - `Q01`: an in-memory index takes no file lock.
  - `Q04/Q07`: three runs on one in-memory DB log their files strictly one run after another, with the third started
    after the first settles. This test also kills Q05.

### Low

**A16-05: After an interrupted first `atlas index`, the next run reports an extractor upgrade and re-parses every
file.** Low.
- Class: real defect (wrong message, redundant work); it also masks R04.
- Evidence:
  - The first index is killed after its parse loop (Ctrl-C, CI timeout), so no run has finished yet.
  - In the next run, `lastState` therefore finds no finished run, so `prev.extractorVersion` is `null`.
  - `upgrade` is then true for rows written moments ago by the current extractor.
  - The run reports `extractorUpgrade: {from: null, to: 3}`, and `atlas index` prints `index was written by an older
    Atlas; re-parsed every file with extractor v3`.
  - It re-parses every file, and `resolveReason` is `files changed`, not `previous run interrupted`.
  - The graph ends up correct.
- Repro: `A16-05` (`it.fails`: `expected { from: null, to: 3 } to be undefined`).

**A16-06: Lock error paths are untested.** Low.
- L03: a non-BUSY error (for example a `.lock` file that is not a SQLite database: `SQLITE_NOTADB`) is thrown at once
  today. If that `throw` is dropped, the run waits 10 minutes and then reports "another atlas index run is writing".
- L02: on give-up the waiting connection is closed. If it is not, each failed wait leaks a descriptor. That is one per
  timed-out `atlas_index` call in a long MCP session.
- Repro: `L03`, `L02` (plain `it`; L02 counts `/proc/self/fd` and is skipped off Linux).

**A16-07: The precedence of `resolveReason` after an interrupted run is untested.** Low.
- R03 (interruption reported over a file change) and R05 (`--force` after an interruption reported as
  `files changed`) both survive. They change only the reported reason. The graph is the same.
- Repro: `R03/R05` (plain `it`).

**A16-08: A `.gitignore` that exists but cannot be read is untested.** Low.
- W08: if `readGitignore`'s `catch` rethrows, the whole walk fails on a `.gitignore` directory or an unreadable file.
  Today such a file is skipped (git also ignores a `.gitignore` directory).
- Repro: `W08` (plain `it`).

**A16-09: Small payloads.** Low.
- Y06 and Y07: the span and signature of destructured Python targets (`a, b = (` … `)` spans lines 1–4, like
  `c = (` … `)`) are unpinned. `parse/destructuring` checks names and export flags only.
- I12 (AUDIT-12's `indexer.ts:196-199`, now 241-244): the `onFile` payload of a parse failure is still untested.
- I11: `1 parse diagnostic` in the singular is untested.
- Repro: `Y06/Y07`, `I11/I12` (plain `it`).

**A16-10: Carry-overs from AUDIT-12.** Low.
- A12-07 (`extends: "./base"` prefers a directory) is still open. Its `it.fails` still fails.
- A12-11 is still open:
  - the stale `it.todo` in `audit-8.test.ts:290`;
  - five ranges that only `test/audit/` covers.

  Two new ranges now join it: `indexCmd.ts:49,51` and `indexer.ts:201,215` (see Coverage).

## Re-verified (AUDIT-12)

| Finding | Status | Evidence |
| --- | --- | --- |
| A12-01 walker drops files git keeps | fixed (SG30) | `walker-gitignore` uses git as its oracle; W02–W05, W07, W10, W11 are killed by git-parity tests |
| A12-02 upgrade retry of unreadable paths | pinned | U02, U03 killed by `audit-12` I02/I03 (still audit-only) |
| A12-03 `RESOLVER_VERSION` in fingerprint | pinned | U04 killed by `audit-12` M20 |
| A12-04 insert work invisible to perf gate | addressed | `audit-14` operation-count gate (AUDIT-14) |
| A12-05 resolve reasons/messages | pinned | A12-X03, U06 killed |
| A12-06 Python root precedence | pinned | A12-M14, A12-M18 killed |
| A12-07 `extends` directory first | **open** | `it.fails` still fails |
| A12-08 SG26 guards | pinned | `audit-12` T-tests unchanged |
| A12-09 ci-comment derivations | pinned | unchanged |
| A12-10 boundaries | pinned | U05 (W07), A12-I10 killed; M02 test unchanged |
| A12-11 leftovers | **open** | stale todo; audit-only ranges grew by two (A16-10) |

## No finding

- **Budget (SG28).** All 12 budget and synthesis mutants are killed: the floor, the cap, the estimate, recording, the
  first-call refusal and the mid-run skip. `budget.ts` and `synthesize.ts` have no uncovered line or branch.
- **Destructured symbols (SG31).** 14 of 16 parser mutants are killed by `parse/destructuring`, `audit-13` and
  `audit-15`. The other two are spans and signatures (A16-09). A shape probe agreed with the SG31 contract:
  - Locals in functions, callbacks and class static blocks stay local.
  - IIFE wrappers and `for (let …)` initialisers at the top level give symbols, as plain identifiers did before SG31.
- **Walker (SG30).** 10 of 12 mutants are killed. W06 and W12 are equivalent; W08 is A16-08.
- **Interrupted runs (SG33).** The core detection (R01, R02), the CLI line (C03) and the queue tail after a failed run
  (Q06) are killed.
- **Per-file writes by path (SG32).** P01 is equivalent today, because the lock means no other writer can change a path
  after the snapshot.

## Verification

On `fe4bf55` plus `AUDIT-16.md`, `test/audit/audit-16.test.ts` and the PLAN rows, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npm run typecheck` | pass | 13.5 s |
| `npm run lint` | pass | 5.1 s |
| `npm test` | 77 files, 742 passed, 1 todo | 50.6 s |
| `npm run test:coverage` (base) | 76 files, 728 passed, 1 todo; thresholds pass | 46.6 s |
