# AUDIT-19: API and SDK consistency, round 5

This audit checks that the changes since AUDIT-15 behave the same way on the CLI, the dashboard HTTP API
(`atlas serve`) and the MCP tools, and that they match the README. The changes are:
- SG34: index runs yield, and calls queued together share one run;
- SG40: MCP calls re-read `.atlas/config.json`;
- SG50: the graph stays whole during a run, and MCP LLM calls reserve their maximum;
- SG45: migrations run under `BEGIN IMMEDIATE`, and runs are stamped with their extractor version;
- `BudgetExhaustedError` and its remedy text.

Base: `c426cd1` (SG45 merged) on `claude/atlas-audit-19`. The auditor wrote none of this code. The SDKs are
`@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1. Node 22.22.

**Method.** I copied `fixtures/sample` (plus up to 300 generated `gen<i>.ts` files) into scratch directories and drove
them in four ways:
- through the CLI, in-process, reading every output and exit code;
- through `startServer` on a read-only connection (`/api/*` with fetch);
- through the MCP tools, both through the handlers and through the stock SDK `Client` over `InMemoryTransport`;
- through a fake Messages endpoint set with `ANTHROPIC_BASE_URL`, which records each `max_tokens` and returns chosen
  `usage`, so no tokens are spent.

I did the following:
- issued parallel `atlas_index` and `atlas_ask` calls;
- edited the config between calls (invalid `tokenBudget`, moved `indexPath`, unknown `embeddingModel`);
- held `<db>.lock` from a second connection;
- read every surface at each event-loop turn of a running `atlas_index {force: true}`.

Repros live in `test/audit/audit-19.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it`
and confirmed that it fails on its stated assertion, not on a harness error (the messages are listed under each
finding). The six plain `it` tests pin what the audit found consistent.

**Totals:** 0 critical, 0 high, 3 medium, 2 low. Fixed since AUDIT-15, and pinned: A15-01 (SG40) and A15-03.
A15-02 is mitigated but still open. Still open: A15-02, A15-04, A15-05, A15-06 and A15-07; A11-04 and A11-06..A11-11;
A7-06, A7-07, A7-09 and A7-11; A3-11 and A3-13.

## Findings

### Critical

None found.

### High

None found.

### Medium

**A19-01: when parallel `atlas_ask` calls are refused because of in-flight reservations, the refusal reports the
reservations as spent and gives a remedy that is not needed. Parallel calls also get a smaller `max_tokens` than
the same call made alone or on the CLI.** Medium.
- **Evidence:** since SG50, the MCP `metered` client works out what is left as `cap − spent − reserved`. Each
  in-flight call holds its prompt estimate plus its `max_tokens`, so the first call holds up to about 16.7k tokens.
  It then calls `affordableMaxTokens` on that synthetic budget. Results:
  - **Offline, `tokenBudget: 20000`, three parallel `atlas_ask` calls:** two succeed. The third fails with
    `token budget exhausted: a call needs ~1757 tokens (~733 prompt + 1024 output), 0 of 20000 left; raise tokenBudget`.
    After the other two settle, `ctx.budget` shows `spent 1246, remaining 18754`, and both successful results say
    `budgetRemaining: 18754`. So in the same moment, one surface reports two different "remaining" values.
  - **Fake endpoint, `tokenBudget: 40000`, three parallel calls:** the bodies carry `max_tokens` 16000, 16000 and
    5801. A sequential `atlas_ask` and CLI `ask` send 16000 (pinned). With a real model, a 5.8k cap can end in
    `stop_reason: max_tokens`, which `ask` reports as `no answer: … incomplete response`. A call the CLI would answer
    then fails on MCP, only because another call was in flight.
  - **CLI:** two parallel `atlas ask` processes each have their own budget, and both succeed.

  The remedy "raise tokenBudget" does work, but retrying after the in-flight calls finish works with no config
  change. The message does not say that anything is reserved. The README says only that `atlas_ask` "spends tokens
  within `tokenBudget` per server session" (A19-04). MCP clients such as Claude Code issue tool calls in parallel.
  With the default 200k budget, refusals start once about 2 × 17k tokens or less remain, or immediately for any
  `tokenBudget` below about 35k.
- **Impact:** an agent is told to raise a budget it has barely used. Answers on MCP depend on concurrency, while
  the same question on the CLI does not.
- **Test:** `A19-01`. As a plain `it`, it fails with
  `expected 'token budget exhausted: a call needs …' not to match / 0 of 20000 left; raise tokenBudget$/`.
  The plain `it` `SG50: one atlas_ask at a time sends the max_tokens the CLI sends; …` pins the 16000/16000/smaller
  pattern.
- **Repro:** set `tokenBudget: 20000`, then make three parallel `handleAskTool(ctx, {question: 'circle area'})`
  calls in offline mode.
- **Location:** `src/mcp/server.ts:83-100` (`metered`: reservations folded into `left`),
  `src/core/synth/budget.ts:68-80` (message and remedy), `src/mcp/server.ts:299` (`budgetRemaining` ignores
  reservations).

**A19-02: SG40 reloads the config in 2 of the 7 MCP tools. The same edit therefore errors on some tools and is
silently ignored by others, and the dashboard never reloads it.** Medium.
- **Evidence:** `atlas_ask` and `atlas_index` call `reloadConfig`. `atlas_search` uses `ctx.config` as of the last
  reload. `atlas_symbol`, `atlas_graph`, `atlas_drift` and `atlas_docs` use the DB and `docsDir` opened at startup.
  `atlas serve` reads the config once, in `startServer`. The CLI reads it on every command. On one indexed project:

  | Edit | CLI `search` | `atlas_ask` / `atlas_index` | `atlas_search` / `atlas_graph` | running `/api/*` |
  | --- | --- | --- | --- | --- |
  | `tokenBudget: -5` | `Invalid config at …` (exit 1) | same message | answers | answers |
  | `indexPath: '.atlas/other.db'` | `no index at …other.db` | `indexPath changed … restart the server …` | answers from the old `index.db` | answers from the old file |
  | `embeddingModel: 'nope'` | `Unknown embeddingModel "nope"` | same | answers, until an `atlas_ask` or `atlas_index` reloads `ctx.config`; then fails | answers |

  After an `indexPath` move followed by `atlas index` on the CLI, the CLI reads `other.db`. The MCP read tools keep
  serving `index.db` with no hint, and `atlas_index` refuses to refresh that file, so it is frozen for the rest of
  the session. In the third row, `atlas_search` starts failing because of an unrelated `atlas_ask`. `DECISIONS.md`
  (SG40) records "Read tools keep serving the open DB". The README says nothing (A19-04).
- **Impact:** one config edit gives three different behaviours in one server. Read tools can answer from an index
  that nothing updates any more, without telling the agent.
- **Test:** `A19-02`. As a plain `it`, it fails with
  `promise resolved "[ { name: 'Drawable.area', …(7) } ]" instead of rejecting`.
- **Location:** `src/mcp/server.ts:124-138` (`reloadConfig`), `:149` and `:283` (its only callers), `:165`
  (`atlas_search` reads `ctx.config`), `src/web/server.ts:73-77`.

**A19-03: during `atlas_index {force: true}` (or an extractor upgrade), search on every surface progressively loses
its vectors. SG50 keeps only the graph whole.** Medium.
- **Evidence:** the per-file transaction deletes a re-parsed file's embeddings (`indexer.ts:370`), and vectors come
  back only in the embed phase. Since SG34 the run yields between files, so MCP reads now see this too; HTTP and
  CLI readers in other processes always could. Results:
  - **Sample + 20 generated files:** `embeddings_meta` drops from 80 to **0** at the yield after the parse loop.
  - **300 generated files:** the count goes 920 → 501 → 225 → 0. Over the same turns, the MCP `atlas_search`
    results for `run K150 method` go from `K150` first, to `K239.run, K241.run, K269.run`, to `K39.run, …`, and
    back once the run finishes. `/api/search` changes as well.
  - **Unchanged throughout (SG50 holds, pinned):** counts, graph edges, drift totals, `/api/stats` and the last
    finished run's stats.

  Lexical (FTS) matches by name still work, so the effect is a silent drop in semantic recall rather than empty
  results. A first index after an `EXTRACTOR_VERSION` bump re-parses every file, so on a large repo the window
  lasts tens of seconds.
- **Impact:** an agent searching during a re-index gets worse results with no signal. This is the vector-index
  counterpart of A17-03.
- **Test:** `A19-03`. As a plain `it`, it fails with `expected +0 to be 80`.
- **Location:** `src/core/ingest/indexer.ts:370` (delete) and `:485-487` (re-embed only after the resolve).

### Low

**A19-04: the README does not describe SG34, SG40 or SG50.** Low.
- **Evidence:** `README.md` is byte-identical to its AUDIT-15 state (`git diff 303abb1 c426cd1 -- README.md` is
  empty). The README never mentions any of the following:
  - `atlas_ask` and `atlas_index` re-read the config, and a raised `tokenBudget` takes effect mid-session while the
    spend carries over;
  - a moved `indexPath` needs a restart, and the read tools keep serving the old file;
  - parallel `atlas_ask` calls reserve their maximum, and may be refused or capped (A19-01);
  - `atlas_index` calls with the same options, queued together, share one run and one result.

  Line 185 ("`atlas_ask` spends tokens within `tokenBudget` per server session") is still true but incomplete.
  Everything above is documented only in `DECISIONS.md`. This continues A15-07.
- **Test:** `A19-04` (`expected '# Atlas\n\n> Local-first codebase int…' to match /restart/`).
- **Location:** `README.md` §Real Claude-backed synthesis (lines 114-120) and §MCP server (lines 179-200).

**A19-05: SG45 changed what `getLastRun` returns for an unfinished run.** Low.
- **Evidence:** `runIndex` now writes `stats_json = {"state":{"extractorVersion":3}}` right after `startRun`. While
  a run is in progress, `getLastRun` (exported from `core/db`, part of the "@atlas/core" surface) returns
  `finished_at: null` with that partial `stats_json`, where it used to return `null`. A caller that treats a non-null
  `stats_json` as "finished", or reads `filesIndexed` from it, now gets a different shape.

  No CLI, HTTP or MCP surface reads `runs`: there is no `status` command, and drift and the dashboard never query
  it. The only other reader, `getLastRunStats`, filters on `finished_at IS NOT NULL`. So no user-visible output
  changed (pinned: drift, `/api/stats` and the last finished stats are stable during a run). `getLastRun` has no
  caller in `src/`.
- **Test:** `A19-05` (`expected '{"state":{"extractorVersion":3}}' to be null`).
- **Location:** `src/core/ingest/indexer.ts:255-259`, `src/core/db/repo.ts:378-380`.

## Scope checks

- **SG34 (coalesced index calls):** consistent; joined callers get correct stats.
  - Over the SDK client, three `atlas_index {}` calls issued together after one file changed return deep-equal
    stats (`filesIndexed: 1`, `resolveReason: 'files changed'`), from one run.
  - A `{force: true}` call in the same batch does not join. It reports `filesIndexed: 4, 'forced'`.
  - The `runs` table grows by exactly 2.
  - A CLI `atlas index` afterwards (another process, which never joins) reports `(graph unchanged)`.
  - Joined handler callers receive the same object (`===`). That is harmless over MCP, where it is serialised, but
    `indexRepo` callers in-process share it.
  - `durationMs` excludes queue wait on both surfaces, as before (A15-02).
- **SG40 (config reload):** see A19-02 for which tools reload. Where a reload happens, the messages are identical to
  the CLI's (`Invalid config at <path>:\n  - tokenBudget: …`, `Unknown embeddingModel …`). A failed reload leaves
  `ctx.config` and the budget unchanged. The `indexPath` message is the same from `atlas_ask` and `atlas_index`. A
  raised `tokenBudget` takes effect on the next `atlas_ask` without restarting (A15-01 fixed, pinned).
- **SG50 (reservations):** a single call sends the same `max_tokens` as the CLI, and parallel calls never overspend
  (A17-02 stays fixed). The refusal text is the shared `token budget exhausted: …` text (A19-01 covers its numbers).
  - **While a forced `atlas_index` runs:** the MCP graph, drift totals, `/api/stats` (other connection) and the
    last finished run's stats are identical to before at every yield (pinned).
  - **Search:** not identical (A19-03).
  - **CLI:** readers in another process see the same committed state as HTTP.
- **SG45 (migrations, `stats_json` stamping):** no surface reads in-progress runs, and nothing changed shape on
  the CLI, HTTP or MCP (A19-05 covers the helper). The migration change has no API surface: `serve` opens the DB
  read-only and never migrates, as before.
- **`BudgetExhaustedError` remedy text:**

  | Surface | Remedy |
  | --- | --- |
  | `docs --budget N` | `raise --budget` (A15-03 fixed) |
  | `docs` | `raise tokenBudget` |
  | `ask` | `raise tokenBudget` |
  | `atlas_ask` | `raise tokenBudget` |

  The detail (`a call needs ~N tokens (~P prompt + 1024 output), R of C left`) is the same on all of them (pinned).
  It is wrong only under in-flight reservations (A19-01). A `docs` run that is cut short still gives no cause
  without `-v` (A15-04).

## Re-verified

All AUDIT-3, AUDIT-7, AUDIT-11 and AUDIT-15 tests pass on this base. Every `it.fails` among them still fails as
intended.
- **A15-01 fixed (SG40)** and **A15-03 fixed**: pinned above and in `audit-15.test.ts`.
- **A15-02 open, mitigated:** `atlas_index` still exceeds a short client timeout while another process holds the
  lock, and it sends no progress. However, a queued run stops being joinable only once it starts waiting on the lock
  (`indexer.ts:150-151`). So five retries made while the lock is held now produce two runs, not five (pinned).
- **Still open (their `it.fails` still fail):**
  - A15-04: a cut-short `docs` gives no cause.
  - A15-05: `--force` hides the extractor upgrade.
  - A15-06: actual usage can still exceed the cap. The prompt estimate is still ~3 chars/token, and SG50 settles to
    the real usage after the fact.
  - A15-07: the README does not mention the lock, and lists the wrong commands for an empty index.
  - A11-04, A11-06, A11-07, A11-08, A11-09, A11-10, A11-11.
  - A7-06: unknown MCP arguments are accepted.
  - A7-09: `/api/doc/file/1abc` works.
  - A3-11: search hit shapes differ between surfaces.
  - A3-13: `index --cwd`.
- **Still open (checked by hand):**
  - A7-07: `atlas index --json` gives `error: unknown option '--json'`.
  - A7-11: `atlas init` still prints "(phase 2)".
