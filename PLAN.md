# PLAN

Atlas is not done against `CLAUDE.md` §10 ("Project Done"). Base branch: `claude/build-atlas-phase-1-f3WUm` @ `21b2aaf`
(typecheck, lint and 61 tests pass). The gaps below were reproduced on that commit (2026-10-19):

| # | Repro on base | Result |
| --- | --- | --- |
| R1 | index a 3,000-function `big.ts` (>32 KB) | `failed: Invalid argument`, 0 symbols; re-index **skips** it forever (hash written before parse) |
| R2 | delete `gone.ts`, re-index | file, symbols and docs stay; drift still reports them |
| R3 | `from pkg.util import helper` | import edge `weak: 1` (non-relative specifiers return before the Python branch) |
| R4 | `export interface Drawable { area(): number }` | member stored as top-level `area` |
| R5 | `App.tsx` with JSX followed by `export function After()` | `After` missing (`.tsx` parsed with the TS grammar) |

Three unmerged branches diverge from base: `vibrant-hopper-34LWu` (chunked parse fixes R1's crash, CJS `require`, architecture mock, `scripts/verify-external.sh`), `upbeat-dirac-rI9vn` (duplicate CJS fix), `relaxed-knuth-DHc0Q` (adds an MCP server, **deletes** `synth/`, `docs` and `ask`).

## Rules

- Every session reads this file first and updates its own row at the end.
- Execution: one Claude thread, with subagents for bounded test-first tasks, at most 2 running at once. SG0 merges before any parallel work.
- Subagents return only: files changed, tests added, verification command and result, open issues.
- Stop and report if a task fails verification 3 times, or if the fix needs a change to a shared interface (§Interfaces).
- Baseline gate for every sub-goal: `npm run typecheck && npm run lint && npm test`.
- Code: match existing conventions, minimal comments, one small PR per sub-goal into the base branch.

## Interfaces (owned by SG0; frozen after merge)

- `ParsedSymbol` gains `exported: boolean`; `symbols.exported INTEGER NOT NULL DEFAULT 0` (migration v3).
- `docs.source_hash` = `sha256(prompt)`, i.e. a hash of the full grounding context, not the file hash. `detectDrift` recomputes it the same way.
- `ParseResult` gains `diagnostics: { line; message; severity: 'error' | 'warning' }[]` (additive, SG11); `parseSource` never throws on input.
- `indexRepo` contract: a file's `content_hash` is written in the same transaction as its symbols and imports, only after a successful parse. Paths not seen by the walk are deleted (with cascades to symbols, imports, edges, embeddings and docs).
- `Embedder` is chosen by `config.embeddingModel` through `createEmbedder(config)`; `local-hash-v1` stays the default.
- `search()` signature is unchanged. Candidates are the union of vec0 KNN and an FTS5 index over `name`, `qualified_name` and `docstring`, fused by RRF. Filters apply before truncation.
- `ParsedImport` gains optional `reexport` and `imports.reexport INTEGER NOT NULL DEFAULT 0` (migration v5, additive, SG10): `export … from` rows; with `module: ''` a local name exported as `alias` (`export default x`, `export { x as y }`, `module.exports = x`).
- Perf budgets (measured by `scripts/bench.mjs` on `express` and Atlas itself): parse+insert ≤ 5 ms/file median; no-op re-index ≤ 100 ms per 100 files; `search` p95 ≤ 50 ms at 10k symbols; resolver ≤ 2 s at 1k files.

## Sub-goals

| ID | Title | Depends | Owner | Status |
| --- | --- | --- | --- | --- |
| SG0 | Shared interfaces + bench harness | none | Claude (thread) | done: 68 tests, bench baseline in DECISIONS.md |
| SG1 | Reconcile branches | SG0 | Claude (thread) | done: 70 tests, verify-external express+got ok |
| SG2 | Indexer correctness | SG0, SG1 | Claude (thread) | done: hash-after-parse, pruning; 73 tests |
| SG3 | Parser correctness | SG0, SG1 | Claude (thread) | done: tsx, qualified members, exported flag; 86 tests |
| SG4 | Resolver soundness (CST-based) | SG3 | Claude (thread) | done: refs table (v4), golden fixtures/graph, no FN/FP; express 411→1444 edges, got 1937→4850; resolver ~1 s/1k files |
| SG5 | True hybrid search | SG0 | Claude (thread) | done: FTS5+KNN RRF, pre-filtered; p95 27.7 ms at 10k |
| SG6 | Docs + drift + CI that actually detects staleness | SG2, SG3 | Claude (thread) | done: prompt-hash cache, `.atlas/docs` + CI drift, exported-only undocumented; 132 tests, cached 1k synth 0.2 s, got 98k tokens |
| SG7 | Grounded Q&A citation checks | SG5 | Claude (thread) | done: `[n]`/`file:line` checks flagged in `ask` result, CLI and `--json`; full-span excerpts capped at 120 lines; expansion ranked resolved-first by kind; 135 tests |
| SG8 | Read-only on target + CLI hygiene | SG0 | Claude (thread) | done: config in `.atlas/`, exitCode not exit; 104 tests, express git status clean |
| SG9 | MCP server (additive, keeps `docs`/`ask`) | SG6, SG7 | Claude (thread) | done: `atlas mcp` stdio, 7 tools incl. docs + ask (citation checks, budgeted); 186 tests |
| SG10 | Resolver: re-exports, default/CJS exports, generic Python bases (A1-01, A1-02, A1-03) | SG4 | Claude (thread) | done: re-export rows (v5) followed through barrels/`__init__`/CJS with cycle guard, default + `module.exports` defaults, subscripted bases; also A1-09/10/12; 12 audit tests flipped; 266 tests; express 1444/896 weak → 1554/895, got 4850/3461 → 5004/3156; resolver ~0.9–1.2 s/1k files |
| SG11 | Parser never throws; diagnostics; failed parse marks docs stale (A1-04, A1-13) | SG3 | Claude (thread) | done: iterative CST walks (20k-term exprs), `ParseResult.diagnostics` (not stored), drift flags files changed since indexing; 3 A1-04 flipped; 241 tests; express 2052/1444, got 5752/4850 |
| SG12 | Drift completeness: full neighbourhood hash, `--docs-dir` missing fails, CRLF, commit own docs (A1-05..08) | SG6 | Claude (thread) | done: uncapped neighbourhood digest in prompt, deleted-file tombstones, CRLF, `--docs-dir` missing/empty exits 1, `.atlas/config.json` committable; A1-05/06/07/08/17 flipped; 252 tests; got 97k tokens; own docs still uncommitted |
| SG13 | Surface consistency: drift semantics and validation agree across CLI, HTTP, MCP (A3-01..A3-10) | SG9, SG12 | Claude (thread) | done: `failing` = exit 2 (hasDrift kept), shared `runDrift` errors on no docs (CLI 1, MCP isError), zod params shared by CLI/HTTP 400/MCP, `listDocs` for CLI/dashboard/MCP, budgeted CLI `ask`, no writes on missing root/index, `indexPath` confined to `.atlas/`; also A3-15/16/17; 15 audit tests flipped (A3-11, A3-13 open); 302 tests; express ok |
| SG14 | Search and embeddings at 150k symbols: bounded KNN latency, indexed embedding deletes (A2-02, A2-03) | SG5 | Claude (thread) | proposed (from AUDIT-2) |
| SG15 | Bounded MCP and HTTP responses: pagination/limits for drift, graph, docs (A2-04, A2-09) | SG13 | Claude (thread) | done: shared `graphParams`/`driftParams` (limit/offset, graph `file`/`symbol`+`depth`/`edgeLimit`) with `totals`+`truncated`, compact MCP JSON, opt-in `formatted`, CLI complete unless `--limit`; at 10k files atlas_drift 29.6 MB/disconnect → 11 KB (1.0 s), atlas_graph 88 MB/not reached → 0.27 MB (47 ms, max-limit 1.4 MB), /api/graph 47 MB/2.0 s → 0.24 MB/14 ms, /api/stats 1.54 s → 6 ms, serve RSS 874 → 119 MB; 325 tests |
| SG16 | Parse+insert ≤ 5 ms/file on express and got (A2-05) | SG11 | Claude (thread) | proposed (from AUDIT-2) |
| SG17 | Indexer data safety and untested guarantees: unreadable dirs never prune, real parse failures keep old rows and retry, tests for dashboard read-only, `runDrift` tombstones, ask budget boundary, typecheck `test/` (A4-01..A4-06) | SG13 | Claude (thread) | done: unreadable paths kept and counted failed, tree-sitter failure keeps rows and retries (`parseSourceOrThrow`), tests kill M1/M6/M9, A4-08 pinned, `typecheck` covers `test/`; 2 `it.fails` + 4 todos flipped; 313 tests |

### SG0: Shared interfaces + bench harness
- Migration v3 (`symbols.exported`), `ParsedSymbol.exported`, `createEmbedder`, FTS5 table `symbols_fts` (migration v3), plus contract tests that pin each item in §Interfaces.
- `scripts/bench.mjs`: prints ms/file, no-op re-index time and search p50/p95 as JSON; records the baseline in `DECISIONS.md`.
- Accept: `npm test -- test/db test/contracts` green; `node scripts/bench.mjs --target self` runs and emits JSON.

### SG1: Reconcile branches
- Cherry-pick `vibrant-hopper-34LWu` (chunked parse, CJS, architecture mock, `verify-external.sh`). Close `upbeat-dirac-rI9vn` as superseded. Leave `relaxed-knuth-DHc0Q` unmerged pending SG9.
- Accept: R1's file now parses (≥ 3,000 symbols); `bash scripts/verify-external.sh express` and `... got` pass.

### SG2: Indexer correctness
- Hash written after a successful parse, in one transaction. Prune unseen paths. Rename = delete + add.
- Accept: new tests `test/ingest/failure.test.ts` (a throwing parser leaves the old hash, so the next run retries) and `test/ingest/prune.test.ts` (R2: delete/rename leaves no rows in any table, including `embeddings_vec`).

### SG3: Parser correctness
- `.tsx` uses the tsx grammar; interface and object-literal members are qualified; class-field arrow functions become methods; `exported` is set for TS/JS (`export`) and Python (no leading `_`).
- Accept: `test/parse/parser.test.ts` covers R4, R5, field arrows, and `exported` on each language.

### SG4: Resolver soundness
- Found in SG3: bodies of top-level `const f = () => {}` are still walked, so their inner consts become top-level variables; object literals outside a top-level const (e.g. `module.exports = { foo() {} }`) emit unqualified methods.
- Replace regex call and heritage detection with CST walks (`call_expression`, `new_expression`, heritage clauses). Resolve `this.m()` to same-class methods. Add Python absolute and multi-dot relative imports (R3).
- Accept: a golden edge file `fixtures/sample/expected-edges.json` (extended fixture with Python packages, `.tsx`, and calls inside comments and strings) with **no false negatives** and no edges from comments or strings; `verify-external.sh express` edge count does not drop; resolver within budget.

### SG5: True hybrid search
- FTS5 plus KNN union with RRF, pre-filtering by kind and file, `createEmbedder` everywhere `LocalHashEmbedder` is hard-coded (indexer, search, retrieve, server).
- Accept: tests where (a) an exact name absent from the top-50 KNN is returned first and (b) a selective `--kind` filter returns results on a 10k-symbol synthetic index; search p95 within budget.

### SG6: Docs, drift and CI
- Found in SG1: `verify-external.sh` sees `drift` exit 2 right after generating docs on a fresh index; `got` used 199k of the 200k token budget.
- Cache key = context hash; `buildModuleContext` no longer O(files × all edges); "undocumented" counts only `exported` symbols, with word-boundary matching.
- CI: persist docs between runs (commit `.atlas/docs/*.md` with hashes in front matter) so a PR that changes code without regenerating docs is reported stale. Fix the trigger branch (`main` does not exist).
- Accept: a workflow test that runs drift against docs generated from the *base* commit reports the changed file as stale; synthesis on a fully cached 1k-file index ≤ 1 s; the job is green on this repo.
- Follow-up done in SG12: `.atlas/docs` and `.atlas/config.json` are committed. Every PR that changes code must run `atlas index . && atlas docs --offline` and commit the result, or CI fails.

### SG7: Grounded Q&A
- Parse `[n]` and `file:line` references in answers and flag any citation that is outside the retrieved snippets. Excerpts respect `end_line`. Rank graph expansion by edge strength.
- Accept: tests with a fake LLM that cites a non-existent snippet (flagged) and a symbol longer than 25 lines (full span).

### SG8: Read-only on target + CLI hygiene
- Found in SG1: `verify-external.sh` also writes `atlas.config.json` into the cloned target.
- Config moves into `.atlas/` (no `atlas.config.json` written to the target root); no `process.exit` inside `try/finally`; remove unused config keys or wire them.
- Accept: a test that indexes a git repo and asserts `git status --porcelain` lists only `.atlas/`.

### SG9: MCP server
- Port `relaxed-knuth-DHc0Q`'s `src/mcp/server.ts` as an additional surface without deleting `synth/`, `docs` or `ask`.
- Accept: `test/mcp/server.test.ts` passes alongside the existing suite.

## Audits (after SG0–SG8 merge)

Fresh subagents that wrote none of the code. Each writes `AUDIT-<n>.md`, ranked by severity, with a repro or failing test per finding. Critical and high findings become new SG rows here. Audits repeat until a full round finds no critical or high issues.

1. Graph and drift soundness: no false negatives on the golden edges or on drift.
2. Performance under load: every §Interfaces budget on a 10k-file synthetic repo.
3. API consistency: CLI flags, HTTP API, dashboard and `--json` outputs agree.
4. Test coverage: `vitest --coverage` with lines ≥ 85% in `src/core`, plus untested branches listed.

### Audit round 1

- AUDIT-1 (graph and drift soundness): 0 critical, 6 high, 7 medium, 7 low. Repros in `test/audit/audit-1.test.ts` as `it.fails`; a fix flips its test to `it`. Highs became SG10–SG12; the cheap mediums on the same code paths (A1-06, A1-08, A1-13) ride along.
- AUDIT-3 (API consistency): 0 critical, 2 high, 8 medium, 7 low. Repros in `test/audit/audit-3.test.ts`. Highs (A3-01, A3-02) and the mediums on the same code paths (A3-03..A3-10) became SG13.
- AUDIT-2 (performance): 1 critical (A2-01, downgraded to medium after SG12 re-measurement), 4 high, 5 medium, 2 low. Highs became SG14–SG16.
- AUDIT-4 (test coverage): `src/core` 96.6% lines (target 85%); 0 critical, 5 high, 7 medium, 5 low; 7 of 10 mutations killed. Repros in `test/audit/audit-4.test.ts`. Highs and A4-06 became SG17.
