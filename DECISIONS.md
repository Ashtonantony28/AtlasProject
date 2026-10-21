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
