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
- `indexRepo` contract: a file's `content_hash` is written in the same transaction as its symbols and imports, only after a successful parse. Paths not seen by the walk are deleted (with cascades to symbols, imports, edges, embeddings and docs).
- `Embedder` is chosen by `config.embeddingModel` through `createEmbedder(config)`; `local-hash-v1` stays the default.
- `search()` signature is unchanged. Candidates are the union of vec0 KNN and an FTS5 index over `name`, `qualified_name` and `docstring`, fused by RRF. Filters apply before truncation.
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
| SG6 | Docs + drift + CI that actually detects staleness | SG2, SG3 | unassigned | proposed |
| SG7 | Grounded Q&A citation checks | SG5 | unassigned | proposed |
| SG8 | Read-only on target + CLI hygiene | SG0 | Claude (thread) | done: config in `.atlas/`, exitCode not exit; 104 tests, express git status clean |
| SG9 | MCP server (additive, keeps `docs`/`ask`) | SG6, SG7 | unassigned | proposed (user chose "keep both", 2026-10-19) |

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
