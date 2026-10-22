# AUDIT-15: API and SDK consistency, round 4

This audit compares every Atlas surface with the others and with the README: the CLI (every command, `--json`
output, exit code and message), the dashboard HTTP API (`atlas serve --port 0`) and `app.js`, the MCP tools served
through the stock SDK client, and the Anthropic client. It focuses on what changed since AUDIT-11:
- SG28: the budget cap, its `token budget exhausted…` message, and `docs` on an empty index;
- SG29: the `atlas_index` queue and config reload/write;
- SG31: destructured symbols on every surface;
- SG32: the cross-process index lock (`<db>.lock`, "gave up after", what MCP and HTTP do while it is held);
- SG33: `resolveReason: 'previous run interrupted'`;
- `EXTRACTOR_VERSION` bump reporting.

Base: `5a9d6c3` (SG31 with SG32 and SG33 merged) on `claude/atlas-audit-15`. The auditor wrote none of this code.
The SDKs are `@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1. Node 22.22.

**Method.** I ran `npm run build`, then copied `fixtures/sample` (plus variants with destructured TS and Python
declarations) into a scratch directory and drove it in four ways:
- through the built CLI, reading every output and exit code;
- through `atlas serve --port 0` with curl;
- through `atlas mcp --offline` with the stock `Client` + `StdioClientTransport`. I listed every tool and called each
  one with bad, unknown, empty and out-of-range arguments. I also called tools while a second process held
  `.atlas/index.db.lock` with `BEGIN EXCLUSIVE`, and across config edits;
- through a fake Messages endpoint set with `ANTHROPIC_BASE_URL`. It records each body and returns chosen `usage`
  and `stop_reason` values, so no tokens are spent.

I simulated interrupted runs by inserting an unfinished `runs` row. I simulated an older extractor by rewriting
`state.extractorVersion` in the last finished run.

Repros live in `test/audit/audit-15.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it`
and confirmed that it fails on its stated assertion, not on a harness error (the messages are listed under each
finding). The seven plain `it` tests pin what the audit found consistent, including the AUDIT-11 fixes.

**Totals:** 0 critical, 1 high, 1 medium, 5 low. AUDIT-11: A11-01, A11-02, A11-03 and A11-05 are fixed and stay
fixed, and A7-08 is fixed (all pinned). Still open: A11-04, A11-06, A11-07, A11-08, A11-09, A11-10 and A11-11
(their `it.fails` still fail), plus A7-06, A7-07, A7-09, A7-11, A3-11 and A3-13.

## Findings

### High

**A15-01: an `atlas mcp` session's token budget and model are fixed at startup. Once the budget is spent,
`atlas_ask` fails for the rest of the session, and the remedy in its error message, "raise tokenBudget", has no
effect.** High.
- **Evidence:** `createMcpContext` builds one `TokenBudget(config.tokenBudget)` and one lazily created client
  (`config.synthModel`) from the config it read at startup. SG29 made `atlas_index` re-read
  `.atlas/config.json` into `ctx.config`, but nothing re-reads `ctx.budget` or the client. Over the stock SDK client
  (offline, `tokenBudget: 4000`):
  1. four `atlas_ask` calls succeed;
  2. I set `tokenBudget: 200000` in the config;
  3. `atlas_index` succeeds and loads the new config;
  4. the next `atlas_ask` fails with
     `token budget exhausted: a call needs ~1757 tokens (~733 prompt + 1024 output), 1508 of 4000 left; raise tokenBudget`.

  The message reports the old cap while `ctx.config.tokenBudget` is 200000. A `synthModel` edit is ignored the same
  way, because the client is cached. So is an `indexPath` edit, because `ctx.db` stays open on the old file while
  `atlas_index` reads the new config. On the CLI the same edit takes effect on the next `ask`.

  The README states the per-session cap, but not that the cap, once spent, can be reset only by restarting the
  server. With the default 200k and a real model, an `ask` on a real repo costs roughly 5–15k tokens (up to 10
  snippets of up to 120 lines, plus output). An editor session that keeps one MCP server all day therefore loses
  `atlas_ask` after a few dozen questions. The error then tells the agent to do something that does not help.
- **Impact:** a surface stops working partway through a normal session. The documented fix fails silently. The
  config that `atlas_index` reports using (SG29) disagrees with the one `atlas_ask` enforces.
- **Test:** `A15-01`. As a plain `it`, the `atlas_ask` after the raise throws
  `token budget exhausted: … 1000 of 1000 left; raise tokenBudget`, even though `ctx.config.tokenBudget` is 200000.
- **Repro:** `tokenBudget: 1000` → `atlas_ask` fails → set `200000` → `atlas_index` → `atlas_ask` still fails with
  `1000 of 1000 left`.
- **Location:** `src/mcp/server.ts:66-90` (budget and client fixed in `createMcpContext`), `:100` (config reloaded
  only into `ctx.config`), `src/core/synth/budget.ts:67` (the remedy text).

### Medium

**A15-02: while another process holds the index lock, `atlas index` waits in silence, and `atlas_index` outlives
the MCP client's request timeout and then runs anyway.** Medium.
- **Evidence:** SG32's lock polls for up to 10 minutes.
  - **CLI:** with a second process holding `index.db.lock` for 6 s, `atlas index` printed nothing for 5.6 s, then
    reported `wrote 0 symbols … in 16ms`. `durationMs` leaves out the wait.
  - **MCP:** the server sends no progress notifications and ignores the request's cancellation signal. With the
    stock client's `timeout: 2000`, `atlas_index` failed with `MCP error -32001: Request timed out`. The abandoned
    run still executed once the lock was released, and it delayed the next `atlas_index` (3,040 ms for a call whose
    own `durationMs` was 2). The SDK's default request timeout is 60 s, so a CLI index of a large repo running
    alongside an agent turns every `atlas_index` into a timeout. Each retry queues another run behind the lock.
  - Neither the "gave up after 600s" message nor the lock file is mentioned in the README (see A15-07).
  - Reads are not affected: `atlas_search`, `atlas_graph` and `/api/*` answer normally while the lock is held
    (pinned).
- **Impact:** an agent cannot tell "another index run is in progress" from a hung server. Retrying makes it worse. A
  CLI user sees a hang with no explanation.
- **Test:** `A15-02`. As a plain `it`, it fails with `McpError: MCP error -32001: Request timed out`.
- **Location:** `src/core/ingest/lock.ts:13-34` (silent poll, no callback), `src/core/ingest/indexer.ts:115-121`,
  `src/mcp/server.ts:262-270` (handler ignores `extra.signal`, sends no progress).

### Low

**A15-03: `docs --budget N` blames the config key.** Low.
- **Evidence:** `atlas docs --offline --budget 1000` exits 1 with `… 1000 of 1000 left; raise tokenBudget`. The cap
  came from the flag, and raising `tokenBudget` in the config has no effect while `--budget` is given.
- **Test:** `A15-03` (`expected 'token budget exhausted: a call needs …' to match /--budget/`).
- **Location:** `src/core/synth/budget.ts:67`, `src/cli/commands/docsCmd.ts:41,72`.

**A15-04: a `docs` run cut short by the budget does not say so unless `--verbose` is given.** Low.
- **Evidence:** `atlas docs --offline --budget 2000` on the sample prints `modules: generated 2, cached 0, skipped 2`
  and `architecture: cached/skipped`, then exits 0. "token budget exhausted" appears only with `-v`, and "skipped"
  appears nowhere else. The README describes this behaviour ("once some docs are written, `docs` skips the rest"),
  but the output does not name the cause. The next `drift` then lists the skipped modules as undocumented.
- **Test:** `A15-04` (`expected 'modules: generated 2, cached 0, skipp…' to match /token budget exhausted/`).
- **Location:** `src/cli/commands/docsCmd.ts:82-88`, `src/core/synth/synthesize.ts:101-104`.

**A15-05: an extractor upgrade is applied but not reported when `--force` is given, and read surfaces never mention
an index written by an older extractor.** Low.
- **Evidence:** with the recorded `extractorVersion` set to 2:
  - `atlas index --force` and `atlas_index {force: true}` re-parse every file and record version 3, but print no
    upgrade line and omit `extractorUpgrade`. The fact is lost for good.
  - Without re-indexing, `search`, `drift` (exit 0, "all public symbols documented"), `atlas_search` and `/api/*`
    serve the v2 index with no hint. For this upgrade that means no destructured symbols.
- **Test:** `A15-05` (`expected undefined to deeply equal { from: 2, to: 3 }`).
- **Location:** `src/core/ingest/indexer.ts:179-180`, `src/core/project.ts:33-35`.

**A15-06: the budget is enforced against a ~3 chars/token prompt estimate, so actual usage can exceed `tokenBudget`,
and no surface reports the overspend.** Low.
- **Evidence:** `affordableMaxTokens` caps `max_tokens` to `remaining − ceil(chars/3)`, and `record()` then adds the
  API's real `usage`. With `tokenBudget: 3000` and a fake endpoint returning `usage {2900 in, 400 out}` (content
  that tokenizes denser than 3 chars/token, such as CJK comments or minified code), one `atlas_ask` spends 3,300
  tokens. `budgetRemaining` then reads 0, not −300. `docs` prints `budget remaining 0` in the same case.
- **Test:** `A15-06` (`expected 3300 to be less than or equal to 3000`).
- **Location:** `src/core/synth/budget.ts:48-52,58-70,80`, `src/core/synth/synthesize.ts:108`.

**A15-07: the README has not caught up with SG28 and SG32.** Low.
- **Evidence:**
  - The README never mentions the index lock, `.atlas/index.db.lock`, the 10-minute wait or its
    `another atlas index run is writing …; gave up after 600s` error.
  - Its empty-index list still reads "`search`, `graph`, `ask` and `drift` also exit 1", but `docs` now does too.
  - On an empty index, `docs --list` says `no docs yet — run \`atlas docs\` first`, and `atlas docs` then fails with
    `index is empty`.
  - `resolveReason` and its values (including the new `'previous run interrupted'`) are documented only in
    `DECISIONS.md`.
  - `atlas init` still says "(phase 2)" (A7-11).
- **Test:** `A15-07`
  (`expected '# Atlas\n\n> Local-first codebase int…' to match /another atlas index run|index\.db\.lo…/`).
- **Location:** `README.md` §Command notes (lines 160-178), `src/cli/commands/docsCmd.ts:48-50`.

## Re-verified (AUDIT-11)

All AUDIT-3, AUDIT-7 and AUDIT-11 tests pass on this base. Fixes re-checked by hand on the built CLI and pinned in
`audit-15.test.ts`:
- **A11-01 fixed (SG28):** `docs --offline --budget 10000` generates all 4 module docs. A budget that cannot pay the
  first call exits 1 on `docs` and `ask`, and `atlas_ask` returns `isError`. All three give the same
  `token budget exhausted: a call needs ~N tokens (~P prompt + 1024 output), R of C left; raise tokenBudget`, and the
  fake endpoint receives no request. A paid call's `max_tokens` is capped to what is left (4,267 with a 5k budget)
  and is identical from `ask` and the first `atlas_ask`.
- **A11-02 fixed (SG29):** three parallel `atlas_index {force: true}` calls leave 24 symbols, and each reports
  `forced`.
- **A11-03 fixed (SG28):** `docs` on an `init`-only project exits 1 with `index is empty: run \`atlas index\` first`,
  makes no LLM request and writes no `architecture.md`.
- **A11-05 fixed (SG29):** `atlas_index` applies a `maxFileBytes` edit made after the server started, and agrees
  with `atlas index` ("1 file over the 500-byte cap").
- **A7-08 fixed (SG29):** `atlas_index` on a fresh directory writes `.atlas/config.json`.

**Still open:**
- **A11-04:** an oversized file is counted in `filesSkipped` but not in `filesScanned`.
- **A11-06:** `/api/search` returns 200 on an empty index.
- **A11-07:** a no-op `atlas_index` reports `weakEdges: 0`.
- **A11-08:** unknown config keys are dropped.
- **A11-09:** `references` is missing from `atlas_graph`'s description and from the dashboard legend.
- **A11-10:** `renderComment` says "passed" for `failing: true`.
- **A11-11:** `extractorUpgrade` is an absent key while `resolveReason` is `null`. `atlas_symbol {limit: 101}` still
  gives zod's `Number must be less than or equal to 100`. `atlas_docs {target: './src/app.ts'}` is "no doc".
- **A7-06:** `atlas_search {limt: 2}` returns 10 hits, although the advertised schema says
  `additionalProperties: false`. `/api/search?…&limt=1` is ignored.
- **A7-07:** there is still no `index --json`, so SG33's `resolveReason` reaches the CLI only as text.
- **A7-09, A7-11, A3-11, A3-13:** unchanged. A3-11 means search hits still differ in shape: CLI `line` +
  `semanticScore`, HTTP `id` + `line`, MCP `startLine`/`endLine`/`signature`.

## No finding

- **SG31 destructured symbols:** `export const { auth, handlers: routes } = NextAuth({})` and
  `export const [first, ...rest] = …` give `variable` symbols, exported, under the bound names. They are identical
  on:
  - `search --json`, `/api/search` and `atlas_search`, including `kind=variable`;
  - `atlas_symbol`;
  - `graph --symbol auth`, `/api/graph?symbol=auth` and `atlas_graph {symbol: 'auth'}` (deep-equal, with the
    `whoami → auth` call edge);
  - DOT labels (`variable: auth`);
  - the offline module doc (every bound name listed);
  - `drift --json`, which equals `atlas_drift`.

  Python `left, right = pair()` gives `variable` symbols, and `from p import left` resolves to one. The dashboard's
  kind dropdown includes `variable`.
- **SG33:** an unfinished run after the last finished one makes the next run re-resolve with no file changed.
  `atlas index` prints `resolved N edges (W weak) after an interrupted run`, and `atlas_index` returns
  `resolveReason: 'previous run interrupted'`. The run after that reports `null` / `(graph unchanged)`.
  `--force` reports `forced`.
- **SG32:** the lock is taken after the in-process queue. Reads (`atlas_search`, `atlas_graph`, `/api/stats`) answer
  normally while another process holds it. The run then completes once the lock is free. `acquireIndexLock` fails
  with `another atlas index run is writing <db>; gave up after Ns`, the same text on the CLI (`atlas: …`, exit 1)
  and on MCP (`isError`). The dashboard opens the DB read-only and never touches the lock.
- **Extractor upgrade (without `--force`):** `atlas index` prints
  `index was written by extractor v2; re-parsed every file with extractor v3`, and `atlas_index` returns
  `extractorUpgrade: {from: 2, to: 3}` with all files re-indexed.
- **MCP SDK usage:** all 7 tools are listed, and each `inputSchema` matches `core/params.ts`. Bad, empty and
  out-of-range arguments give `-32602 Input validation error` with the shared messages, for example
  `depth must be an integer from 1 to 3`, `question must not be empty` and `unknown kind 'module' …`. An unknown
  tool gives `Tool atlas_nope not found`. Every read tool on an empty index gives
  `index is empty: call atlas_index first`. `atlas_docs` with no target lists `[]`, like `docs --list`.
- **Anthropic client:** request bodies still hold exactly `model`, `max_tokens`, `system` and `messages`. A refused
  call is never sent. The key is read only from the environment.
