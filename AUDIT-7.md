# AUDIT-7: API and SDK consistency, round 2

This audit compares every Atlas surface with the others: the CLI (`init`, `index`, `search`, `graph`, `docs`, `ask`,
`drift`, `ci-comment`, `serve`, `mcp`, and each `--json`), the dashboard HTTP API and `app.js`, the MCP tools served
through the stock SDK client, and the Anthropic client in `src/core/synth/llmClient.ts`. Base: `1e804ae` (after
SG13–SG17) on `claude/atlas-audit-7`. The auditor wrote none of this code. The SDKs are `@modelcontextprotocol/sdk`
1.32.1 and `@anthropic-ai/sdk` 0.32.1, which sends `anthropic-version: 2023-06-01`.

**Method.** I ran `npm run build`, then copied `fixtures/sample` into a scratch directory and drove it in four ways:
- through the CLI;
- through `atlas serve --port 0` with curl;
- through `atlas mcp` with the stock `Client` + `StdioClientTransport` (every tool listed and called, including bad,
  unknown, empty and out-of-range arguments);
- through a fake Messages endpoint set with `ANTHROPIC_BASE_URL`. It records each request body and returns 400 or 401,
  a refusal, or a `max_tokens` stop, so no tokens are spent.

Repros live in `test/audit/audit-7.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it` and
confirmed that it fails on its stated assertion, not on a harness error (the assertion messages are listed under
each finding). The two plain `it` tests pin behaviour that the audit found consistent. A7-07, A7-10, A7-11 and A7-12
have a runnable command instead of a test.

**Totals:** 0 critical, 2 high, 3 medium, 7 low.

## Findings

### High

**A7-01: the real Anthropic client always sends `temperature`, so any current-generation `synthModel` fails every
`docs`, `ask` and `atlas_ask` call.** High.
- **Evidence:** every Messages request carries `temperature`: 0.2 for synthesis and 0.1 for `ask`. The fake endpoint
  recorded `keys=model,max_tokens,temperature,system,messages`. Claude Opus 4.7 and later, Sonnet 5 and later,
  Haiku 5.5 and the Fable models return a 400 for any non-default sampling parameter. On API version `2026-10-21`
  (`@anthropic-ai/sdk` 1.0.0 and later), every model rejects them, including the default `claude-sonnet-4-6`. The
  README invites users to set `synthModel` or `--model`, so a user who picks a current model gets an error on every
  call. `atlas ask --model claude-opus-5-5`, run against a fake that answers as the API does, exits 1 with
  `atlas: 400 {"type":"error","error":{"type":"invalid_request_error","message":"temperature: …"}}`. The default model
  on the pinned SDK still works, so this is High and not Critical. A related risk: Opus 5.5 always thinks, and
  thinking counts toward the fixed `max_tokens: 800`, so once this is fixed A7-03 becomes likely on those models.
- **Test:** `A7-01` (`expected ['model','max_tokens',…] to not include 'temperature'`).
- **Location:** `src/core/synth/llmClient.ts:48` (`temperature: params.temperature ?? 0.2`), callers at
  `src/core/synth/synthesize.ts:94` and `src/core/qa/ask.ts:73`.

**A7-02: paging the graph with `limit`/`offset` silently drops every edge that crosses a page, and the last page
reports `truncated: false`.** High.
- **Evidence:** each page returns only the edges whose endpoints are both on that page. On the sample (24 nodes,
  `totals.edges` 15), `atlas graph --limit 8 --offset 0|8|16` returns 2, 0 and 0 edges, and the final page says
  `"truncated": false`. A client that pages through `atlas_graph` or `/api/graph` to rebuild the graph gets 2 of 15
  edges. Nothing tells it what it is missing, apart from comparing against `totals.edges`. Paging is only needed on
  large repos, where nearly all edges cross pages. The paging fields also mean different things on different
  surfaces: drift sets `truncated: true` whenever `offset > 0` (`src/core/drift/detect.ts:180`), but a graph page
  past the first is `truncated: false` once it reaches the end. README §MCP says "`totals` and `truncated` say what
  was left out", and that does not hold here.
- **Test:** `A7-02` (`expected false to be true`).
- **Location:** `src/core/graph/export.ts:72-82` (`edgesWithin(page)`) and `:97` (`truncated` ignores both
  cross-page edges and `offset`).

### Medium

**A7-03: `stop_reason` is ignored, so a refusal or a `max_tokens` cut is stored as a complete doc, cached as fresh and
persisted.** Medium.
- **Evidence:** the fake endpoint returned `content: []`, `stop_reason: "refusal"`. `atlas docs` exits 0 and reports
  `generated 4`. It writes 5 empty docs to `.atlas/docs` (front matter only). The next `atlas docs` reports
  `cached 4`, because `source_hash` matches the prompt. `atlas drift` then reports `0 stale` and passes, listing
  every symbol as undocumented. A `max_tokens` stop is stored the same way, as a truncated doc, and `ask` returns a
  truncated answer with no flag. Neither `LLMResult` nor the CLI, MCP or `--json` output exposes a stop reason.
- **Test:** `A7-03` (`expected ['architecture','src/app.ts',…] to deeply equal []`).
- **Location:** `src/core/synth/llmClient.ts:52-61` (only `text` blocks and `usage` are read),
  `src/core/synth/synthesize.ts:90-104` (`upsertDoc` without checking the stop).

**A7-04: `ci-comment` counts the lists in the JSON, not `totals`, and ignores `truncated`.** Medium.
- **Evidence:** run `drift --json --limit 1` on an index with 3 stale docs and 3 undocumented symbols, then
  `ci-comment`. The comment reads "Drift check: failed (1 stale doc(s))", "Stale docs (1)" and "Undocumented public
  symbols (1 of 22)", and has no "showing 1 of 3" note. The same happens with a saved `atlas_drift` result, which is
  paged to 100 by default. With `--offset 5`, the comment reads "**Drift check: failed** ()." with no lists at all.
  The input is also not validated: `{}` crashes with a `TypeError`, and a report without `failing` (from an older
  Atlas) renders "passed. No stale docs" above a table of stale docs. The shipped workflow passes the full report,
  so CI itself is correct today.
- **Test:** `A7-04` (`expected '## Atlas — …' to match /3 stale doc/`).
- **Location:** `src/cli/commands/ciCommentCmd.ts:20` (unchecked `JSON.parse … as DriftReport`) and `:45-83`.

**A7-05: on an empty index, the CLI passes and answers while MCP errors.** Medium.
- **Evidence:** after `atlas init` (or an `index` whose filters match nothing), the CLI and MCP disagree:
  - `atlas drift` prints "no drift: docs are up to date …" and exits 0.
  - `search` prints "no matches" and exits 0.
  - `graph` prints an empty graph.
  - `ask` calls the LLM with zero snippets, which costs tokens with a real key, and exits 0.
  - Every MCP read tool returns `isError`: `index is empty: call atlas_index first`.

  A gate that runs `drift` against the wrong `--cwd`, or against an index emptied by `include`, is green.
  `runDrift` skips its "no docs" error exactly when nothing is indexed.
- **Test:** `A7-05` (`expected +0 not to be +0`).
- **Location:** `src/core/drift/run.ts:20,28,33` (`&& indexed`), compared with `src/mcp/server.ts:93`
  (`requireIndex`). The CLI read commands have no equivalent check (`src/core/project.ts:35-43`).

### Low

**A7-06: unknown parameters are silently ignored on MCP and HTTP, though the MCP schema advertises
`additionalProperties: false`.** Low.
- **Evidence:** `atlas_search {query: "area", limt: 2}` succeeds and returns 10 hits. Every tool's `inputSchema` says
  `"additionalProperties": false`, but the SDK's zod object strips unknown keys rather than rejecting them. HTTP does
  the same: `/api/search?q=area&limt=2` and `/api/graph?edge_limit=1` ignore the misspelt parameter. A repeated
  parameter keeps only its first value: `kind=class&kind=method` returns classes only, while the CLI and MCP accept
  several kinds. The CLI rejects unknown flags (commander exits 1).
- **Test:** `A7-06` (`expected undefined to be true`).
- **Location:** `src/mcp/server.ts:258-371` (plain zod shapes, not `.strict()`), `src/web/server.ts:96-104,152-157`
  (`p.get`).

**A7-07: the paging contract covers only graph and drift.** Low.
- **Evidence:** the other list results give no sign of what they leave out:
  - `atlas_symbol` cuts at `limit` (default 20) with no `totals`, `truncated` or `offset`. Its per-item `truncated`
    means "excerpt cut", not "list cut".
  - `atlas_search` has no `truncated`.
  - `atlas_docs` (list), `/api/docs` and `/api/files` are unbounded and have no paging.
  - `docs --list` has no `--json`, and neither does `index` (MCP `atlas_index` returns the stats object, including
    `filesRemoved`, which the CLI never prints).
- **Repro:** over the stock MCP client, `callTool({name: "atlas_symbol", arguments: {name: "a", limit: 1}})` on the
  indexed sample returns one match and nothing showing that more exist.
- **Location:** `src/mcp/server.ts:129-170,203-212`, `src/web/server.ts:109-124`,
  `src/cli/commands/docsCmd.ts:46-56`, `src/cli/commands/indexCmd.ts:46-60`.

**A7-08: `atlas_index` does not write `.atlas/config.json`; `atlas index` does.** Low.
- **Evidence:** a project indexed only through MCP has `.atlas/index.db` and no config file. README §Configuration
  says the first `atlas index` writes it, and §CI requires a committed `.atlas/config.json`.
- **Test:** `A7-08` (`expected false to be true`).
- **Location:** `src/mcp/server.ts:97-104`, compared with `src/cli/commands/indexCmd.ts:27`.

**A7-09: HTTP API loose ends.** Low.
- **Evidence:**
  - `/api/doc/file/1abc` returns file 1's doc (`parseInt`), and `/api/doc/file/3abc` returned `src/shapes.ts`.
  - `POST` and `DELETE` are answered like `GET`. This is harmless, since the DB is read-only, but no other route
    returns 405.
  - `/api/files` returns raw snake_case `FileRow`s (`content_hash`, `indexed_at`), while every other payload is
    camelCase.
- **Test:** `A7-09` (`expected 200 to be 400`).
- **Location:** `src/web/server.ts:127-133,109-111`.

**A7-10: the offline mock's token accounting differs from the real client's.** Low.
- **Evidence:** the interface matches (`model`, `complete` → `{content, inputTokens, outputTokens}`). But the mock
  counts only the last user message (`body.length / 4`) and ignores `system`. The real API bills the system prompt
  too, about 140 tokens per `ask` and 100 per module doc. So the offline `tokens:` line, `budgetRemaining` and the
  budget tests run lower than a real run would.
- **Repro:** `atlas ask --offline --json "circle area" --cwd T | jq .inputTokens`, compared with
  `(SYSTEM.length + prompt.length) / 4`.
- **Location:** `src/core/synth/llmClient.ts:209`.

**A7-11: the README and help text are stale in places.** Low.
- **Evidence:**
  - README says "`npm test` — 302 tests"; the suite now has 329 tests before this audit.
  - `atlas init` prints "Next: `atlas index <path>` (phase 2)."
  - README §Configuration says the first `atlas index` writes the config, which holds for the CLI but not for MCP
    (A7-08).
  - Everything else in `--help` matches behaviour, including drift's exit codes and the ranges for `--limit`, `--k`,
    `--expand`, `--depth`, `--edge-limit` and `--port`.
- **Repro:** `grep -n "302 tests" README.md; atlas init --cwd $(mktemp -d)`.
- **Location:** `README.md:228`, `src/cli/commands/init.ts:34`.

**A7-12: the dashboard's "graph shows N of M symbols" note fires when only edges were cut.** Low.
- **Evidence:** `renderStats` shows the note whenever `graph.truncated` is true. With more than 2000 edges and no
  more than 1000 nodes, it reads "graph shows 24 of 24 symbols" and says nothing about the missing edges.
- **Repro:** `curl ':PORT/api/graph?edgeLimit=1'` returns `truncated: true` with `nodes.length === totals.nodes`.
- **Location:** `src/web/static/app.js:36-39`.

## Re-verified (AUDIT-3)

All AUDIT-3 tests are green on this base (`npm test`), and I re-checked the following by hand on the built CLI.
- **A3-01, A3-03:** `atlas_drift` and `drift` share `runDrift`. Missing or empty docs give exit 1 or `isError` on
  both surfaces, unless the index is empty (A7-05).
- **A3-02:** `failing` means exactly exit 2. `ci-comment` keys off `failing` (but see A7-04).
- **A3-04, A3-12:** `docs --list` and `--show`, `/api/docs` and `atlas_docs` all read the index and then
  `.atlas/docs`. HTTP and MCP list shapes are identical (`{kind, target, source, sourceHash, chars}`). `--show` on a
  missing doc exits 1. The CLI list is still text only (A7-07).
- **A3-05:** CLI `ask` goes through `budgeted(TokenBudget(config.tokenBudget))`.
- **A3-06, A3-07, A3-08:** `--budget abc`, `--limit -1`/`abc`/`1.5`, `--k 0` and an empty query fail on the CLI
  (exit 1), HTTP (400) and MCP (`isError`, `-32602 Input validation error: … limit must be an integer from 1 to
  100`). The message text is the same on all three.
- **A3-09:** a missing root or index fails with "directory not found" or "no index … run `atlas index` first" and
  creates nothing.
- **A3-10:** an `indexPath` outside `.atlas/` is rejected.
- **A3-14:** README §Command notes now covers flags and config keys. The test count is stale again (A7-11).
- **A3-15:** `module` is not a search kind on any surface, and the dashboard dropdown matches.
- **A3-16:** an unknown `/api/*` path returns a JSON 404.
- **A3-17:** `StaleKind` and `OpenDbOptions` are re-exported.

**Still open:**
- **A3-11:** search hit shapes differ. The CLI has `line` and `semanticScore`; HTTP has `id` and `line`; MCP has
  `startLine`/`endLine`/`signature` and a score rounded to 3 dp, so the three "area" methods all show `0.023`.
- **A3-13:** `index` has no `--cwd`; `-k` and `-f` mean different things in different commands; `graph --out` and
  `ci-comment --in/--out` resolve against the process cwd.

Their `it.fails` tests still fail as intended.

## No finding

- **MCP SDK usage:** the stock `Client` with `StdioClientTransport` lists all 7 tools and calls each one.
  - Results are a single compact `text` block of JSON (DOT for `format: "dot"`). Stdout carries only protocol
    traffic: no `console.*` or `process.stdout` calls in `src/core` or `src/mcp`.
  - Schema violations and unknown tools come back as `isError` results with `-32602` text, never as thrown JSON-RPC
    errors. Handler failures come back as `isError` with the handler's message. The server keeps serving afterwards.
  - Empty results are `[]`, or a graph with `totals` 0, and are not errors. Large results are bounded by SG15.
  - A drift gate failure is `isError: false, failing: true`, which matches the CLI's choice of exit 2 rather than
    exit 1.
- **Drift report parity:** `atlas_drift {}` and `drift --json` are deep-equal on the sample (pinned).
  `limit`/`offset` mean the same on the CLI and MCP, and `failing`, `hasDrift` and `totals` always cover the whole
  report.
- **Graph and search parity:** `graph --format json`, `/api/graph` and `atlas_graph` are identical for the same
  params, and search order is identical (AUDIT-3 pinned tests, still green). `file` filters use case-sensitive
  `instr` on all three surfaces.
- **Validation:** `core/params.ts` is the single source of names, defaults, ranges and messages for search, ask,
  graph, drift, budget and port. The help-text ranges match it.
- **API key:** the key is read only from `ANTHROPIC_API_KEY` and is never logged. With a canary key and a fake
  endpoint returning 401 or 400, the error text from the client, `ask` and `docs` contains no part of the key
  (pinned test). A missing key fails with the same message on every surface.
- **Anthropic request shape and accounting:** apart from A7-01 and A7-03, the request is a well-formed
  `messages.create` (`model`, `max_tokens`, optional `system`, string `content`). Text blocks are joined, and
  `usage.input_tokens`/`output_tokens` are recorded. Atlas sends no `cache_control`, so cache-token fields cannot be
  under-counted. The system prompts are below the minimum cacheable size anyway. SDK retries keep their defaults
  (2), and errors propagate as exit 1 or `isError`.
- **Dashboard:** `app.js` calls only existing endpoints. It reads `line`, `score`, `qualifiedName` and `totals` in
  the shapes the server returns, and its kind dropdown matches `SEARCH_KINDS`.
