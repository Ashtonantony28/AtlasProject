# AUDIT-11: API and SDK consistency, round 3

This audit compares every Atlas surface with the others and with the README: the CLI (`init`, `index`, `search`,
`graph`, `docs`, `ask`, `drift`, `ci-comment`, `serve`, `mcp`, and each `--json`), the dashboard HTTP API and `app.js`,
the MCP tools served through the stock SDK client, and the Anthropic client in `src/core/synth/llmClient.ts`. It
focuses on what changed since AUDIT-7: the new `IndexStats` fields (`filesTooLarge`, `extractorUpgrade`,
`resolveReason`, `resolverDiagnostics`, `resolverDiagnosticCount`), config `maxFileBytes`, `incompleteReason` and
`stopReason`, `requireIndexed`, drift paging and totals, `ci-comment`'s `parseDriftReport`, and `references` edges.
Base: `75dd831` (after SG25) on `claude/atlas-audit-11`. The auditor wrote none of this code. The SDKs are
`@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.32.1, which sends `anthropic-version: 2023-06-01`.
Node 22.22.

**Method.** I ran `npm run build`, then copied `fixtures/sample` (plus small variants) into a scratch directory and
drove it in four ways:
- through the CLI, reading every output and exit code;
- through `atlas serve --port 0` with curl;
- through `atlas mcp --offline` with the stock `Client` + `StdioClientTransport`. I listed every tool and called each
  one with bad, unknown, empty and out-of-range arguments, and also called tools concurrently and across a config edit;
- through a fake Messages endpoint set with `ANTHROPIC_BASE_URL`. It records each request and returns `end_turn`,
  `max_tokens`, `refusal` or a thinking block, so no tokens are spent.

Repros live in `test/audit/audit-11.test.ts` as `it.fails(...)`, named by ID. I ran each one once as a plain `it` and
confirmed that it fails on its stated assertion, not on a harness error (the assertion messages are listed under each
finding). The five plain `it` tests pin behaviour that the audit found consistent, including the AUDIT-7 fixes.

**Totals:** 0 critical, 2 high, 3 medium, 6 low. AUDIT-7: 7 of 12 fixed (A7-01..A7-05, A7-10, A7-12), 5 still open
(A7-06, A7-07, A7-08, A7-09, A7-11). A3-11 and A3-13 are still open.

## Findings

### High

**A11-01: since SG21, any `tokenBudget` or `--budget` below about 17k tokens makes `docs` do nothing (and exit 0) and
makes every `ask` fail.** High.
- **Evidence:** SG21 raised `DOC_MAX_TOKENS` and `ASK_MAX_TOKENS` to 16,000. Both budget guards reserve the full
  `max_tokens` plus about 1 token per 3 prompt characters before each call:
  - `synthesizeDocs` reserves this per doc;
  - `budgeted()` reserves it for `ask` and `atlas_ask`.

  The validated config (`tokenBudget`: "positive integer", README §Configuration) accepts every value from 1 to
  about 17,000, but none of those values can pay for a single call. On the indexed sample:
  - `atlas docs --offline --budget 10000` prints `modules: generated 0, cached 0, skipped 4, failed 0` and
    `architecture: cached/skipped`, then exits 0. With `-v`, every target says `(token budget exhausted)`.
  - The offline mock spends about 2.5k tokens on the whole sample, so the 10k budget is about 4× what the run needs.
  - With `tokenBudget: 10000`, `atlas ask` and `atlas_ask` fail with
    `token budget exhausted: call needs ~16733 tokens, 10000 of 10000 left`. The message contradicts itself.

  Before SG21 the reserve was 800 tokens, so budgets of a few thousand worked. The same concept also fails in
  different ways: `docs` skips and exits 0, `ask` exits 1, and `atlas_ask` returns `isError`. `CLAUDE.md` Phase 5's
  DoD asks for a smoke test "with a low token cap". The tests that still pass either use budgets of 50k or more or
  pass `perDocMaxTokens`, which no surface exposes.
- **Impact:** a user or CI job that sets a modest budget gets no docs and a green `docs` step. Every `ask` fails. On a
  repo whose docs are already committed, the next `drift` then reports stale docs with no hint that the budget is the
  cause.
- **Test:** `A11-01` (`expected false to be true`).
- **Repro:** `atlas index T && atlas docs --offline --budget 10000 --cwd T; echo $?` prints `generated 0 … skipped 4`
  and `0`.
- **Location:** `src/core/synth/llmClient.ts:25-26`, `src/core/synth/synthesize.ts:96`
  (`budget.remaining() < … + perDocMax` returns `skipped`), `src/core/synth/budget.ts:51-55`,
  `src/cli/commands/docsCmd.ts:89-94` (exit 1 only for `failures`), `src/core/config.ts:38`.

**A11-02: concurrent `atlas_index` calls on one MCP server duplicate every symbol, and the duplicates persist.** High.
- **Evidence:** the stdio server handles requests concurrently. `indexRepo` takes its `existingByPath` snapshot before
  its first `await` (parse), so two calls on a fresh or changed file both see "no existing row" and both insert. Over
  the stock SDK client, three parallel `atlas_index {force: true}` calls on a fresh copy of the sample left:
  - `symbols=64` instead of 24, and `imports=15` instead of 5;
  - `atlas_search "area" --limit 100` returning 57 hits, of which 19 are distinct;
  - `atlas search area` on the CLI listing `Drawable.area` three times.

  The next plain `atlas index` skips every file as unchanged, so the duplicates persist until someone runs `--force`.
  On the CLI, two concurrent `atlas index` processes do not corrupt the index: one fails at once with
  `atlas: database is locked` (no busy timeout), and the other completes. MCP clients such as Claude Code issue
  parallel tool calls, and an agent re-indexing "just in case" while another call indexes is a realistic pattern.
- **Impact:** duplicated search hits, symbols, `atlas_symbol` matches and graph nodes, plus duplicated retrieval
  snippets in `ask`. The damage outlives the session.
- **Test:** `A11-02` (`expected 44 to be 24`, from two in-process parallel calls).
- **Location:** `src/mcp/server.ts:96-104` (no serialisation), `src/core/ingest/indexer.ts:115-125` (snapshot
  taken before the parse `await`s) and `:199-210` (insert keyed on that snapshot).

### Medium

**A11-03: `atlas docs` on an empty index calls the LLM and writes an architecture doc of nothing.** Medium.
- **Evidence:** after `atlas init`:
  - `search`, `graph`, `ask` and `drift` exit 1 with `index is empty: run `atlas index` first` (A7-05 fixed).
  - `docs` instead exits 0 with `architecture: generated` and `tokens: 143 in, 45 out`, and writes
    `.atlas/docs/architecture.md`.
  - `drift` then still says the index is empty.

  With a real key, this spends a call and persists an architecture doc to commit. `docs` is the one LLM-spending
  command that does not use `openProjectIndex(…, { indexed: true })`.
- **Test:** `A11-03` (`expected +0 to be 1`).
- **Location:** `src/cli/commands/docsCmd.ts:42`.

**A11-04: an oversized file is counted in `filesSkipped` but not in `filesScanned`, is pruned with no message, and
drift then calls the existing file `missing`.** Medium.
- **Evidence:** the walker leaves too-large files out of `files`, but the indexer adds them to `filesSkipped`. With
  `maxFileBytes: 500` on the indexed sample:
  - the CLI prints `scanned 3 files` / `indexed 0, skipped 4, failed 0`, so skipped exceeds scanned. With
    `maxFileBytes: 100` it prints `scanned 0 files … skipped 4`.
  - `atlas_index` returns the same contradiction in JSON.
  - The previously indexed `src/shapes.ts` is pruned (`filesRemoved: 1`, which the CLI never prints).
  - `drift --docs-dir .atlas/docs` reports `src/shapes.ts (stored bbbe3d70, current missing)` for a file that is
    on disk.

  The README says oversized files "are not indexed, and `atlas index` counts them". It does not say that their
  docs go stale as "missing".
- **Test:** `A11-04` (`expected 4 to be less than or equal to 3`).
- **Location:** `src/core/ingest/indexer.ts:136-144` (counted as skipped), `:267-276` (pruned), and
  `src/core/drift/detect.ts:126-135` (`currentHash: 'missing'`).

**A11-05: `atlas mcp` reads `.atlas/config.json` once at startup, so `atlas_index` ignores later config edits that
`atlas index` honours.** Medium.
- **Evidence:** `McpContext.config` is loaded once in `createMcpContext`. In one MCP session I:
  1. indexed the sample;
  2. wrote `{maxFileBytes: 500, exclude: ['src/math.ts']}`;
  3. called `atlas_index` again.

  The second call returned `filesScanned: 4, filesTooLarge: 0`. `atlas index` on the same directory then reported
  `scanned 2 files` and `1 file over the 500-byte cap`. The indexer itself mixes the two sources: the embedder comes
  from a fresh `loadConfig(root)`, but the walk filters come from the stale `ctx.config`. SG25 promises that the
  index "stays current across … config edits", but MCP sessions are long-lived (an editor keeps them all day). This
  is related to A7-08: `atlas_index` still never writes the config.
- **Test:** `A11-05` (`expected +0 to be 1`).
- **Location:** `src/mcp/server.ts:66-104`, `src/core/ingest/indexer.ts:308`.

### Low

**A11-06: the dashboard API answers 200 on an empty index, while the CLI and MCP refuse.** Low.
- **Evidence:** on an `init`-only project:
  - `/api/search?q=area` returns `[] [200]`;
  - `/api/graph` returns an empty graph with `truncated: false`.

  On the same project, CLI `search` exits 1 and `atlas_search` returns `index is empty: call atlas_index first`. The
  README lists only the CLI and MCP behaviour, so this is a gap rather than a contradiction. A dashboard on the wrong
  `--cwd` looks like a repo with no matches.
- **Test:** `A11-06` (`expected 200 not to be 200`).
- **Location:** `src/web/server.ts:86-177` (no `requireIndexed`).

**A11-07: a no-op `atlas_index` reports `weakEdges: 0` while carrying `edges` and `resolverDiagnostics` over from
the kept graph.** Low.
- **Evidence:** on a repo with one unresolved import, the first `atlas_index` returns `edges: 4, weakEdges: 2`. The
  second (`resolveReason: null`) returns `edges: 4, weakEdges: 0`. A client that tracks resolution quality from
  `atlas_index` sees every weak edge vanish on each no-op run. The CLI hides this by printing
  `edges: N (graph unchanged)`.
- **Test:** `A11-07` (`expected +0 to be 1`).
- **Location:** `src/core/ingest/indexer.ts:300-302` (only `edges` is carried over).

**A11-08: unknown keys in `.atlas/config.json` are silently dropped.** Low.
- **Evidence:** `{"version":1,"maxFileByte":10,"tokenBudgett":5}` loads without error and indexes with the
  defaults. A typo in exactly the new knob (`maxFileBytes`) or in the spend cap has no effect and gives no warning.
  This is the config-file twin of A7-06: MCP and HTTP still drop unknown parameters, while the CLI rejects unknown
  flags.
- **Test:** `A11-08` (`expected [Function] to throw an error`).
- **Location:** `src/core/config.ts:11` (`z.object`, not `.strict()`).

**A11-09: `references` edges (SG18) are exported on every surface, but neither the MCP tool description nor the
dashboard names them.** Low.
- **Evidence:** `graph`, `/api/graph` and `atlas_graph` return identical `references` edges (pinned). However:
  - `atlas_graph`'s description still says "calls/imports/extends/implements edges";
  - the dashboard legend and `styles.css` have no `references` entry, so those edges draw as the unstyled default.
- **Test:** `A11-09` (`expected 'Export the symbol graph (nodes + call…' to match /references/`).
- **Location:** `src/mcp/server.ts:300`, `src/web/static/index.html:40-45`, `src/web/static/styles.css:39-51`.

**A11-10: `parseDriftReport` accepts self-contradictory reports, and `renderComment` can then say "passed" for
`failing: true`.** Low.
- **Evidence:** `{stale: [], undocumented: [], totals: {…, stale: 0}, hasDrift: false, failing: true}` renders
  "**Drift check: passed.**", because `renderComment` tests `hasDrift` before `failing`. Two other contradictions
  are also accepted:
  - a report whose `totals.stale` is smaller than `stale.length`;
  - a report whose `hasDrift: false` sits above a stale list.

  `atlas drift --json` never emits such a report, so CI is correct today. The validator added for A7-04 checks
  types but not these relations.
- **Test:** `A11-10` (`expected '## Atlas — documentation report…' not to match /Drift check: passed/`).
- **Location:** `src/cli/commands/ciCommentCmd.ts:61-88` (`parseDriftReport`) and `:102` (`hasDrift` checked first).

**A11-11: naming and shape loose ends in the new fields and messages.** Low.
- **Evidence:**
  - "Not applicable" is spelt two ways: `IndexStats.extractorUpgrade` is an absent key, while `resolveReason` is
    `null`.
  - `resolveReason` values are prose (`'files changed'`, `'resolver config changed'`), unlike every other enum
    (`'module'`, `'max_tokens'`).
  - The README says resolver diagnostics are "returned in full (first 20)".
  - CLI messages name the camelCase parameter, not the flag: `--edge-limit 0` gives
    `edgeLimit must be an integer from 1 to 10000`.
  - `atlas_symbol {limit: 101}` gives zod's default `Number must be less than or equal to 100`, not the shared
    `limit must be an integer from 1 to 100`. `atlas_symbol`'s limit is not in `core/params.ts`.
  - `docs --show ./src/shapes.ts` is "no doc", while `src/shapes.ts` works.
- **Test:** `A11-11` (`expected {…} to have property "extractorUpgrade" with value null`).
- **Location:** `src/core/ingest/indexer.ts:52-55`, `README.md` §Command notes, `src/core/params.ts:13-17`,
  `src/mcp/server.ts:290`, `src/core/synth/persist.ts:202`.

## Re-verified (AUDIT-7)

All AUDIT-3 and AUDIT-7 tests are green on this base. I re-checked the following by hand on the built CLI.
- **A7-01 fixed:** every Messages body has exactly `model`, `max_tokens` (16,000), `system` and `messages`. No
  sampling parameters are sent (pinned again).
- **A7-02 fixed:** graph pages own their edges by `src`, so paging returns every edge once. `truncated` is true on
  every page after the first, matching drift.
- **A7-03 fixed:** a `max_tokens` or `refusal` stop on `docs` prints `atlas docs: <target>: not stored (stop_reason …)`
  and exits 1, and the previous doc is kept. `ask` exits 1 and `atlas_ask` returns `isError`, both with
  `no answer: the model returned an incomplete response (stop_reason …)` (pinned). Thinking blocks are skipped.
- **A7-04 fixed:** `ci-comment` uses `totals` and prints the paging note. `{}`, `[]` and an MCP error envelope are
  rejected with `not a drift report …`. Reports from before paging get `failing`, `hasDrift` and `truncated`
  derived from their lists. A saved `atlas_drift` result with `formatted` is accepted (pinned).
- **A7-05 fixed for the CLI and MCP** (pinned). It is not fixed for `docs` (A11-03) or HTTP (A11-06).
- **A7-10 fixed:** the offline mock bills the system prompt and every message.
- **A7-12 fixed:** `renderStats` says "graph shows N of M edges" when only edges were cut.

**Still open:**
- **A7-06:** MCP and HTTP drop unknown parameters (`atlas_search {limt: 2}` returns 10 hits), and
  `kind=class&kind=method` keeps only `class`.
- **A7-07:** there is still no `index --json` or `docs --list --json`, `atlas_symbol` has no totals, and `/api/files`
  and `/api/docs` are unbounded. `atlas_index` gives only `filesTooLarge`, never which files; the CLI lists them
  with `--verbose`.
- **A7-08:** after `atlas_index`, `.atlas/` holds `index.db` and no `config.json`.
- **A7-09:** `/api/doc/file/1abc` returns file 1's doc. `/api/files` is still snake_case, and `POST` is answered
  like `GET`.
- **A7-11:** `atlas init` still prints "Next: `atlas index <path>` (phase 2)". The README no longer states a test
  count.
- **A3-11 and A3-13:** unchanged. Their `it.fails` tests still fail as intended.

## No finding

- **MCP SDK usage:** the stock `Client` with `StdioClientTransport` lists all 7 tools. Each `inputSchema` matches
  `core/params.ts`, including ranges and defaults.
  - Bad, empty and out-of-range arguments come back as `isError` with `-32602 Input validation error: …`, using the
    shared messages. Examples: `query must not be empty`, `unknown kind 'module' …`,
    `depth must be an integer from 1 to 3`, `offset must be an integer ≥ 0`.
  - An unknown tool gives `-32602 Tool atlas_nope not found`.
  - Handler errors come back as `isError` with the handler's message. Examples: `no doc for 'nope.ts' …`,
    `index is empty: call atlas_index first`, and the budget error.
- **Drift paging:** `drift --json --limit 1 --offset 1` and `atlas_drift {limit: 1, offset: 1}` are deep-equal
  (pinned). `totals`, `failing` and `hasDrift` always cover the whole report, and the exit code (2) follows
  `failing`, not the page. A missing or empty `--docs-dir` and `persisted: true` fail with the same message on both
  surfaces.
- **`references` edges:** identical from `graph --format json`, `/api/graph` and `atlas_graph` (pinned). DOT output
  labels them `references`.
- **`maxFileBytes` validation** matches the README: `0`, `-1`, `1.5` and `"1MB"` are rejected by every command with
  `Invalid config … maxFileBytes: …`. When absent, the walker default is 1 MiB. The CLI's "N files over the B-byte
  cap" line and `atlas_index`'s `filesTooLarge` agree when the MCP server sees the same config (pinned).
- **`extractorUpgrade`:** after the recorded extractor version was set to 0, `atlas_index` returned
  `extractorUpgrade: {from: 0, to: 1}` and re-parsed every file. The CLI prints the matching "re-parsed every file"
  line.
- **Errors and exit codes:** the CLI wraps every thrown error as `atlas: <message>` and exits 1. A bad `--cwd` gives
  `directory not found` on `index`, `drift` and `mcp` alike.
- **Anthropic client:** the API key is read only from the environment and never appears in errors (AUDIT-7 pinned
  test, still green). `stopReason` is recorded only when the API returns one. A missing key fails with the same
  message on every surface.
- **Dashboard:** `app.js` calls only `/api/stats`, `/api/files`, `/api/graph`, `/api/doc/*` and `/api/search`, and
  reads fields in the shapes the server returns.
