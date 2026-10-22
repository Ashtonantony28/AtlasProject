# DECISIONS

A running log of non-obvious architectural choices and their rationale. Append
one short entry per decision (newest at the bottom).

---

## 2026-05-20 — Lint/format: ESLint + Prettier (not Biome)
ESLint v9 flat config + Prettier. Mature TS plugin ecosystem, easier to debug
when CI fails. CLAUDE.md said "pick one and move on".

## 2026-05-20 — Embeddings storage: bootstrap with BLOB, finalize with sqlite-vec
Phase 1 created `embeddings(symbol_id, model, dim, vector BLOB)` so the
schema worked on any SQLite build. Phase 4 swapped this for a real
`sqlite-vec` setup (migration v2): `embeddings_vec` (vec0 virtual table,
fixed-dim `float[384]`) for KNN, plus an `embeddings_meta(symbol_id, model,
dim)` side-car since vec0 doesn't carry user metadata. `openDatabase` loads
the extension on every open (read-only and read-write) so the virtual table
is queryable from `atlas serve` and `atlas search`. The old BLOB table is
dropped by the v2 migration; running `atlas index` regenerates embeddings.

## 2026-05-20 — Tree-sitter pin: 0.21.x line, tree-sitter-python pinned to 0.23.2
tree-sitter-python@0.23.6 requires tree-sitter@^0.22, but tree-sitter-javascript
and tree-sitter-typescript still target 0.21. Pinning python to 0.23.2 (which
accepts ^0.21.0) keeps the native bindings on a single tree-sitter version. Re-
visit when JS/TS grammars publish 0.22-compatible builds.

## 2026-05-20 — Synthesis model default: claude-sonnet-4-6
Sonnet 4.6 is the right default for doc synthesis: cheaper than Opus, strong
enough for grounded summaries. Users can override per-run.

## 2026-05-20 — Imports table separate from edges
Imports are recorded as their own table during ingestion (raw module strings,
aliases) and *also* materialized into the edges table during the Phase 3
resolver pass. Keeping the raw form lets the resolver re-run as the graph
algorithm improves without re-parsing every file.

## 2026-05-20 — Weak edges, not dropped edges
Unresolved references are stored with `weak = 1` rather than discarded. This
makes precision/recall tradeoffs visible and lets later passes upgrade them.

## 2026-05-20 — Local embedding fallback
Phase 4 will ship with a deterministic, dependency-free "local-hash-v1"
embedding so semantic search works offline and in CI without API spend. A real
provider (Voyage / Anthropic) can be wired in behind the same interface later.

## 2026-05-20 — Phase 8 dashboard: vanilla JS + SVG (not Vite/React)
CLAUDE.md §3 lists Vite/React/force-graph for the dashboard. For the minimal
v1 dashboard the DoD asks for (graph + doc browser + search), vanilla JS with
SVG hits the bar without adding ~50 dependencies and a build pipeline. The
HTTP API surface (Phase 8 backend) is independent of the frontend
implementation, so swapping in Vite/React later is a self-contained change.

## 2026-05-20 — Drift exit code: 2 (not 1)
`atlas drift` uses exit code 2 so CI scripts can distinguish drift ("there is
work to do") from generic command failure (exit 1). Conventional for "soft
failure".

## 2026-05-20 — Phase 10 wrap-up
- Hash-based incremental indexing was already in place from Phase 2; added a
  short-circuit that skips the resolver pass when no files changed, so a
  no-op `atlas index` finishes in ~15ms on the fixture (DoD: "near-zero
  work").
- Packaging: `bin` + `files` + `prepublishOnly` are wired; the built CLI
  retains its shebang so `npx atlas` works once published.
- Demo script `scripts/demo.sh` runs the entire surface against the bundled
  fixture using the offline LLM, exercising every CLI command in order.
- Smoke-tested on Atlas's own source: 69 files → 469 symbols → 757 edges in
  ~400ms.

## 2026-05-20 — DoD audit, gap-fix pass
A re-read of each Phase's DoD turned up five real gaps. All closed:
- Phase 2 — added signature + docstring + span assertions to the indexer
  test (the DoD asked for "expected symbol count **and a few known
  signatures**"; previous test only checked names).
- Phase 4 — swapped the BLOB embeddings table for a real `sqlite-vec` vec0
  virtual table (matching CLAUDE.md §3 + §5). `openDatabase` loads the
  extension before migrations; migration v2 drops `embeddings` and creates
  `embeddings_vec` + `embeddings_meta`. Search now uses vec0's KNN MATCH
  instead of a full-scan cosine. Note: vec0 requires `BigInt` rowids;
  store.ts wraps integer ids accordingly.
- Phase 5 — the offline mock now extracts every `[kind] name (file:line)`
  bullet from the synthesis prompt and renders them in the doc, so docs
  literally reference real symbols. Added a low-cap structure smoke test
  (perDocMaxTokens=120) that asserts each doc still has a heading and
  cites a file:line — the second half of the DoD.
- Phase 8 — JSDOM-based rendering test that runs the dashboard's app.js
  with a stubbed fetch and asserts the file list, graph nodes/edges, doc
  browser, and search results all populate (the "in-browser" half of the
  DoD; the API-side was already covered).
- Phase 9 — added an end-to-end CI pipeline test (index → docs → drift →
  ci-comment) that asserts the exact payload the workflow posts, for both
  the clean and the drift cases. Stands in for `act --dry-run`.

## 2026-05-20 — Final summary
Atlas ships its end-to-end pipeline: walk → parse → graph → embed → search →
synth → ask → drift, with a local dashboard and a CI PR comment workflow.
60+ tests, 0 lint errors, strict TS. The whole thing runs offline by default
(deterministic local embeddings via `local-hash-v1`, sqlite-vec for storage
and KNN, mock LLM) and switches to the real Anthropic API by exporting
`ANTHROPIC_API_KEY`. Future work (out of scope for v1): proper call-graph
resolution via tree-sitter queries rather than a regex heuristic, language
coverage beyond TS/JS/Python, and a real Vite/React dashboard if/when the
vanilla one's limits start to bite.

## 2026-05-22 — Tree-sitter chunked input (large-file fix)
`Parser.parse(string)` on the node-tree-sitter bindings throws
"Invalid argument" once the input exceeds an internal buffer threshold
(~32KB in practice). This silently killed 6/78 files when indexing
`sindresorhus/got` (`source/core/index.ts`, `options.ts`, `test/hooks.ts`,
etc. — all in the 33KB-106KB range). Switched `parseSource` to always feed
input through the callback path (`parser.parse((index) => source.slice(...))`)
in 8KB chunks, which has no such limit. Result on got: 78/78 files parse, no
"failed" rows. No effect on small files. The chunk size is internal only.

## 2026-05-22 — CommonJS require() in the JS parser
The original parser only handled ESM `import` declarations, so CommonJS
projects (Express et al.) produced `imports=0` and a near-empty graph.
Added `collectRequires` to the JS/TS visitor: when a top-level
`const/let/var x = require('m')` is seen, emit an import. Four forms
supported:
  - `const x = require('m')`            → default
  - `const x = require('m').y`          → named `y`, aliased `x`
  - `const { a, b: c } = require('m')`  → named `a`, named `b` aliased `c`
  - bare destructure / fallback         → default
Scoped to top-level declarations (`ctx.qualifier.length === 0`) to avoid
noise from dynamic requires inside function bodies. Effect on Express:
imports go from 0 → 387, edges 3 → 407. Test: `parser.test.ts` covers all
four forms.

## 2026-05-22 — Architecture-doc mock now uses the Files: section
The offline mock for synthesis was matching only the "Symbols:" block, which
exists in module prompts but not architecture prompts (those have "Files:"
and "Top connected files:"). Architecture docs were rendering as
"_No symbols extracted._" — a real DoD regression on Phase 5.
Updated `createOfflineClient` to detect `Target: architecture overview`,
parse the Files + Top connected sections, and emit a structured doc with a
totals header, a "Modules" list, and a "Key collaborations" list. The
synthesize test now asserts the architecture doc references real module
paths and the correct totals. Module-doc behavior is unchanged.

## 2026-05-22 — External-repo verification
Ran the full pipeline against two real third-party repos (no fixture) via
`scripts/verify-external.sh`:
  - `sindresorhus/got` @ HEAD — 78 files, 2702 symbols, 656 imports,
    1093 edges (614 weak). `source/index.ts::got` resolves to a variable;
    search for "retry delay" surfaces `source/core/options.ts` in the top 5.
  - `expressjs/express` @ HEAD — 141 files, 1897 symbols, 387 imports,
    407 edges. `lib/express.js::createApplication` resolves to a function;
    search for "create application" returns it as the #1 hit.
The packaged tarball (`npm pack`) installs cleanly into a fresh
`npm init -y` directory; `node_modules/.bin/atlas` exposes the full CLI.
Workflow comment payload verified by `test/ci/workflow.test.ts` for both
the clean and drift cases (stands in for `act --dry-run`, which isn't
available in this environment); also smoke-tested end-to-end by running
the workflow steps manually against a temp checkout.

## 2026-10-21 — SG0: shared interfaces + bench baseline
Migration v3 adds `symbols.exported` and an FTS5 `symbols_fts` (external
content, trigger-synced) for SG5's lexical leg. `createEmbedder(config)` is the
single place an embedder is chosen. `scripts/bench.mjs` baseline on Atlas itself
(75 files, 690 symbols): index 595 ms, 2.6 ms/file median, no-op re-index 10 ms,
search p50 1.7 ms / p95 3.7 ms. The 10k-symbol search budget is measured in SG5.

## 2026-10-21 — SG4: resolver reads CST references
The parsers record call (`f()`, `this.m()`/`self.m()`, `super.m()`, `ns.m()`,
`new C()`) and heritage references per enclosing symbol; migration v4 stores them
in `refs` (deduped per symbol) and resets file hashes so old indexes re-parse.
The resolver no longer reads source, so comments and strings cannot produce
edges. Weak policy: unresolved calls through an import binding and unresolved
`this`/`super` calls are weak; calls on unbound names or receivers (builtins,
locals, parameters) produce no edge. Methods of `module.exports = {...}` and
`export default {...}` are qualified as `default.<name>` and importable by name.
Golden edges for the resolver live in `fixtures/graph/expected-edges.json`.
## 2026-10-21 — SG5: hybrid search via weighted RRF
`search()` unions three candidate sources: vec0 KNN, FTS5 (`symbols_fts`, bm25
weighted 10/5/1 over name/qualified_name/docstring) and an exact-name lookup on
`idx_symbols_name`. Rankings are fused with RRF (k=60); `semanticWeight` /
`structuralWeight` (0.6/0.4) now weight the semantic list vs the lexical +
structural lists. FTS queries are built only from identifier tokens, each
quoted and OR-ed, so user text never reaches MATCH syntax. Kind/file filters
are pushed into SQL and into vec0 KNN as `rowid IN (subquery)`, which sqlite-vec
pre-filters exactly. Bench on `--target synthetic10k` (10,206 symbols): search
p50 18.8 ms / p95 27.7 ms (KNN ≈ 11 ms + FTS ≈ 9 ms dominate).

## 2026-10-21 — SG8: config inside `.atlas/`, exitCode over exit
Config moved to `.atlas/config.json` so Atlas writes nothing in the target
outside `.atlas/`; a root `atlas.config.json` is still read as a fallback but
never written (and `init` leaves it in charge). `include` defaults to `[]`
(everything) and, like `languages`, now filters the walk. CLI actions set
`process.exitCode` and return instead of calling `process.exit` inside
`try/finally`, so the DB is always closed; the top-level catch still exits 1.
`buildProgram()` (src/cli/program.ts) lets tests drive commands in-process.

## 2026-10-21 — SG6: prompt-hash docs, persisted docs, non-fatal undocumented
`docs.source_hash = sha256(prompt)`; the module prompt now carries the file's
`Content hash:` line, so any source edit *and* any change to the module's call
neighbourhood marks its doc stale (no false negatives from edits outside the
source excerpts). Prompts are capped (module 6k chars, architecture 12k) by
dropping excerpts, then halving the symbol list, exported symbols kept first;
call edges come from per-file indexed SQL (strongest first, 12 each). Budget
checks reserve ~3 chars/token of input + `perDocMax` before every call, so
spend never exceeds the cap. `atlas docs` mirrors docs to `.atlas/docs/`
(`files/<path>.md`, `architecture.md`, front matter with `source_hash`) and
seeds its cache from them; `atlas drift --docs-dir .atlas/docs` checks those
from a fresh index, which is what CI runs (docs are not regenerated in CI).
Undocumented = exported, non-module symbols not named as a whole identifier
(case-sensitive) in their doc; they are reported but exit 0 unless `--strict`,
since Phase 7's DoD makes only stale docs fatal and LLM docs cannot be required
to name every export. Cached synthesis on 1,002 files: ~0.2 s; got: 98k of 200k.
## 2026-10-21 — SG7: grounded Q&A citation checks
`ask` parses `[n]` and `path:line[-end]` references from the answer
(`checkCitations`) and returns them as `checks`, with `flagged` holding those
outside the retrieved snippets (`unknown-snippet`, `unknown-file`, or
`out-of-range` when no single snippet span covers the lines). A cited path
matches a snippet file exactly or as a `/`-bounded suffix. Flags are reported,
not fatal: the CLI prints an "Unverified citations" section and `--json`
includes `checks`/`flagged`; exit code is unchanged. Excerpts now cover
`start_line..end_line` (no trailing context) capped at 120 lines per snippet
(`excerptLines`), with a `… [truncated: N more lines through line L]` marker
and `truncated: true`; at the default 10 snippets that bounds excerpts to
~1.2k lines, far below `tokenBudget`. Graph expansion keeps each neighbor's
best edge and ranks resolved before weak, then extends > implements > calls >
imports > references, then seed rank, then edge id.

## 2026-10-21 — SG9: MCP server alongside `docs`/`ask`
`atlas mcp` (src/mcp/server.ts, `@modelcontextprotocol/sdk` stdio) is an extra
surface over `core/`; unlike `relaxed-knuth-DHc0Q` it keeps `synth/`, `docs`
and `ask`. Tools: index, search, symbol, graph, drift (`persisted` checks
`.atlas/docs`), docs (read-only; index first, `.atlas/docs` fills gaps; no
synthesis, so no spend outside `ask`) and ask (returns SG7 `checks`/`flagged`).
Handlers throw and the SDK turns errors, including zod validation failures, into
`isError` results. `atlas_ask` goes through a per-session `TokenBudget` of
`tokenBudget` that refuses a call when ~chars/3 input + `maxTokens` exceeds
what is left; the Anthropic client is created lazily so the server starts
without a key. The DB is closed on process exit, after in-flight calls finish.

## 2026-10-21 — SG11: parser never throws; diagnostics; unindexed edits are stale
CST walks are iterative: `visit` pushes children (and a scope-restore closure)
onto an explicit stack via `walkFrames`, preserving pre-order, so a 20k-term
expression parses. `dotted` and CJS `a = b = c` chains are loops too.
`ParseResult.diagnostics` lists ERROR/MISSING nodes (first 20, then one
`warning` with the remainder; error-free subtrees are skipped) and, as a last
resort, a caught walker or tree-sitter failure (partial results + `error`).
Diagnostics are not stored (no migration): `IndexStats.filesWithDiagnostics`
and `atlas index` report the count, `--verbose` the per-file number. Drift now
also hashes each documented file on disk; if it differs from the indexed
`content_hash` (edited, or a failed re-index kept the old rows per SG2), the
doc is stale with `currentHash: "unindexed"`.

## 2026-10-21 — SG12: drift completeness (neighbourhood hash, tombstones, docs-dir)
`source_hash` is still `sha256(prompt)`, but the module prompt header now has a
`Neighbourhood hash:` line (sha256 over every resolved cross-file edge, both
directions, all kinds, as `dir kind weak symbol path#other`, uncapped), and the
architecture prompt a `Files hash:` (all paths); caps still apply to the rest.
Neighbour content hashes and signatures are not hashed, so editing a callee's
body does not stale its callers (no new false positives). Shown calls rank by
call pairs per counterpart file (the old `ORDER BY COUNT(*)` was always 1).
All existing docs go stale once after upgrading. Pruning turns a file's doc
into a `deleted_file` tombstone row (JSON `{path, content}`; hidden from
`getAllDocs`/`counts`, cleared by `synthesizeDocs`), so DB-mode drift reports
it `missing`; a file with no doc and no exports is listed as an undocumented
`module` (non-fatal unless `--strict`). Persisted docs are read with CRLF
normalised. `drift --docs-dir` exits 1 when the dir is missing or has no docs
while files are indexed, so CI cannot pass silently (CI is red until Atlas's
own docs are committed). `.atlas/config.json` is no longer gitignored (it holds
no secrets) so CI indexes with the committed filters. `atlas index` still
exits 0 when `filesFailed > 0`: drift reports those files as `unindexed`.

## 2026-10-21 — SG10: re-exports and default exports in the resolver
Migration v5 adds `imports.reexport`. `export … from`, `export *`, `export * as ns`
and `module.exports = require(...)` are re-export rows (the barrel gets an import
edge per row but no local binding); `export default x`, `export = x`,
`export { x as y }` and `module.exports = x` are rows with `module: ''` naming the
local. The resolver's `exportOf(file, name)` follows own symbols, import bindings
(so Python `__init__` names and CJS `const x = require()` variables are followed),
re-export rows and star targets, with a per-chain `seen` set against cycles and a
memo for top-level lookups only. A consumer importing through a barrel gets edges
to the defining symbol and to the barrel. Calling a binding whose default is
unknown (packages, object exports) still resolves to the local require variable,
as before. Member calls on a function default fall back to its module's exports
(`exports.m`); class defaults do not. JSX capitalised tags are calls; dynamic
`import()`/nested `require()` add binding-less imports; Python function-local
imports bind file-wide; calls to names from a Python star import resolve through
it, or are weak when a star target is not indexed.


## 2026-10-21 — SG13: one contract for drift, params and docs across surfaces
Drift gate: `DriftReport` gains `failing` (stale docs, or undocumented symbols
with `strict`) and `strict`; `atlas drift` exits 2 exactly when `failing`, and
the CI job, README and `ci-comment` ("Drift check: passed/failed") key off it.
`hasDrift` keeps its meaning ("anything to report"), since tests and JSON
consumers rely on it; redefining it would silently hide undocumented-only
reports, so a new field is the least breaking choice (A3-02's test now checks
`failing`). `runDrift` (core) is the one entry point for the CLI and MCP and
throws when there is nothing to check: `--docs-dir`/`persisted` missing or
empty, or no docs in the index (exit 1, MCP `isError`). Shared zod schemas in
`core/params.ts` validate search/ask/budget/port on the CLI, HTTP (400) and MCP;
`module` is no longer a search kind. `listDocs`/`findDoc` (index, then
`.atlas/docs`) back `docs --list/--show`, the dashboard and `atlas_docs`.
`ask` goes through the same `budgeted` client as MCP. `openProjectIndex` and
`requireRoot` make read commands fail without creating `.atlas/`; `indexPath`
must resolve inside `.atlas/`. MCP still creates the index in an existing root
(it serves `atlas_index`).


## 2026-10-21 — SG17: a read or parse failure is never a deletion
`walkRepoReport` returns the files plus the directories (`lib/`, root `''`) and
files it could not read or stat; `walkRepo` keeps its old shape. `indexRepo`
keeps every indexed row under an unreadable path (no prune, no doc tombstone)
and counts each unreadable entry once in `filesFailed` with an `onFile` failure,
so it heals on the next readable run. For parsing, `parseSource` still never
throws (§Interfaces); the indexer calls `parseSourceOrThrow`, which throws only
when tree-sitter yields no tree, so the old rows and hash stay and the file is
retried. Partial extraction (a walker bug after a tree exists) is still stored
with an internal diagnostic, as in SG11: retrying a deterministic bug forever
would leave the file unindexed. `npm run typecheck` also runs
`tsconfig.test.json`. `startServer` reports the bound port, so `--port 0` works.


## 2026-10-21 — SG14: vec0 point deletes; exact search kept, ANN deferred
vec0 executes `rowid IN (...)` as a scan of every chunk, so
`deleteEmbeddingsForFile` deletes one rowid at a time with cached statements
(`prepareCached`, memoised per connection) inside the caller's transaction.
Search stays exact: filters resolve file ids first (`file_id IN (SELECT id FROM
files ...)`) and drop the `files` join, FTS ranks `symbols_fts` alone with a
2x over-fetch and falls back to the filtered join only when that cannot fill
the pool, and vec0 similarity point reads (about 0.3 ms each) are done only for
lexical hits that can still reach the top `limit`. At 150k symbols the floor is
vec0's brute-force float KNN itself (110–130 ms for any k on this machine), so
the 100 ms p95 target needs approximate KNN. Measured option: a SimHash
`bit[768]` vec0 table (sign of a seeded Gaussian projection; plain
`vec_quantize_binary` has 0.15 recall on the sparse local-hash vectors) with
exact rerank of k'=80/160 candidates costs 50/90 ms at 0.70/0.88 recall@80
(0.98/0.99 recall@10). That needs migration v6, backfill and makes the KNN
candidate list approximate, so it is left for a decision rather than shipped.
## 2026-10-21 — SG15: RPC responses are bounded, files and pipes are not
`atlas_graph`, `atlas_drift` and `/api/graph` take shared params
(`graphParams`, `driftParams` in `core/params.ts`): graph `file` (path
substring, like search), `symbol` (name or qualified name; `depth` 1–3 hops
over edges either way), `limit` nodes (default 1000, max 5000), `edgeLimit`
(2000, max 10000), `offset`; drift `limit` (100, max 1000) and `offset`, applied
to each of `stale` and `undocumented`. Nodes are ordered by id; edges are those
whose non-null endpoints are all on the page. Both shapes report `totals`
(graph `{nodes, edges}` in scope; drift `totals.stale`/`totals.undocumented`)
and `truncated`, so a client always knows what it is not seeing; `failing`,
`hasDrift` and counts cover the whole report. MCP results are compact JSON and
drift's `formatted` text is opt-in (`formatted: true`). The CLI accepts the same
flags (`--limit`, `--edge-limit`, `--offset`, `--file`, `--symbol`, `--depth`)
but exports everything when `--limit` is absent: `graph`/`drift --json` write
to files and pipes, not a 10 MiB RPC frame, and `ci-comment` needs the full
report. `/api/stats` uses `counts(db)` plus `countDocs` (index targets ∪
`.atlas/docs` file names) instead of materialising tables and doc bodies.

## 2026-10-21 — SG16: parse+insert under 5 ms/file on express and got
Profiling showed the CST walk, not tree-sitter, dominated: every `node.type` was
a native call (tree-sitter 0.21 tries to put `type` on each per-symbol node
class, but the inherited getter swallows the write), and every node was
materialised (a JS object plus a weak finaliser) just to be skipped. Now:
`getBundle` stores `type` on each class's prototype on first read; `visit` reads
the type once and returns whether to walk the node's children, which
`pushDescendants` does with one cursor that only materialises node types
`visit` acts on (per module or member scope); plain calls and member callees are
read through the cursor (`addCallAt`) without materialising anything; and
`forEachOfType` uses native `descendantsOfType` above 100 descendants (it costs
about 20 µs a call to resolve type names, so small bodies stay on a cursor).
Per-row statements in `repo.ts` use `prepareCached`. Output is unchanged:
`test/parse/golden.json` pins the full `ParseResult` of every fixture file
(generated by the pre-SG16 code, incl. new `fixtures/parse/` call shapes), and
verify-external counts are identical (express 141/2052/417/1554, got
96/5752/1098/5004 files/symbols/imports/edges). `scripts/bench.mjs` medians,
interleaved with the pre-SG16 build on the same (shared) machine, 8 runs each:
express 5.4 → 2.1, got 8.3 → 4.75 (4.27 over 7 quieter runs), self 4.4 → 2.6
ms/file. Warm parse alone: express 3.5 → 1.25, got 5.1 → 2.75. What is left on
got's median file is tree-sitter's own parse (~1.3 ms cold), the cursor walk
(~1.4 ms cold) and inserts (~0.8 ms, a third of it the FTS trigger), so heavy
contention can still push got near 5.

## 2026-10-22 — SG21: no sampling params, 16k max_tokens, incomplete completions are failures

Requests send no `temperature`/`top_p`/`top_k` (current models and API `2026-10-21` reject them). Per-doc and `ask` `max_tokens` default to 16 000 (the non-streaming default; thinking counts toward it), so the budget reserves ~16k per call and a run stops ~16k short of `tokenBudget`. A `stop_reason` other than `end_turn`/`stop_sequence`, or empty text, is never stored: `docs` reports the target as failed and exits 1, `ask` errors.

## 2026-10-22 — SG22: graph pages own their nodes' outgoing edges
A7-02: a page used to return only edges with both endpoints on it, so paging
lost almost every edge. Now an edge belongs to the page holding its `src` (its
`dst` when `src` is null) and its far endpoint, which must be in scope, may be
on another page; paging through all nodes yields each in-scope edge exactly
once and `totals.edges` is their sum. Chosen over independently paged edges
because it keeps the published params (`limit`/`edgeLimit`/`offset`) and
fields unchanged, and over far-endpoint stubs to keep pages small. Unscoped
pages select owned edges by id range with `LIMIT edgeLimit+1`; scoped pages
read only `src IN page` rows (a subset of what they read before, so A6-01 is no
worse; `totals.edges` still materialises the scope's edges). `truncated` now
matches drift: true when `offset > 0`, more nodes follow, or `edgeLimit` cut
the page. The dashboard names what was cut (symbols, or else edges) (A7-12).
A7-05: `search`, `graph`, `ask` and `drift` reject an empty index like the MCP
tools, via `openProjectIndex(…, { indexed: true })` / `requireIndexed`, with
the same "index is empty: <next step>" message.

## 2026-10-22 — SG20: walk skips follow `.gitignore` and config, not names at any depth

Only `.git`, `.atlas`, `node_modules` and `__pycache__` (never project source) and virtualenvs (a directory holding `pyvenv.cfg`) are skipped at any depth. `dist`, `build`, `coverage`, `venv`, `.next`, `.cache` are root-anchored entries in the default `exclude` (`.venv/**`, `venv/**`, `.next/**`, `.cache/**` added to the default value; no new keys), so `src/build/` is indexed and a user can drop an entry to index the root one. Nested `.gitignore` files are now read (deeper files override shallower ones, `exclude` is applied last), which keeps `packages/*/dist` out where a package ignores it. Persisted docs strip a leading BOM before parsing front matter; `ci-comment` validates its input and counts from `totals`, noting when the lists are a page.

## 2026-10-22 — SG23/SG24: perf budgets run serially; coverage gate on src/core
Wall-clock budgets (search p95 ≤ 50 ms, cached synthesis and drift ≤ 1 s, limits
unchanged) moved to `test/perf/` and run only under `npm run test:perf`
(`vitest.perf.config.ts`: one fork, no file parallelism, a warm-up pass before
measuring); the default config excludes them, so parallel-suite load cannot fail
them (A6-06, A8-12). Chosen over env-gating or wider margins because the budgets
stay enforced in CI at their frozen values. CI runs `npm run test:coverage`
instead of `npm test` (same suite, plus `src/core` thresholds lines 90 /
branches 88 / functions 96, aggregated over the glob), then `test:perf`. SG17's
unreadable-path guarantees, the search FTS filter fallback and drift paging's
gate invariance now live in `test/ingest`, `test/vector` and `test/drift`.

## 2026-10-22 — SG19: bare specifiers resolve through tsconfig `paths`/`baseUrl`, workspaces and Python roots

Module-specifier resolution moved to `src/core/graph/modules.ts` (`ModuleResolver`), built once per `resolveGraph`. Config files are read from `root` (read-only, cached), and only directories that hold indexed files are listed, once each, so cost does not grow per import. JS/TS order: relative path, then the nearest `tsconfig.json`/`jsconfig.json` (JSONC; local `extends` chains, arrays, solution-style `references`; package `extends` such as `@tsconfig/*` are not followed) with TS's rules (exact pattern, else longest wildcard prefix; targets relative to `baseUrl`, else to the config that defines `paths`), then `baseUrl`, then workspace packages (`package.json` `workspaces` array or `{packages}`, `pnpm-workspace.yaml`, `!` exclusions). A package entry tries `exports` (`source` > `types` > `import` > `module` > `default` > `require` > `node`, subpath and `*` patterns), then `source`/`module`/`main`/`types`, then `src/index`; a `dist|lib|build|out/` target that is not indexed is retried under `src/`. A name declared by two workspace members resolves to nothing. Python absolute imports try the repo root, the importer's top-level package root, then `src/` beside the root or any pyproject.toml/setup.cfg/setup.py, the dirs those configs name (`where`, `package_dir`, poetry `from`), then a discovered package root only when exactly one holds that top-level package. Unreadable or malformed configs are skipped and listed in `ResolveStats.diagnostics` (new field). No schema or config change. Known gap: a change to only a tsconfig/package.json does not trigger re-resolution on a no-op re-index (use `--force`).

## 2026-10-22 — SG18: assigned/anonymous functions, namespaces, `references` edges

Module-level `obj.m = function`, `C.prototype.m = …`, `C.prototype = { … }` and `exports.x = …`
define symbols (a method under its object; an exported function for `exports.x`). This applies only
outside function bodies, IIFEs excepted, so assignments in callbacks still define nothing.
Anonymous `export default` / `module.exports =` functions and classes are named `default`. A
`default` symbol stops the members of `export default { … }` from being importable by name. TS
namespaces and `declare module` become kind `variable` (what TS emits) with qualified members,
because kind `module` means "the file" to the resolver, search, embeddings and drift.
`references` refs come from identifiers or member expressions in call arguments, arrays, object
values and shorthands, JSX expressions, returns, declarators and assignments. The parser drops
those whose root name is not bound at the top level (locals, params). The resolver emits only
resolved edges to a function, method or class, and drift's neighbourhood hash picks them up.
`forEachOfType`'s native cut-off rose from 100 to 500 descendants, because native matches are
materialised and value nodes made them about 7× as many. Parse+insert median on got went ~3.6 →
~4.2 ms/file (budget 5), and express stayed ~1.7.

## 2026-10-22 — SG26: function values are local scopes unless they are module wrappers

A function value (arrow, `function` expression) met by the module-level walk is a local scope:
its declarations are not symbols and its calls/values belong to the enclosing owner (A9-02). It
is a **module wrapper**, walked as module scope, only when it is (1) the callee of a call, also
through parentheses or `.call`/`.apply` (IIFE, `!function(){}()`), (2) an argument of a call
whose callee is itself a function value (UMD: `(function (root, factory) {…})(this, function
() {…})`, incl. rollup's parenthesised factory), or (3) the last argument of a call to the bare
identifier `define` (AMD, incl. `define(function (require, exports, module) {…})`). Nothing
else counts: `obj.define(…)`, webpack/browserify bundles and `describe`/`app.get`/`.then`
callbacks are local. Methods of object literals that are not a scope (call arguments, arrays,
returns) define nothing either. One property-definer shape is kept as API: `f(obj, 'name', fn)`
with exactly three arguments (express `defineGetter`) and `Object/Reflect.defineProperty(obj,
'name', { get|value: fn })` define method `obj.name` when `obj`'s head is a top-level symbol
of the file and not an import binding (so `stub(fs, 'readFile', fn)` defines nothing). Also:
chained assignments define the innermost target and alias every other member target (A9-12);
`as const`/`satisfies` objects open a member scope (A9-07); `var app = exports =
module.exports = {}` exports `app` (default export when the chain ends in an object), `export
declare` is exported, Python `__all__ += [...]` extends a literal `__all__` (A9-11). Inner
links of a chain are skipped by node id, not `node.parent` (O(depth) in tree-sitter 0.21).
Express/got/trpc top-level variables+functions: 1789/5047/5683 → 547/486/2240; callback
locals 69%/90%/61% → 0%. The extractor version (SG25) must be bumped with this change.
