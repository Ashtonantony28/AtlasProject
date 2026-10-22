# AUDIT-23: API and SDK consistency, round 6

This audit checks that the changes since AUDIT-19 behave the same way on the CLI, the dashboard HTTP API
(`atlas serve`), the MCP tools and the `@atlas/core` exports, and that they match the README. The changes are:
- SG55: the refusal from the MCP `metered` client now names in-flight reservations (`… N tokens reserved by calls
  in progress; retry when they finish`);
- SG65: a fresh index is created in WAL mode, `nameBusy` is exported from `core/db` (and so from
  `src/core/index.ts`), and an `SQLITE_BUSY` error names its step (`journal mode`, `migrations`, `run stamp`,
  `index write`, `graph resolve`, `embeddings write`);
- SG50 reservations and SG40 config reloads, re-checked against the above.

Base: `b945516` (SG65 merged) on `claude/atlas-audit-23`. The auditor wrote none of this code. The SDKs are
`@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1, with better-sqlite3 11.10.0. Node 22.22.

**Method.** I copied `fixtures/sample` (and, for one check, a generated 10,001-file repo) into scratch directories
and drove them in five ways:
- through the real CLI (`tsx src/cli/index.ts`) as separate processes, reading every output and exit code, and
  in-process through `buildProgram()`;
- through `atlas mcp --offline` over stdio with the stock SDK `Client` + `StdioClientTransport`, and through
  `createAtlasMcpServer` over `InMemoryTransport`;
- through `startServer` on a read-only connection (`/api/*` with fetch);
- through a fake Messages endpoint set with `ANTHROPIC_BASE_URL`, which records each `max_tokens` and returns
  chosen `usage` and `stop_reason`, so no tokens are spent;
- with another process holding the index's SQLite write lock (`BEGIN IMMEDIATE` on `index.db`, not the SG32
  `index.db.lock`), either once for longer than the 5 s busy timeout or for 1 s at a time with short gaps, as a
  concurrent `atlas docs` does.

Repros live in `test/audit/audit-23.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it`
and confirmed that it fails on its stated assertion, not on a harness error (the messages are listed under each
finding). The timing-dependent ones (A23-01, A23-03, A23-04) failed as intended in 5 of 5 repeated runs. The three
plain `it` tests pin what the audit found consistent.

**Totals:** 0 critical, 1 high, 2 medium, 2 low. Fixed since AUDIT-19, and pinned: A19-01's refusal text (SG55).
Its other half, the smaller `max_tokens` of a parallel call, is still open as A23-03. Still open: A15-02
(mitigated), A15-04, A15-05, A15-06, A15-07, A19-02, A19-03, A19-04 and A19-05; A11-04 and A11-06..A11-11; A7-06,
A7-07, A7-09 and A7-11; A3-11 and A3-13.

## Findings

### Critical

None found.

### High

**A23-01: an index run fails at once, without the busy wait, when another process writes the index. SG65's
5 s busy timeout covers only statements that do not read first, so a concurrent `atlas docs` makes
`atlas index` and `atlas_index` fail with `index write: database is locked`.** High.
- **Evidence:** every write transaction in an index run is `db.transaction(fn)()`, a deferred `BEGIN`:
  - the per-file transaction (`indexer.ts:377`);
  - the retry and prune transactions (`:450`, `:457`);
  - the resolve (`resolver.ts:73`);
  - each embedding batch (`embedAll.ts:77`).

  Each one reads first. For example, the per-file transaction starts with `getFileByPath` and `carryEdges`. In WAL
  mode, a read transaction that tries to become a write transaction while another connection holds the write lock
  gets `SQLITE_BUSY` at once: SQLite does not call the busy handler there, because waiting could deadlock. Only
  `runMigrations` uses `.immediate()`. Runs of `atlas index` exclude each other through `<db>.lock` (SG32), but
  `atlas docs` writes the same file without that lock. Results:
  - **Writer holding the lock for 1 s at a time, with 20–30 ms gaps:** `atlas index --force` exits 1 after
    1.67 s with `atlas: index write: database is locked`. `atlas_index {force: true}` over stdio returns `isError`
    after 151 ms with the same text. Each hold is a fifth of the busy timeout. `atlas docs --offline --force`
    under the same writer waits and succeeds in 4.7 s, because its upserts are single statements.
  - **Real processes, 10,001-file repo:** I started `atlas index --force`, and 4 s later `atlas docs --offline
    --force --budget 100000000`. In both of 2 runs, `docs` exited 0 and `index` exited 1 with
    `atlas: index write: database is locked`.
  - **Effect of a failed run:** it leaves an unfinished `runs` row, so the next run re-resolves (SG33). On a large
    repo, the forced or upgrade re-parse has to be redone from the start.

  SG65's PLAN row and the `BUSY_TIMEOUT_MS` comment ("How long a statement waits for another connection's lock")
  both say statements wait 5 s. The `locking.test.ts` tests pin that for the migration path only. The message now
  names a step, so the failure looks like a timeout, but there was no wait at all.
- **Impact:** an agent's `atlas_index`, or a user's `atlas index`, fails whenever `atlas docs` is writing at the
  same moment, even for a few milliseconds. This is the documented editor workflow: `atlas mcp` runs while the user
  runs `atlas docs` in a terminal. Retrying can fail again for as long as `docs` runs. The CLI and MCP agree with
  each other, but neither waits as SG65 says.
- **Test:** `A23-01`. As a plain `it`, it fails with `expected { code: 1, …(1) } to deeply equal { code: +0, err: '' }`
  (`err` is `index write: database is locked`).
- **Repro:** another process loops `BEGIN IMMEDIATE`, then holds for 1000 ms, then `COMMIT` and waits 20 ms, on
  `.atlas/index.db`. Meanwhile, run `atlas index --force <root>`.
- **Location:** `src/core/ingest/indexer.ts:377,450,457`, `src/core/graph/resolver.ts:73`,
  `src/core/vector/embedAll.ts:77` (deferred transactions), `src/core/db/database.ts:9-10` (the timeout they
  never reach).

### Medium

**A23-02: `SQLITE_BUSY` errors give no cause and no remedy, and `atlas docs` does not name its step.** Medium.
- **Evidence:** I had another process hold the write lock for 14 s:
  - `atlas docs --offline` waits 5 s, then exits 1 with `atlas: database is locked`.
  - `atlas index` exits 1 with `atlas: run stamp: database is locked`.
  - `atlas_index` returns `isError` with `run stamp: database is locked`, both over the SDK and over stdio
    (5,056 ms).

  The step names (`run stamp`, `index write`, `graph resolve`, `embeddings write`) are internal phase names. None
  of them says that another process is writing `.atlas/index.db`, or that the call can be retried when it
  finishes. Compare the SG32 lock error, which names the cause: `another atlas index run is writing <db>; gave up
  after 600s`. It is the only other lock error.
  - **Unnamed writes:** `docsCmd.ts` and `synthesizeDocs`/`importPersistedDocs` never call `nameBusy`, so the same
    lock gives a bare message on `docs`.
  - **Wrong label in some cases:** under A23-01, the "named" error appears without any wait, so its words are
    misleading as well as bare.
  - **Not affected (pinned):** reads. `search`, `atlas_search` and `/api/stats` answer in under 2 s while the lock
    is held.
- **Impact:** a user or agent cannot tell a lock conflict from a broken index, and nothing says what to do. In
  the same situation, `docs` and `index` word the error differently.
- **Test:** `A23-02` (`expected 'database is locked' to match /^[a-z ]+: database is locked/`). The test also
  requires a remedy on both commands.
- **Location:** `src/core/db/database.ts:93-99` (`nameBusy` adds only the step), `src/core/ingest/indexer.ts:150-161`,
  `src/cli/commands/docsCmd.ts:63-95` (not named), `src/cli/index.ts:7`.

**A23-03: A19-01 is only half fixed. A parallel `atlas_ask` still gets a smaller `max_tokens` because of
reservations, and when that cuts the answer off, the error does not mention reservations, while the same call made
alone is answered.** Medium.
- **Evidence:** fake endpoint, `tokenBudget: 40000`, a model whose answer needs about 7k output tokens (it returns
  `stop_reason: max_tokens` below 8k). I made three parallel `atlas_ask` calls:
  - the bodies carry `max_tokens` 16000, 16000 and 5801;
  - the third call fails with `no answer: the model returned an incomplete response (stop_reason max_tokens)`;
  - the same question asked right afterwards gets 16000 and is answered;
  - CLI `ask` always sends 16000 (pinned in AUDIT-19).

  SG55 explains a reservation *refusal*, but not a reservation *cap*. The capped call's error carries no remedy,
  and an agent that reads "incomplete response" has no reason to retry. Whether an answer arrives depends on
  concurrency on MCP only.
- **Impact:** MCP answers depend on how many calls are in flight, with an error that does not name the cause.
- **Test:** `A23-03` (`expected 'no answer: the model returned an inco…' to match /reserv/`).
- **Location:** `src/mcp/server.ts:87-104` (`metered` caps `maxTokens` to what reservations leave),
  `src/core/qa/ask.ts:74-75` (the error).

### Low

**A23-04: the SG55 remedy "retry when they finish" can be false.** Low.
- **Evidence:** `metered` decides between the two remedies by checking the call against `ctx.budget`, which counts
  only what has been spent. The in-flight calls may then spend up to their whole reservation. With
  `tokenBudget: 35000` and a model that uses all the output it is given, three parallel calls go like this:
  1. Two calls succeed. The third is refused with
     `… 1534 of 35000 left, 33466 tokens reserved by calls in progress; retry when they finish`.
  2. The retry, after both have settled, is refused with
     `… 1600 of 35000 left; raise tokenBudget`.
- **Impact:** an agent follows the remedy, fails, and only then learns the real one. With real models, which rarely
  use their whole `max_tokens`, this is uncommon.
- **Test:** `A23-04`
  (`promise rejected "Error: token budget exhausted: … 1600 of 35000 left; raise tokenBudget" instead of resolving`).
- **Location:** `src/mcp/server.ts:94-99`.

**A23-05: the README and `DECISIONS.md` do not describe SG55 or SG65.** Low.
- **Evidence:**
  - `README.md` is unchanged since AUDIT-19. It never mentions `database is locked`, the 5 s busy timeout, the
    step names, or the `reserved by calls in progress; retry when they finish` refusal.
  - `DECISIONS.md` has no SG55 or SG65 entry. That covers creating the WAL file by linking, `nameBusy` joining
    the public `@atlas/core` surface, and the reservation refusal's remedy, although `CLAUDE.md` §2.7 asks for one
    entry per non-obvious choice.

  This continues A19-04 and A15-07.
- **Test:** `A23-05` (`expected '# Atlas\n\n> Local-first codebase int…' to match /database is locked/`).
- **Location:** `README.md` §Real Claude-backed synthesis (lines 114-120), §Command notes, §MCP server;
  `DECISIONS.md` (after the SG50 entry).

## Scope checks

- **SG65 (named `SQLITE_BUSY`):** consistent across surfaces where the error arises after a real wait.
  - With the lock held for 14 s, CLI `atlas index` (exit 1) and `atlas_index` (`isError`, SDK and stdio) give the
    identical text `run stamp: database is locked` (pinned).
  - Reads never wait. CLI `search`, `atlas_search` and the read-only `/api/stats` answer while the lock is held
    (pinned).
  - `serve` opens the DB read-only and never migrates. `atlas mcp` starting on a migrated index takes no write
    lock (`locking.test.ts`).
  - Gaps: the error has no remedy and `docs` is not named (A23-02); index runs never actually wait (A23-01).
- **`nameBusy` export:** coherent with the rest of `core/db`.
  - `src/core/index.ts` re-exports it, so it is part of the `@atlas/core` surface (pinned: `core.nameBusy ===
    nameBusy`).
  - It changes only errors whose `code` starts with `SQLITE_BUSY`, including `SQLITE_BUSY_SNAPSHOT`. Other errors
    and non-errors are left alone (pinned).
  - It rewrites `message` in place. The `stack` header follows it, because V8 formats the stack lazily. It
    returns `void`, so it cannot be used as `throw nameBusy(err, op)`.
  - It is not idempotent: two calls stack, giving `graph resolve: index write: database is locked`. No path in
    `src/` names an error twice today.
- **SG55 (reservation refusal):** the refusal now names the reservations and a remedy that needs no config change.
  - Offline, `tokenBudget: 20000`, three parallel calls give
    `… 0 of 20000 left, 16xxx tokens reserved by calls in progress; retry when they finish`, and the retry is
    answered (pinned).
  - With nothing in flight, the refusal is the CLI's: `… 0 of 1000 left; raise tokenBudget` on `atlas_ask`,
    `1000 of 1000 left; raise tokenBudget` on `ask` (pinned).
  - Gaps: A23-03 and A23-04.
- **SG50/SG40:** AUDIT-19's pins still pass:
  - joined index calls;
  - one invalid-config message on CLI `search`, `atlas_ask` and `atlas_index`;
  - `raise --budget` on `docs --budget`;
  - a whole graph at every yield;
  - parallel calls that never overspend.

  Still open: A19-02 (only
  `atlas_ask`/`atlas_index` reload) and A19-03 (vectors drop during a forced run). Their `it.fails` still fail.
- **Exit codes and error shapes:** a lock error exits 1 on the CLI, as every other error does. On MCP it is a
  tool `isError`, not a JSON-RPC error. The budget errors keep the shared
  `token budget exhausted: <detail>; <remedy>` shape on every surface.

## Re-verified

All AUDIT-15 and AUDIT-19 tests pass on this base, and every `it.fails` among them still fails as intended.
- **A19-01 refusal text fixed (SG55):** pinned above and in `audit-19.test.ts`. The `max_tokens` half continues
  as A23-03.
- **Still open (their `it.fails` still fail):**
  - A15-02: `atlas_index` still exceeds a short client timeout while the SG32 lock is held. Mitigated: retries
    coalesce into at most two runs.
  - A15-04: a cut-short `docs` gives no cause without `-v`.
  - A15-05: `--force` hides the extractor upgrade.
  - A15-06: actual usage can exceed the cap.
  - A15-07: the README does not mention the index lock, and lists the wrong commands for an empty index.
  - A19-02: only `atlas_ask` and `atlas_index` reload the config.
  - A19-03: a forced re-index empties the vectors until the embed phase.
  - A19-04: the README does not describe SG34, SG40 or SG50.
  - A19-05: `getLastRun` returns an unfinished run with its stamped `stats_json`.
  - A11-04, A11-06..A11-11, A7-06, A7-09, A3-11 and A3-13.
- **Still open (checked by hand):**
  - A7-07: `atlas index --json` is still an unknown option.
  - A7-11: `atlas init` still prints "(phase 2)".
