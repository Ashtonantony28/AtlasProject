# AUDIT-3: API and SDK consistency

Audit of every Atlas surface against the others: the CLI (`init`, `index`, `graph`, `search`, `docs`, `ask`, `drift`,
`ci-comment`, `serve`, `mcp` and every `--json`), the dashboard HTTP API (`src/web/server.ts`) and its client
(`src/web/static/app.js`), the MCP tools (`src/mcp/server.ts`), the public core exports (`src/core/**/index.ts`), and the
README and `--help` text. Base: `a2456ed` on `claude/atlas-audit-3`. The auditor wrote none of this code.

Method: `npm run build`, then temporary copies of `fixtures/sample` and `fixtures/graph` (under a `mktemp -d` scratch dir)
were indexed and driven through the CLI, through `atlas serve` with curl, and through the MCP SDK client over
`InMemoryTransport`. A fake HTTP endpoint (`ANTHROPIC_BASE_URL`) returned 401 so the key-leak checks could run without
spending anything. Every finding below was reproduced. Findings that have a test live in `test/audit/audit-3.test.ts` as
`it.fails(...)`, named by ID. Each was also run once as a plain `it` to confirm it fails on the stated assertion and not
on a harness error. The three plain `it` tests in that file pin behaviour the audit found consistent.

**Totals:** 0 critical, 2 high, 8 medium, 7 low.

## Consistency matrix

| Concern | CLI | HTTP (`serve`) | MCP | Agree? |
| --- | --- | --- | --- | --- |
| Project root | `--cwd <path>` (default `.`); **`index` takes a positional `[path]` and rejects `--cwd`** | fixed at `serve --cwd` | `mcp --cwd` | no (A3-13) |
| Missing root | `index`: exit 1 `path does not exist` | n/a | creates the directory and an empty DB; `atlas_index` succeeds with 0 files | no (A3-09) |
| Missing index | exit 1, `unable to open database file`; creates an empty `.atlas/` | `serve` exits 1 | creates the DB; read tools `isError` `index is empty` | partly (A3-09) |
| `kind` | `-k/--kind a,b`, trimmed, validated (exit 1) | `kind=a,b`, not trimmed, not validated (200 `[]`) | `kind: enum[]`, validated (`isError`) | no (A3-08) |
| `kind=module` | accepted, always `[]` | accepted, always `[]` | accepted, always `[]` | yes, but useless (A3-15) |
| `file` | substring | substring | substring | yes |
| `limit` | `-n/--limit`, default 10, unvalidated: `-1` returns all hits but one, `abc` exits 1 with `datatype mismatch` | `limit`, default 10, unvalidated: `-1` returns all hits but one, `abc` gives 500 | `1..100`, default 10, validated | no (A3-07) |
| Empty query | `search ""` exits 0 with `[]`; `ask "  "` exits 1 | 200 `[]` | `isError` | no (A3-08) |
| Search hit shape | `name kind file line score semanticScore structuralScore` | `id name kind file line score` | `name kind file startLine endLine signature docstring score` (rounded to 3 dp) | no (A3-11) |
| Search order | same | same | same | **yes** (pinned) |
| Graph JSON | `graph --format json` | `/api/graph` | `atlas_graph` | **yes, byte-identical** (pinned) |
| Ask result | `ask --json` | n/a | `atlas_ask` (plus `budgetRemaining`) | **yes** (pinned) |
| Ask `k`/`expand` | `-k/--k`, `--expand`, unvalidated (`-1` retrieves everything, `0` still calls the LLM) | n/a | `k 1..20`, `expand 0..20` | no (A3-07) |
| `tokenBudget` | `docs` enforces it (`--budget abc` disables it); **`ask` ignores it** | n/a | `atlas_ask` enforces it per session | no (A3-05, A3-06) |
| `--offline` | `docs`, `ask` | n/a | `mcp --offline` | yes |
| Drift report | `drift --json` = `DriftReport` | n/a | `DriftReport` + `formatted` | yes (documented extra) |
| Drift on a mutated file | stale, `unindexed`, exit 2 (DB mode and `--docs-dir`) | n/a | same report (default and `persisted`) | **yes** |
| Drift with no persisted docs | `--docs-dir`: exit 1 | n/a | `persisted: true`: **not an error, `stale: []`** | **no (A3-01)** |
| Drift with no docs in DB | exit 0 (only undocumented) | n/a | `stale: []` | yes, but contradicts `--docs-dir` (A3-03) |
| `hasDrift` versus exit code | `hasDrift: true` with exit 0 when only undocumented | n/a | `hasDrift: true` | **no (A3-02)** |
| `--strict` | `drift` only | n/a | none (no exit code) | n/a |
| `--docs-dir` | path, resolved against `--cwd` | n/a | `persisted: boolean` (always `.atlas/docs`) | equivalent |
| Doc lookup | `docs --show <path>` reads DB only; missing doc exits 0 | `/api/doc/file/<numeric id>` reads DB only; 404 | `atlas_docs {target: path}`, DB plus `.atlas/docs`; `isError` | **no (A3-04)** |
| Doc listing shape | text `[file:<id>] (n chars, hash=…)` | raw `DocRow` (snake_case, numeric `target_id`) | `{kind, target(path), source, sourceHash, chars}` | no (A3-12) |
| Unknown route | commander error, exit 1 | `/api/<unknown>` returns 200 HTML | SDK `isError` | no (A3-16) |
| Writes | `.atlas/` only, unless `indexPath` says otherwise | none (DB opened `readonly`) | `.atlas/` only, unless `indexPath` says otherwise or the root is missing | partly (A3-09, A3-10) |

## Findings

### High

**A3-01: `atlas_drift {persisted: true}` reports "no stale docs" when `.atlas/docs` is missing or empty; the CLI fails.** High.
- Evidence: after `rm -rf .atlas/docs`, `atlas drift --docs-dir .atlas/docs` exits 1 (`docs directory not found`); an empty
  directory also exits 1 (`no docs found`). The same check through MCP returns `isError: false` with `"stale": []`, and
  every export is listed as undocumented. An agent asking "are any docs stale?" is told no. This is the A1-06 hole,
  fixed on the CLI by SG12 but still open on the MCP surface.
- Test: `A3-01`.
- Location: `src/mcp/server.ts:191` (`readPersistedDocs(ctx.docsDir)` with no missing or empty guard), compared with
  `src/cli/commands/driftCmd.ts:35-49`.

**A3-02: the drift JSON field `hasDrift` contradicts the exit code, and the README promises exit 2 for undocumented symbols.** High.
- Evidence: with one doc emptied of its symbol names (nothing stale), `drift --json` prints `"hasDrift": true` and
  lists 3 undocumented symbols, yet exits 0. `ci-comment` renders an "Undocumented public symbols" drift section from that
  JSON while the workflow's `has_drift` (taken from the exit code) is false, so the PR check is green. README step 7 says
  "Exits 2 if any doc is stale or any public symbol undocumented"; in fact that needs `--strict` (`drift --help` is
  correct). MCP consumers see the same `hasDrift: true`.
- Test: `A3-02`.
- Location: `src/core/drift/detect.ts:144`, `src/cli/commands/driftCmd.ts:61-62`, `README.md:63`.

### Medium

**A3-03: in DB mode, drift on an index with no docs at all passes, while `--docs-dir` with no docs fails.** Medium.
- Evidence: right after `atlas index`, with no docs ever generated, `atlas drift` exits 0 (every export is reported
  undocumented and `stale: []`); `atlas drift --docs-dir <empty>` exits 1. MCP `atlas_drift {}` behaves like DB mode.
  `test/cli/exitcode.test.ts` pins the exit 0, so this is deliberate for "undocumented", but "zero docs" is the case SG12
  made fatal for `--docs-dir`.
- Test: `A3-03`.
- Location: `src/cli/commands/driftCmd.ts:43` (the zero-docs guard only runs in `--docs-dir` mode).

**A3-04: persisted docs are visible to MCP but not to the CLI or the dashboard.** Medium.
- Evidence: in a fresh clone (committed `.atlas/docs`, fresh index), `atlas_docs {target: "src/math.ts"}` returns the doc
  (`source: "persisted"`). `atlas docs --show src/math.ts` prints `no doc for src/math.ts — run atlas docs first` and
  **exits 0**, `docs --list` prints `no docs yet`, and the dashboard shows "No doc" with `/api/stats` reporting `docs: 0`.
  Missing-doc errors also differ: the CLI exits 0, HTTP returns 404, MCP returns `isError`.
- Test: `A3-04`.
- Location: `src/cli/commands/docsCmd.ts:50-85`, `src/web/server.ts:84-127`, compared with `src/mcp/server.ts:197-220`.

**A3-05: CLI `ask` ignores `tokenBudget`; MCP `atlas_ask` enforces it, and the README says spend is capped.** Medium.
- Evidence: with `tokenBudget: 100`, `atlas_ask` fails with `token budget exhausted: call needs ~1533 tokens, 100 of 100
  left`, while `atlas ask --offline --json` succeeds (415 in / 73 out) and would make the same call against the paid API.
  README:113 ("Per-run spend is capped by `tokenBudget`") sits directly under the `ask` example. Combined with A3-07,
  `--k`/`--expand` have no upper bound, so one CLI call can carry up to 120 lines per snippet across any number of
  snippets.
- Test: `A3-05`.
- Location: `src/cli/commands/askCmd.ts:39-45` (no `TokenBudget`), `README.md:113`.

**A3-06: `docs --budget` with a non-numeric value silently disables the spend cap.** Medium.
- Evidence: `atlas docs --offline --budget abc` generates every module and prints `budget remaining NaN`, exit 0.
  `parseInt` gives `NaN`, and every `x > NaN` budget check is false. `--budget -5` silently skips everything. The config
  key is zod-validated (`int().positive()`); the flag is not.
- Test: `A3-06`.
- Location: `src/cli/commands/docsCmd.ts:89`, `src/core/synth/budget.ts:13`.

**A3-07: numeric parameters are unvalidated on the CLI and HTTP but validated on MCP.** Medium.
- Evidence: `search --limit=-1` and `/api/search?limit=-1` return every hit except the last (`slice(0, -1)`), 18 of 19.
  `--limit abc` exits 1 with `atlas: datatype mismatch`, and `limit=abc` returns **500** `{"error":"datatype mismatch"}`.
  `--limit 1.5` is treated as 1. `ask --k=-1` retrieves 20 snippets (everything), `--k 0` still calls the LLM with zero
  snippets, and `--k abc` gives `datatype mismatch`. MCP rejects all of these with zod (`limit 1..100`, `k 1..20`,
  `expand 0..20`). `serve --port abc` fails with a raw Node error (`Received type number (NaN)`).
- Tests: `A3-07`, `A3-07b`.
- Location: `src/cli/commands/searchCmd.ts:57`, `src/web/server.ts:130`, `src/cli/commands/askCmd.ts:43-44`,
  `src/core/vector/search.ts:50,114`.

**A3-08: unknown kinds and empty queries fail differently on each surface.** Medium.
- Evidence: an unknown kind gives CLI exit 1 (`unknown kind 'bogus'`), MCP `isError` (enum), and **HTTP 200 `[]`**. HTTP
  also does not trim, so `kind=method,%20class` drops every class (0 classes, against 3 on the CLI). An empty query gives
  CLI `search ""` exit 0 with `[]`, HTTP 200 `[]`, and MCP `isError` (`query must not be empty`). On the CLI itself,
  `ask "  "` exits 1.
- Tests: `A3-08`, `A3-08b`.
- Location: `src/web/server.ts:131-139`, `src/cli/commands/searchCmd.ts` (no empty-query check),
  `src/mcp/server.ts:117,271-272`.

**A3-09: missing roots and missing indexes cause writes, and the errors differ by surface.** Medium.
- Evidence: `createMcpContext({root: <nonexistent>/repo})` (that is, `atlas mcp --cwd <typo>`) creates
  `<nonexistent>/repo/.atlas/index.db`, and `atlas_index` then succeeds with `filesScanned: 0`. The CLI `index` exits 1
  (`path does not exist`). CLI read commands (`search`, `drift`, `ask`, `graph`, `docs`) on an unindexed directory fail
  with the cryptic `atlas: unable to open database file`, which does not say "run atlas index", and leave an empty
  `.atlas/` behind: `mkdirSync` runs even with `fileMustExist`. `init --cwd <nonexistent>` also creates the path.
- Tests: `A3-09`, `A3-09b`.
- Location: `src/mcp/server.ts:56` (`openDatabase` without `fileMustExist`), `src/core/db/database.ts:140-142`.

**A3-10: the `indexPath` config key can write the index outside `.atlas/`, and it is undocumented.** Medium.
- Evidence: with `.atlas/config.json` set to `{"version":1,"indexPath":"index.db"}`, `atlas index .` creates `<target>/index.db`.
  `git status` shows `?? index.db`, which contradicts the README guarantee "only writes to its own index under
  `.atlas/`". `../x.db` escapes the target entirely. It is rated Medium rather than High because it needs an explicit
  config edit. The key is not in the README.
- Test: `A3-10`.
- Location: `src/core/config.ts:14,49`.

### Low

**A3-11: search hits have different shapes and field semantics on each surface.** Low.
- Evidence: see the matrix. `line` (CLI, HTTP) against `startLine`/`endLine` (MCP). Only HTTP has `id`, only the CLI has
  `semanticScore`/`structuralScore`, and only MCP has `signature`/`docstring`. MCP rounds `score` to 3 dp, so the top 3
  "area" hits all show `0.023` although they are ranked. `name` is the **qualified** name in search hits but the bare
  name in graph nodes and `atlas_symbol` (which add `qualifiedName`).
- Test: `A3-11`.
- Location: `src/cli/commands/searchCmd.ts:66-76`, `src/web/server.ts:145-152`, `src/mcp/server.ts:124-133`.

**A3-12: doc listings have different shapes and keys on each surface.** Low.
- Evidence: `docs --list` prints `[file:<numeric id>]`, there is no `--json`, and `--show` takes a path. `/api/docs`
  returns raw `DocRow` (`target_kind`, `target_id`, `source_hash`) addressed by numeric file id. `atlas_docs` uses
  `{kind, target: <path>, sourceHash}`.
- Repro: `atlas docs --list --cwd T; curl :PORT/api/docs` and MCP `atlas_docs {}`.
- Location: `src/cli/commands/docsCmd.ts:52-61`, `src/web/server.ts:100-103`, `src/mcp/server.ts:204-214`.

**A3-13: flag names and short options collide; `index` lacks `--cwd`; path bases differ.** Low.
- Evidence: `-k` means `--kind` in `search` but `--k` (seed count) in `ask`. `-f` means `--format` in `graph` but
  `--force` in `init`/`index`/`docs`. `atlas index --cwd X` fails with `error: unknown option '--cwd'` (exit 1), although
  every other project command, and the README's MCP config, use `--cwd`. `drift --docs-dir` resolves against `--cwd`,
  while `graph --out` and `ci-comment --in/--out` resolve against the process cwd.
- Test: `A3-13`.
- Location: `src/cli/commands/askCmd.ts:24`, `searchCmd.ts:30`, `graphCmd.ts:18`, `indexCmd.ts:20-24`,
  `driftCmd.ts:36`, `graphCmd.ts:39`, `ciCommentCmd.ts:18,23`.

**A3-14: the README is out of sync with `--help`.** Low.
- Evidence: the README has no command reference. These flags exist but appear nowhere in it: `search --file/--json`,
  `ask --k/--expand/--json/--model`, `docs --force/--model/--budget/--list/--verbose`,
  `drift --json/--strict/--skip-architecture`, `graph --out`, `index --force/--verbose`, `init --force`,
  `serve --port/--host`. The `ci-comment` command (`--in/--out`) is mentioned only in prose. Config keys `indexPath` and
  `embeddingModel` are undocumented, and `synthModel` is described without its key name. The test count ("62 tests",
  README:195) is stale (the suite has 280+). The README also contradicts drift's exit codes (A3-02) and the `ask` spend
  cap (A3-05).
- Repro: `for c in …; do atlas $c --help; done` compared against `grep -- --flag README.md`.
- Location: `README.md:63,113,195`, `README.md` §Configuration.

**A3-15: `--kind module` is accepted everywhere but can never match.** Low.
- Evidence: `search shapes --kind module --json` returns `[]` with exit 0. The CLI's `VALID_KINDS` and the MCP enum both
  allow `module`, but `search()` always drops module symbols.
- Test: `A3-15`.
- Location: `src/core/vector/search.ts:82,120`, `src/cli/commands/searchCmd.ts:22`, `src/mcp/server.ts:33`.

**A3-16: unknown `/api/*` routes return 200 with the HTML shell.** Low.
- Evidence: `curl -w %{http_code} :PORT/api/nope` returns `<!doctype html>…` with status 200 (SPA fallback). A client
  that mistypes a route gets HTML instead of a JSON 404.
- Test: `A3-16`.
- Location: `src/web/server.ts:157-181`.

**A3-17: the public core type exports are incomplete.** Low.
- Evidence: `StaleKind` (the type of the exported `StaleDocReport.kind`) and `OpenDbOptions` (the parameter type of the
  exported `openDatabase`) are not re-exported from `src/core/drift/index.ts` or `src/core/db/index.ts`. The other
  non-re-exported symbols are parser internals.
- Repro: compare `export` declarations in `src/core/*/*.ts` against the module's `index.ts`.
- Location: `src/core/drift/detect.ts:28`, `src/core/db/database.ts:9`.

## Found clean

- **Graph export:** `graph --format json`, `/api/graph` and `atlas_graph` are identical (same `buildGraphJson`; pinned
  test). DOT is shared between the CLI and MCP.
- **Search ranking:** the CLI, HTTP and MCP return the same result set in the same order for the same query, kind,
  file and limit (pinned test). Filters apply before truncation. FTS input is reduced to quoted alphanumeric terms, so
  user text cannot inject MATCH syntax.
- **Ask:** `ask --json` and `atlas_ask` return identical `answer`, `citations`, `checks`, `flagged` and token counts
  (pinned test). `--offline` behaves the same on `docs`, `ask` and `mcp`. A missing key fails with the same message on
  every surface.
- **Drift on real changes:** after an edit made without re-indexing, CLI DB mode, CLI `--docs-dir` and MCP (default and
  `persisted`) all report the same `stale` entry (`currentHash: "unindexed"`), and the CLI exits 2.
- **Dashboard is read-only:** `serve` opens SQLite with `readonly: true, fileMustExist: true`
  (`src/cli/commands/serveCmd.ts:24`); the read-only path skips migrations and pragmas; the HTTP handler has no write
  path; static serving is confined to the static root. `app.js` calls only endpoints that exist (`/api/stats`,
  `/api/files`, `/api/graph`, `/api/doc/architecture`, `/api/doc/file/:id`, `/api/search`), and the kind dropdown matches
  the valid kinds.
- **Target writes:** on a git checkout of the sample, `index`, `docs`, `drift`, `search` and `ask` leave
  `git status --porcelain --ignored` showing only `.atlas/` (A3-09 and A3-10 are the exceptions).
- **API key:** read only from `ANTHROPIC_API_KEY` (`src/core/synth/llmClient.ts:31`) and never logged. With a canary key
  and a fake endpoint returning 401, the stdout and stderr of `ask`, `ask --json` and `docs` contained no part of the key.
  No source path prints the key.
- **Air-gap:** source text goes only to the Anthropic API, through `docs` and `ask`/`atlas_ask` (excerpts), as Atlas's
  CLAUDE.md allows. `ci-comment`, drift JSON, the dashboard API and the graph export contain metadata only. `atlas_symbol`
  returns excerpts to the local MCP client only.
- **Config:** `languages`, `include`, `exclude` (walk), `tokenBudget` (`docs`, MCP), `embeddingModel`
  (`createEmbedder`, which rejects unknown models) and `synthModel` (`docs`, `ask`, MCP) are all wired. Invalid config
  files fail with a zod message naming the key.
- **Help text:** every documented README flag exists, and `drift --help` states the exit codes correctly.
