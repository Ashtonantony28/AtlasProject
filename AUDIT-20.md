# AUDIT-20: Test coverage (round 5)

This audit checks whether the code changed since AUDIT-16 is really tested:
- SG34: yielding and joining queued runs in `src/core/ingest/indexer.ts` (`indexRepo`, `runKind`, `yieldIfDue`);
- SG40: `reloadConfig`, the per-model client cache and the budget carry-over in `src/mcp/server.ts`;
- SG50: `carryEdges` in `indexer.ts` and the reservations in `metered` in `server.ts`;
- SG45: `runMigrations` under `BEGIN IMMEDIATE` in `src/core/db/database.ts`, and the
  `stampedExtractorVersion` / `writers` logic in `indexer.ts`;
- `BudgetExhaustedError` and its remedy text (`budget.ts`, `docsCmd.ts`).

Base: `234a9ce` on `claude/atlas-audit-20` (SG34, SG40, SG50, SG45 and AUDIT-16/17/19 merged). Node 22.22, 4 vCPU.
The auditor wrote none of this code.

Method:
- `npm run test:coverage` on the base suite, and once more with `--exclude 'test/audit/**'` to see what the product
  tests cover on their own.
- 79 hand mutations, one at a time, each one exact string replacement in a scratch copy of the tree (its own git
  repo), run against the full default suite (`npx vitest run --bail 1`) and restored with `git checkout`. After every
  mutant `git status -- src` was empty. The worktree's `src/` was never edited. The harness and the mutant list are
  in the session scratchpad, not committed.
- Every kill credited to `test/ingest/concurrency.test.ts` was checked. One was a flake (S06; see A20-01) and was
  re-run.
- The 12 AUDIT-16 mutants behind A16-06..A16-09 were re-run against the full suite and against the suite without
  `test/audit/`.
- Each new test in `test/audit/audit-20.test.ts` was run against every mutant it names and fails there. All 33
  survivors fail at least one audit-20 test. No `it.fails` was added: no test revealed a deterministic bug (see
  A20-01 for the one unexplained failure).

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core` | **98.4%** (5176/5260) | 92.4% (2668/2886) | 98.5% (332/337) | 90% / 88% / 96% |
| `src/core`, without `test/audit` | 98.0% | 91.1% | 98.2% | |
| all of `src/` | 94.6% (6231/6587) | 91.8% (2996/3265) | 97.7% (375/384) | none |

The thresholds pass. The new code is almost fully covered by lines (`indexer.ts` 98.9%, `server.ts` 98.4%,
`database.ts` 100%, `budget.ts` 100%). Line coverage hides the gaps again: 33 of 77 non-equivalent mutants survive.

**Mutations:**
- 79 run. 2 are equivalent: M08 (`reserved += hold` moved inside `try`) and G06 (a refactor of the early return).
  77 count.
- The existing suite kills **44 of 77 (57%)**. AUDIT-16 measured 77% on SG25–SG33.
- 33 survive. `audit-20.test.ts` kills all 33 with plain tests: **77/77**.
- By area: SG34 yielding 0/9 killed, SG34 run key 2/9, queue (A16 Q-mutants, re-run) 6/6, SG50 `carryEdges` 7/13,
  SG50 `metered` 7/7, SG40 reload 7/7 and client cache 0/3, budget remedy 5/6, SG45 migrations 3/5, SG45 stamps
  4/9 (S06's base "kill" was a flake).

**Totals:** 0 critical, 1 high, 3 medium, 4 low.

## Coverage

### Uncovered in the changed code (full suite)

| File | Uncovered | What it is |
| --- | --- | --- |
| `ingest/indexer.ts` | 120-121 | `dbFile` fallback when `realpath` fails (A16-04, unchanged) |
| | 175-176 | `stampedExtractorVersion` on a `stats_json` that is not JSON (A20-05) |
| | 208 (branch) | carry key of a symbol without a `qualified_name` |
| `db/database.ts` | 82 (branch) | `MIGRATIONS` empty |
| `mcp/server.ts` | 428-432 | `startMcpServer` (stdio; run only in a child process) |

### Covered only by `test/audit/`

Without `test/audit/**` (538 tests), these lines become uncovered:
- `cli/commands/docsCmd.ts:84`: the `raise --budget` remap. It is pinned only by audit-19.
- `cli/commands/indexCmd.ts:49,51`: the "after a resolver config change" and "after an interrupted run" lines
  (A16-10, unchanged).
- `ingest/indexer.ts:358-361`: the `onFile` payload of a parse failure (A16-09, unchanged).
- `ingest/walker.ts:67-68`: an unreadable `.gitignore` (A16-08, unchanged).

## Mutation results

"Killed by" names the first failing test of the base suite. "audit-20" means only the new tests kill it.

### SG34 yielding (`indexer.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| Y01 | `YIELD_MS = 50` → `60_000` | **SURVIVED** | audit-20 Y01/Y02/Y04 |
| Y02 | No `yieldIfDue()` in the parse loop | **SURVIVED** | audit-20 Y01/Y02/Y04 |
| Y03 | `always` ignored (phase yields only when 50 ms passed) | **SURVIVED** | audit-20 Y03 |
| Y04 | `lastYield` never updated (yields after every file) | **SURVIVED** | audit-20 Y01/Y02/Y04 |
| Y05 | No yield after the walk | **SURVIVED** | audit-20 Y03 |
| Y06 | No yield after the parse loop | **SURVIVED** | audit-20 Y03 |
| Y07 | No yield before the embed phase | **SURVIVED** | audit-20 Y03 |
| Y08 | No `setImmediate` before a queued run starts | **SURVIVED** | audit-20 Y03 |
| Y09 | Only phase yields (`if (!always) return`) | **SURVIVED** | audit-20 Y01/Y02/Y04 |

### SG34 run key and queue (`indexer.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| K01 | Callers with `onFile` share runs | killed | audit-16 Q04/Q07 |
| K02 | `force` not in the key | killed | `mcp/server` parallel atlas_index |
| K03 | `skipEmbeddings` not in the key | **SURVIVED** | audit-20 K01–K09 |
| K04 | `root` not in the key | **SURVIVED** | audit-20 K01–K09 |
| K05 | `exclude` not in the key | **SURVIVED** | audit-20 K01–K09 |
| K06 | `include` not in the key | **SURVIVED** | audit-20 K01–K09 |
| K07 | `languages` not in the key | **SURVIVED** | audit-20 K01–K09 |
| K08 | `maxBytes` not in the key | **SURVIVED** | audit-20 K01–K09 |
| K09 | `root` not resolved (two spellings never join) | **SURVIVED** | audit-20 K01–K09 |
| J01 | No joining | killed | `mcp/server` parallel no-op calls |
| J02 | A started run stays joinable | killed | `audit-13` A13-03 |
| J03 | A fresh `pending` map per call | killed | `mcp/server` parallel no-op calls |
| Q01–Q05, Q07 | AUDIT-16 queue mutants, adapted | all killed | `audit-16` Q-tests, `audit-17` SG34 join |

### SG50 `carryEdges` (`indexer.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| C01 | `carry?.()` dropped | killed | `audit-17` A17-03 |
| C02 | Carry key without the kind | **SURVIVED** | audit-20 C02 |
| C03 | Carry key by `name`, not `qualified_name` | **SURVIVED** | audit-20 C03 |
| C04 | `.shift()` → `[0]` (every duplicate maps to the first) | **SURVIVED** | audit-20 C04/C06/C07 |
| C05 | Old symbols read after the delete | killed | `mcp/server` |
| C06 | Carried edges lose `weak` | **SURVIVED** | audit-20 C04/C06/C07 |
| C07 | Carried edges lose `meta` | **SURVIVED** | audit-20 C04/C06/C07 (and all four C tests) |
| C08 | Edges into the module symbol carried too (duplicated) | **SURVIVED** | audit-20 C08/C09/C10/C12 |
| C09 | Module symbol deleted on re-parse | killed | `audit-17` A17-03 |
| C10 | A vanished symbol keeps its old id | killed | `audit-1` A1-06 (FK error) |
| C11 | `dst` not remapped | killed | `mcp/server` |
| C12 | Only a vanished `src` drops the edge | killed | `ingest/concurrency` SG50 |
| C13 | Edges from the file not selected | killed | `audit-9` A9-01 |

### SG50 `metered` and SG40 (`server.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| M01 | Reservations ignored | killed | `audit-17` A17-02 |
| M02 | Reservation never released | killed | `mcp/server` reservation test |
| M03 | Prompt not reserved | killed | `mcp/server` reservation test |
| M04 | `max_tokens` not reserved | killed | `audit-17` A17-02 |
| M05 | Usage never recorded | killed | `mcp/server` |
| M06 | Uncapped `max_tokens` sent | killed | `audit-17` A17-02 |
| M07 | Usage charged to the budget as it was at call time | killed | `audit-17` SG40 reload |
| M08 | `reserved += hold` inside `try` | equivalent | |
| R01 | `indexPath` change not detected | killed | `mcp/server` |
| R02 | Spend dropped when the cap changes | killed | `mcp/server` |
| R03 | `ctx.config` not updated | killed | `mcp/server` |
| R04 | `atlas_ask` does not reload | killed | `audit-17` A17-02 |
| R05 | A new client on every call | **SURVIVED** | audit-20 R05/R06 |
| R06 | A failed client creation is cached for good | **SURVIVED** | audit-20 R05/R06 |
| R07 | An old model's late failure clears the current client | **SURVIVED** | audit-20 R07 |
| R08 | Budget replaced only when raised | killed | `audit-17` A17-02 |
| R09 | Model from the startup config | killed | `mcp/server` |
| R10 | `atlas_index` uses the session config | killed | `mcp/server` |

### `BudgetExhaustedError` remedy

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| E01 | Default remedy empty | killed | `audit-15` SG28 |
| E02 | `raise --budget` without `--budget` too | killed | `audit-19` BudgetExhaustedError |
| E03 | Any error under `--budget` rewrapped as a budget error | **SURVIVED** | audit-20 E03 |
| E04 | No remap | killed | `audit-15` SG28 |
| E05 | Remap with `err.message` (doubled text) | killed | `audit-15` SG28 |
| E06 | Message without the remedy | killed | `audit-15` SG28 |

### SG45 migrations (`database.ts`) and stamps (`indexer.ts`)

| ID | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| G01 | `.immediate()` → `.deferred()` | **SURVIVED** | audit-20 G01 |
| G02 | Version not re-read in the transaction | killed | `audit-16` A16-01 |
| G03 | No early return (every open takes the write lock) | killed | `audit-16` A16-01 (also audit-20 G03) |
| G04 | `<=` → `<` (re-apply the applied migration) | killed | `audit-16` A16-01 |
| G05 | `timeout: 0` on the index connection (no busy wait) | **SURVIVED** | audit-20 G05 |
| G06 | Early-return refactor | equivalent | |
| S01 | No run at all counts as current | **SURVIVED** | audit-20 S01 |
| S02 | Unstamped interrupted runs count as unknown after a finished run | killed | `audit-15` SG33 |
| S03 | Stamps ignored once a run has finished | **SURVIVED** | audit-20 S03 |
| S04 | A16-05 path (prev version always a writer) | killed | `audit-16` A16-05 |
| S05 | No stamp at run start | killed | `audit-19` A19-05 |
| S06 | Non-numeric stamp read as the current version | **SURVIVED*** | audit-20 S06/S07 |
| S07 | Unparseable `stats_json` read as the current version | **SURVIVED** | audit-20 S06/S07 |
| S08 | `COALESCE(MAX(id), 0)` → `MAX(id)` (AUDIT-16 R04) | killed | `audit-16` A16-05 |
| S09 | "A run finished" read as "a finished run recorded a state" | **SURVIVED** | audit-20 S09 |

\* S06's first run was "killed" by the SG32 two-process test failing with `atlas: database is locked`. S06 cannot
affect that test (all its stamps are numbers). On re-run it survives. See A20-01.

To reproduce one mutant, for example G01:

```
# in src/core/db/database.ts, replace `.immediate();` with `.deferred();`, then:
npx vitest run                                  # 773 passed: survives
npx vitest run test/audit/audit-20.test.ts      # G01 fails: 'SqliteError: database is locked' was thrown
git checkout -- src/core/db/database.ts
```

## Findings

### Critical

None.

### High

**A20-01: SG45's two guarantees, the write lock and the busy wait, are untested. Reverting either one passes all 773
tests. The SG32 cross-process test also failed once with a new error, `atlas: database is locked`.** High.
- Class: untested core guarantee (G01, G05), plus an unexplained flaky failure.
- Evidence:
  - **G01.** With `.deferred()` in place of `.immediate()`, `runMigrations` reads the version inside a read
    transaction. A second process can then migrate and commit before the first one writes, and the first one's
    write fails at once with `SQLITE_BUSY` ("database is locked"). The busy handler does not run for a stale WAL
    snapshot. This is the A16-01 race with a different message. The A16-01 test does not catch it: it races the
    read outside the transaction, and the re-read inside sees the other process's migrations.
  - **G05.** SG45 says the transaction waits "on the busy timeout". That timeout is better-sqlite3's implicit
    default of 5 s. With `timeout: 0`, a process that opens a fresh index while another process holds the write lock
    fails at once. Nothing tests it.
  - Today only the flaky two-process test (`test/ingest/concurrency.test.ts`) could catch either mutant, and only
    by chance.
  - **The flake.** Across 92 full-suite runs (79 mutants, 1 re-run, 12 AUDIT-16 mutants), the SG32 test failed once,
    on a mutant that cannot affect it (S06). The first process `a` exited 1 with `atlas: database is locked` after
    about 3.6 s. That is too soon for a 5 s busy wait, so it is a `SQLITE_BUSY` returned without waiting, the same
    class as G01. I could not reproduce it:
    - 15 runs of the test with the full suite running alongside for load;
    - 30 runs, three at a time;
    - 40 pairs of `atlas index` CLIs started together on a fresh 46-file copy;
    - 60 processes opening one fresh index at the same millisecond (6 at a time).

    It is not the A16-01 signature (`UNIQUE constraint failed: _migrations.version`), which no run showed. The CLI
    prints only the message, so I could not tell which statement failed.
- Repro: `G01` and `G05` in `audit-20.test.ts` (plain `it`):
  - `G01` makes a second connection (`timeout: 0`) try to migrate the file while connection A re-reads the version
    inside its transaction. A must already hold the write lock: B is refused with `SQLITE_BUSY` and A finishes. On
    the G01 mutant, A throws `database is locked`.
  - `G05` has a child process hold `BEGIN IMMEDIATE` for 400 ms. `openDatabase` on the fresh file waits and
    migrates.
  - `G03` (opening a migrated index takes no write lock and never waits behind a writer) pins the early return,
    which A16-01 now catches only through its read hook.
- Should exist: SG65 (proposed). Move these three tests into `test/db/`. Make the CLI's error output say which
  statement got `SQLITE_BUSY` (behind a debug flag, or on non-zero exit), and run the SG32 test 50 times under load
  to find and fix the source of `database is locked`.

### Medium

**A20-02: Nothing tests how often an index run yields. All nine SG34 yield mutants survive, including
`YIELD_MS = 60_000` and removing the yield from the parse loop.** Medium.
- Class: untested guarantee (Y01–Y09).
- Evidence:
  - SG34 promises a yield "at least every ~50 ms" and between phases. The only test is the MCP ping and search
    "before the queue drains" (`mcp/server`). It passes as long as some yield happens anywhere in a run, for example
    between phases or before a queued run starts.
  - With Y01 or Y02, each run's parse loop is one blocking block again. That is A14-01 for every run, though no
    longer for the whole queue: a forced re-index of a got-sized repo blocks MCP for seconds, and a 10k-file repo for
    tens of seconds.
  - Y04 makes the loop yield after every file, a cost with no test either.
  - Y03 and Y05–Y08 remove the phase yields. A small run then never yields.
- Repro (plain `it`):
  - `Y01/Y02/Y04`: a forced run over 300 files. A 5 ms interval fires at least twice during the parse loop, and
    fewer than 100 event-loop turns happen in it. Measured: 16 turns in 900 ms. Under Y04: 295.
  - `Y03`: a one-file run gives at least 4 event-loop turns (queue start, walk, parse loop, embed). Measured: exactly
    4. Each phase mutant gives 3.

**A20-03: `carryEdges` is tested only on symbols with distinct names, so six of its thirteen mutants survive.**
Medium.
- Class: untested data-integrity rule (C02, C03, C04, C06, C07, C08).
- Evidence:
  - SG50 re-points a re-parsed file's edges at its new symbols "with the same kind and name (by occurrence)". The
    product test (`ingest/concurrency` SG50) and A17-03 use files whose symbols all have different names.
  - Untested, therefore:
    - the kind in the key: an `interface Shape` and a `function Shape` that swap places hand the function's calls to
      the interface (C02);
    - the qualified name in the key: `A.run` and `B.run` in reordered classes swap edges (C03);
    - occurrence order: duplicate Python `def f` move their calls to the first `f` (C04);
    - `weak` and `meta` carried as they are (C06, C07);
    - edges into the kept module symbol (`import * as nb`) duplicated (C08).
  - Readers at an SG34 yield (MCP, the dashboard, other processes) see these wrong edges until the resolve replaces
    them, or until the next run if this one is interrupted.
- Repro: `C02`, `C03`, `C04/C06/C07`, `C08/C09/C10/C12` (plain `it`). Each kills the run before the resolve and
  compares the graph a reader sees with the expected carry.

**A20-04: A queued run is joined by key, but only `force` and `onFile` in that key are tested. A config edit between
queued `atlas_index` calls is not.** Medium.
- Class: untested guarantee (K03–K09).
- Evidence:
  - `runKind` keys a run by the resolved root, `force`, `skipEmbeddings`, `exclude`, `include`, `languages` and
    `maxBytes`. Dropping any of the last six from the key passes all 773 tests.
  - With K05–K08, an `atlas_index` call made after an edit to `exclude`, `include`, `languages` or `maxFileBytes`
    joins a run already queued with the old options. It returns that run's stats, and the edit takes effect only on
    some later call. That breaks SG40's "each call reads the current config".
  - With K04, a programmatic `indexRepo` on another root that shares the DB returns the other root's stats.
- Repro: `K01–K09` (plain `it`). Each option variant queued behind a pending run gets its own run, the same variant
  twice shares one, and a respelled root (`root/./`) joins.

### Low

**A20-05: How unfinished-run stamps are read is half tested.** Low.
- S01: an index with files and no `runs` rows is re-parsed as an upgrade.
- S03: an interrupted run stamped by another extractor after a finished run forces a re-parse.
- S06/S07: an unreadable stamp counts as an unknown writer. `indexer.ts:175-176` is uncovered.
- S09: a finished run with no recorded state still counts as finished.

All four survive. Only the A16-05 path (S04, S08) and unstamped runs (S02) are pinned. Each case decides whether
rows written by another extractor are kept.
- Repro: `S01`, `S03`, `S06/S07`, `S09` (plain `it`).

**A20-06: The MCP client cache is untested.** Low.
- R05: a new Anthropic client on every call.
- R06: a failed client creation cached for the session.
- R07: an old model's late failure clears the current model's client.

All three survive. In production R06 needs a failure that a retry would fix (the key comes from the environment).
R05 costs a client, and its connection pool, per call.
- Repro: `R05/R06`, `R07` (plain `it`), with `createAnthropicClient` replaced by a counting stand-in.

**A20-07: The `docs --budget` remap catches every error, and only an audit test covers it.** Low.
- E03: if the `instanceof BudgetExhaustedError` check is dropped, an API error under `--budget` becomes
  `token budget exhausted: undefined; raise --budget`. This survives.
- `docsCmd.ts:84` is covered only by `test/audit/` (audit-19).
- Repro: `E03` (plain `it`): a 401 from the client under `--budget 50000` is reported as itself.

**A20-08: Carry-overs from AUDIT-16 and AUDIT-12.** Low.
- A16-06..A16-09 are pinned, but only by `test/audit/`. All 12 of their mutants (L02, L03, L04, L07, R03, R05, P02,
  W08, Y06, Y07, I11, I12) are still killed by `audit-16.test.ts`. All 12 survive the 538 tests outside
  `test/audit/`.
- A16-10 / A12-07 (`extends: "./base"` prefers a directory): still open. Its `it.fails` still fails.
- A12-11 is still open:
  - the stale `it.todo` at `audit-8.test.ts:290`;
  - the audit-only ranges, which are now `indexCmd.ts:49,51`, `indexer.ts:358-361`, `walker.ts:67-68` and, new,
    `docsCmd.ts:84`.

## Re-verified (AUDIT-16)

| Finding | Status | Evidence |
| --- | --- | --- |
| A16-01 migration race | fixed (SG45) | A16-01 is a plain `it` and kills G02, G03 and G04; G01 and G05 survive (A20-01) |
| A16-02 lock wait blocking/polling | pinned (audit only) | L04, L07 killed by audit-16; survive without `test/audit` |
| A16-03 old vectors on re-parse | pinned (audit only) | P02 killed by audit-16; survives without `test/audit` |
| A16-04 queue key, in-memory DBs | pinned | Q01–Q05, Q07 killed; Q05 now by `audit-17` SG34 join, not A14-01 |
| A16-05 interrupted first index | fixed (SG45) | A16-05 is a plain `it` and kills S04 and S08 |
| A16-06 lock error paths | pinned (audit only) | L02, L03 killed by audit-16 only |
| A16-07 `resolveReason` precedence | pinned (audit only) | R03, R05 killed by audit-16 only |
| A16-08 unreadable `.gitignore` | pinned (audit only) | W08 killed by audit-16 only |
| A16-09 small payloads | pinned (audit only) | Y06, Y07, I11, I12 killed by audit-16 only |
| A16-10 AUDIT-12 carry-overs | **open** | A20-08 |
| A12-07 `extends` directory first | **open** | `it.fails` still fails |
| A12-11 leftovers | **open** | A20-08 |

## No finding

- **SG50 reservations (`metered`).** All seven non-equivalent mutants are killed by `mcp/server` and `audit-17`
  A17-02/SG40: reserve, release, prompt, `max_tokens`, record, cap, and which budget is charged.
- **SG40 reload.** All ten `reloadConfig` and handler mutants are killed. Only the client cache (A20-06) is open.
- **Budget messages.** Five of six remedy mutants are killed by `audit-15` and `audit-19`.
- **Probes that found no defect:**
  - opening a migrated index while another process holds a 7 s write transaction returns in 2 ms;
  - 60 racing openers of one fresh file all succeed.

## Verification

On `234a9ce` plus `AUDIT-20.md`, `test/audit/audit-20.test.ts` and the PLAN rows, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npm run typecheck` | pass | 11.3 s |
| `npm run lint` | pass | 5.5 s |
| `npm test` | 80 files, 791 passed, 1 todo | 48.6 s |
| `npm run test:coverage` (base) | 79 files, 773 passed, 1 todo; thresholds pass | 53.6 s |
