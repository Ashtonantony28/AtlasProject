# AUDIT-8: Test coverage (round 2)

This audit measures test coverage of Atlas after SG14–SG17 and looks for behaviour that no test pins. Base: `2e6a53f` on
`claude/atlas-audit-8`. The auditor wrote none of this code.

Method:
- `npm run test:coverage` (v8, `src/**`) on the base suite, and once more with `--exclude 'test/audit/**'` to see what
  the product tests alone cover.
- 25 hand mutations, one at a time, each run against the full suite (`npx vitest run`) and then restored with
  `git checkout -- <file>`. `git diff -- src` was empty after every one (checked by the harness).
- Every `it.fails` and `it.todo` in `test/audit/` was run once as a plain `it` to check it fails for the stated reason.
- `npm run typecheck`, which since SG17 also checks `test/`.

Repros are in `test/audit/audit-8.test.ts`:
- a plain `it` pins behaviour that is correct today but that a surviving mutation showed no test checks. Each was
  re-run against its mutant and fails there (the mutant ID is in the test name);
- `it.fails` marks a real defect and asserts the correct behaviour. Each was run once as a plain `it` and fails on the
  stated assertion;
- `it.todo` names a test that should exist.

**Headline:** lines **97.3% in `src/core`** (target 85%), 92.3% overall. Branches are 89.9% in `src/core`, functions
97.2%. Every `src/core` file except two dead-code files is at or above 85% lines.

**Mutations:** 25 run. Of the 21 that count (3 equivalent, 1 harness slip excluded), the existing suite killed 9 and 12
survived: kill rate **9/21 (43%)**. All 12 survivors are in SG14–SG17 code. The new audit tests kill 8 of them; 3
remain as `it.todo` and 1 (M11) sits on code that is already wrong (A8-07).

**Totals:** 0 critical, 2 high, 3 medium, 7 low.

## Coverage

Base: `npm run test:coverage` on `2e6a53f`, 52 files, 347 tests. Coverage counts code run in-process only.

### By directory

| Scope | Lines | Branches | Functions | Lines without `test/audit` |
| --- | --- | --- | --- | --- |
| **All `src/`** | **92.3%** (4689/5080) | 88.6% (1901/2145) | 96.1% (274/285) | 91.5% |
| **`src/core`** | **97.3%** (3802/3906) | 89.9% (1667/1855) | 97.2% (239/246) | 96.9% |
| core (root: `config`, `params`, `project`, `index`) | 95.5% (169/177) | 94.4% (51/54) | 92.9% (13/14) | 95.5% |
| core/db | 98.6% (281/285) | 97.1% (66/68) | 94.7% (36/38) | 98.6% |
| core/drift | 100% (182/182) | 94.6% (70/74) | 100% (6/6) | 98.9% |
| core/graph | 98.7% (473/479) | 94.6% (336/355) | 100% (27/27) | 98.5% |
| core/ingest | 94.6% (264/279) | 91.9% (91/99) | 90.0% (9/10) | **89.6%** |
| core/parse | 98.0% (1177/1201) | 89.1% (619/695) | 100% (71/71) | 98.0% |
| core/qa | 100% (204/204) | 89.2% (66/74) | 100% (7/7) | 100% |
| core/synth | 95.1% (626/658) | 83.1% (212/255) | 95.0% (38/40) | 95.1% |
| core/vector | 96.6% (426/441) | 86.2% (156/181) | 97.0% (32/33) | 96.1% |
| `src/cli` | 90.0% (459/510) | 76.2% (109/143) | 88.2% (15/17) | 85.7% |
| `src/mcp` | 98.2% (268/273) | 93.2% (69/74) | 93.3% (14/15) | 98.2% |
| `src/web` | 40.9% (160/391) | 76.7% (56/73) | 85.7% (6/7) | 40.9% |

Compared with AUDIT-4 (`ae12887`): `src/core` lines 96.6% → 97.3%, branches 88.4% → 89.9%. `src/web` is still low
because `static/app.js` (0/208) runs inside jsdom; `web/server.ts` alone is 87.4%. `src/cli/index.ts` (0/9) and
`startMcpServer` (`mcp/server.ts:374-378`) run only in subprocesses (A4-16, unchanged).

### `src/core` files under 85% lines

| File | Lines | Uncovered | Note |
| --- | --- | --- | --- |
| `core/index.ts` | 0% (0/5) | 1-5 | Dead barrel (A4-13, unchanged). |
| `core/synth/budget.ts` | 82.2% (37/45) | 19-26 | `TokenBudget.total()` has no caller (A4-13, unchanged). |

`parse/parser.ts` rose from 81.0% to 92.6%: the chunked-parse catch is now driven by the tree-sitter fault tests.

### Uncovered ranges in `src/core` that matter

| File | Uncovered | What it is |
| --- | --- | --- |
| `ingest/indexer.ts` | 101-108 | `readFileSync` failure after a successful walk (a `chmod 000` file, a delete race). **A8-01.** |
| | 125-128 | `onFile` payload of a failed parse (the failure itself is covered). |
| `ingest/walker.ts` | 60 | `.gitignore` read failure. |
| | branch 115 | `st.size > maxBytes` is never taken: no test indexes a file over 1 MB, or one that grows past it and is pruned like a deletion. |
| | branch 101 | No test ignores a directory through `.gitignore` (`dir/`). |
| `graph/export.ts` | 117-120 | `file` and `symbol` together (intersection). **A8-09.** |
| | branches 91, 186-191 | Non-JSON `meta`, a node with no qualified name, null-endpoint and weak edges in DOT output. |
| `vector/search.ts` | branch 199 | The FTS fallback (rank only rows that pass the filter) runs only with a filter, and no test needs its result. **A8-02.** |
| `vector/store.ts` | 13-14, 74-81 | Dimension-mismatch throw; dead `getEmbeddingMeta` (A4-13). |
| `vector/embedAll.ts` | 85-86 | "Embedding write did not persist" sanity throw. |
| `synth/llmClient.ts` | 38, 45-61 | The real Anthropic client (A4-11, unchanged). |
| `config.ts` | 77-78 | Invalid JSON in `.atlas/config.json` (A4-15, unchanged). |

### Covered only by `test/audit/`

Without `test/audit/**`, `core/ingest` drops to 89.6% and these lines become uncovered:
- `indexer.ts:85-91`, the SG17 guarantee that unreadable directories and files keep their rows;
- `walker.ts:91-94` and `112-114`, which record those failures;
- `textForSymbol.ts:74-75` and `drift/detect.ts:192-193`;
- `cli/commands/searchCmd.ts:41-57` (`search --json`) and `serveCmd.ts:27-29`.

These are the SG17 regression tests. They live in `audit-4.test.ts`, a file of finding repros, and not next to the
code they guard (A8-11).

## Mutation results

Run against the full suite unless noted. "Audit-8 test" is the test added by this audit that kills the survivor; each
was re-run against its mutant.

| ID | Mutation | Location | Area | Result | Killed by |
| --- | --- | --- | --- | --- | --- |
| M01 | Similarity lookup for contenders `>= cut` → `> cut` | `vector/search.ts:112` | SG14 | **SURVIVED** | audit-8 A8-06 |
| M02 | Drop the contenders' similarity assignment | `vector/search.ts:118` | SG14 | **SURVIVED** | audit-8 A8-06 |
| M03 | FTS: never fall back to filter-first ranking | `vector/search.ts:194` | SG14, §Interfaces search | **SURVIVED** | audit-8 A8-02 |
| M04 | `deleteEmbeddingsForFile` skips `embeddings_meta` | `vector/store.ts:69` | SG14 | killed | `vector/store.test.ts` |
| M05 | KNN ignores the kind/file filter | `vector/search.ts:60` | §Interfaces search | killed | 5 tests (hybrid, search, MCP) |
| M06 | Whole-graph edge query `LIMIT edgeLimit + 1` → `edgeLimit` | `graph/export.ts:71` | SG15 | **SURVIVED** | audit-8 A8-03 |
| M07 | Scoped `totals.edges` counts only the page | `graph/export.ts:83` | SG15 | **SURVIVED** | audit-8 A8-09 |
| M08 | `file` + `symbol` scope: intersection → union | `graph/export.ts:119` | SG15 | **SURVIVED** | audit-8 A8-09 |
| M09 | `pageDriftReport` recomputes `failing` from the page | `drift/detect.ts:177` | SG15, §Interfaces drift gate | **SURVIVED** | audit-8 A8-04 |
| M10 | `truncated` ignores `offset > 0` | `drift/detect.ts:180` | SG15 | **SURVIVED** | none (`it.todo` A8-10) |
| M11 | `countDocs` counts every `.md` under the docs dir | `synth/persist.ts:179` | SG15 | **SURVIVED** | none; the shipped code already miscounts (A8-07) |
| M12 | `cacheNodeTypes` no longer skips the base class | `parse/parser.ts:78` | SG16 | equivalent | the base prototype owns `type`, so the `hasOwn` check skips it too |
| M13 | `NATIVE_MIN_DESCENDANTS` 100 → 0 (always `descendantsOfType`) | `parse/refs.ts:142` | SG16 | equivalent | both walks give identical golden output (parity holds) |
| M14 | `NATIVE_MIN_DESCENDANTS` 100 → 1e9 (always the JS cursor) | `parse/refs.ts:142` | SG16 | equivalent | as M13 |
| M15 | `dottedAt` drops `parts.reverse()` | `parse/ts.ts:311` | SG16 | **SURVIVED** | none (`it.todo` A8-10) |
| M16 | Drop `existingByPath.delete` for walked files | `ingest/indexer.ts:95` | SG17 | killed | 28 tests (harness slip: the line was removed rather than moved, see M16b) |
| M16b | Move `existingByPath.delete` after the read | `ingest/indexer.ts:95` | SG17, §Interfaces indexRepo | **SURVIVED** | audit-8 A8-01 |
| M17 | An unreadable root (`''`) is not treated as a directory | `ingest/indexer.ts:85` | SG17 | killed | `audit-4` A4-01 |
| M18 | Unreadable-dir prefix match without the trailing `/` | `ingest/indexer.ts:87` | SG17 | **SURVIVED** | none (`it.todo` A8-10) |
| M19 | Unreadable entries not counted in `filesFailed` | `ingest/indexer.ts:89` | SG17 | killed | `audit-4` A4-01 (3) |
| M20 | `parseSourceOrThrow` swallows a tree-sitter throw | `parse/parser.ts:152` | SG17, §Interfaces indexRepo | killed | 5 tests (failure, unindexed, A4-02) |
| M21 | Prune skips `deleteEmbeddingsForFile` | `ingest/indexer.ts:197` | §Interfaces indexRepo | killed | `ingest/prune.test.ts` (2) |
| R1 | AUDIT-4 M1: `serve` opens the index read-write | `cli/commands/serveCmd.ts:22` | A4-03 | killed | `audit-4` A4-03 |
| R2 | AUDIT-4 M6: `runDrift` drops tombstones | `drift/run.ts:32` | A4-04 | killed | `audit-4` A4-04 |
| R3 | AUDIT-4 M9: budget slack of 1,000 tokens | `synth/budget.ts:52` | A4-05 | killed | `audit-4` A4-05 |

M16 is listed for completeness; it is not counted in the kill rate. Counted: 21 mutants (M01–M11, M15, M16b,
M17–M21, R1–R3), 9 killed by the existing suite. The three AUDIT-4 survivors (R1–R3) are now killed.
Every SG17 kill comes from `test/audit/audit-4.test.ts`.

The mutation harness is not committed; each mutation is one exact string replacement. To reproduce one, for example
M16b:

```
# in src/core/ingest/indexer.ts, move `existingByPath.delete(file.relativePath);` from line 95 to just after the
# read's try/catch (before `const hash = sha256(content);`), then:
npx vitest run            # 347 passed: survives
npx vitest run test/audit/audit-8.test.ts   # A8-01 fails
git checkout -- src/core/ingest/indexer.ts
```

## Test quality

- **Tests that pass for the wrong reason.** `test/audit/query-plan.test.ts` (A2-01, `it.fails`) can never flip.
  Run as a plain `it`, it fails with `Too few parameter values were provided`: `EXPLAIN QUERY PLAN` binds `file.id`
  once, but `NEIGHBOUR_SQL` (`synth/context.ts:53-68`) takes it twice. With both parameters bound, the test passes, so
  A2-01 is already fixed and its repro hides that (A8-05, Medium). All 27 `it.fails` in `audit-1/3/5` fail on their
  stated assertions.
- **Over-mocking.** AUDIT-4's concern is resolved: `ingest/failure.test.ts` and `drift/unindexed.test.ts` now fault
  `tree-sitter`'s `Parser#parse` instead of mocking `parseSource`, which matches the real R1 failure. Two mocks still
  differ from the real failure modes:
  - The `node:fs` mock in `audit-4` faults `readdirSync`/`statSync`. The realistic per-file failure, a `chmod 000`
    file, passes `statSync` and fails `readFileSync`, a path no test drove before this audit (A8-01).
  - `vector/store.test.ts` "deletes vec0 rows by single rowid" proxies `db.prepare`. It still works with
    `prepareCached` only because the proxy is a new `WeakMap` key. A spy assigned on the real `db` (as
    `query-plan.test.ts` does) would miss statements already cached by `repo.ts`, `search.ts` and `store.ts`. Low; no
    test does that today.
- **Timing tests.** Two wall-clock assertions run in the default suite: search p95 ≤ 50 ms (`vector/hybrid.test.ts:103`;
  measured 22–33 ms in this audit with another auditor on the same CPUs) and cached synthesis/drift ≤ 1 s
  (`synth/perf.test.ts:44,53`; 176 ms and ~400 ms). Margins are 1.5–2.5×. None failed in this audit's 29 full-suite runs, but they can
  fail on a loaded CI runner (A8-12, Low).
- **Typecheck.** `npm run typecheck` runs `tsc -p tsconfig.test.json --noEmit`, whose `include` covers `test/**/*`. It
  passes with this audit's test. ESLint covers `test/**/*.ts`. 14 test files are not Prettier-formatted (`npx prettier
  --check "test/**/*.ts"`); no script checks formatting. Not a finding.
- **Golden parse output.** `test/parse/golden.test.ts` pins SG16's walk well: it kills nothing here because M13/M14 are
  equivalent, but it would catch any divergence on the fixtures. Its gap is fixture breadth: no small function body in
  `fixtures/` calls through a member chain of three or more segments, so M15 survives (A8-10).

## Findings

### Critical

None. `src/core` has 97.3% line coverage, above the 85% target.

### High

**A8-01: A file that the walk lists but that cannot be read is protected by line order alone; no test drives it.**
High.
- Class: data integrity, untested path, frozen `indexRepo` contract ("paths not seen by the walk are deleted").
- Evidence:
  - `indexRepo` removes a walked path from `existingByPath` (`ingest/indexer.ts:95`) before it reads the file
    (`:98-108`). Only that order keeps an unreadable file from being pruned at `:194-202`, which deletes its symbols,
    refs, edges and embeddings and turns its docs into tombstones.
  - `indexer.ts:101-108` has no coverage. M16b moves the `delete` after the read; all 347 tests pass.
  - A `chmod 000` file, a Windows sharing violation or a delete between walk and read all take this path. `statSync`
    succeeds for a `chmod 000` file, so the SG17 walker fix does not cover it.
- Repro: `A8-01` in `audit-8.test.ts` (plain `it`; fails under M16b). It faults `readFileSync` with `EACCES` on one
  file and asserts `filesFailed: 1`, `filesRemoved: 0`, the old hash and symbols kept, and a clean retry.

**A8-02: The search filter's FTS fallback is never needed by a test, so dropping it breaks the frozen "filters apply
before truncation" contract silently.** High.
- Class: frozen §Interfaces contract (`search()`), surviving mutation.
- Evidence:
  - `ftsIds` (`vector/search.ts:172-204`, SG14) ranks the top `2k` FTS rows unfiltered, then filters them. Only when
    that leaves fewer than `k` does it re-rank rows that pass the filter (`:194-203`).
  - M03 removes the fallback; the suite passes. The hybrid filter tests still pass because KNN is pre-filtered, and
    their targets are exact-name or vector matches.
  - Without the fallback, a symbol matched only through FTS (docstring or qualified-name token) inside a selective
    `--kind`/`--file` filter disappears whenever more than `2k` higher-ranked matches lie outside the filter.
- Repro: `A8-02` (plain `it`; fails under M03). 40 decoys rank first for `frobnicate`, and `zeta` in `special/` is
  outside the filtered KNN pool (asserted). `search('frobnicate', { file: 'special/' })` must return `zeta`.

### Medium

**A8-03: `truncated` on the whole-graph path is untested; an off-by-one silently drops edges.** Medium.
- Evidence: when every node fits the page, `buildGraphJson` fetches `edgeLimit + 1` edges to detect the cut
  (`graph/export.ts:69-72`). M06 fetches `edgeLimit`; the response then has `truncated: false` with edges missing. This
  is the path `atlas_graph` and `/api/graph` take with their defaults on any index under 1000 symbols, and
  `atlas graph --edge-limit` without `--limit`. The SG15 tests cover truncation only on the paged path.
- Repro: `A8-03` (plain `it`; fails under M06).

**A8-04: Paging can change the drift gate, and no test pins that it does not.** Medium.
- Class: frozen contract (`failing` = exit 2, SG13).
- Evidence: `pageDriftReport` keeps `failing` from the full report by spreading it (`drift/detect.ts:173-184`). M09
  recomputes `failing` from the page; the suite passes, because every paging test's page still contains a stale entry.
  Under M09, `atlas drift --offset 50` on a repo with one stale doc exits 0.
- Repro: `A8-04` (plain `it`; fails under M09). CLI `drift --json --limit 1 --offset 50` exits 2 with an empty `stale`
  page, and `atlas_drift` returns `failing: true`.

**A8-05: The A2-01 query-plan repro fails for the wrong reason, so it hides a fix.** Medium.
- Evidence: see Test quality. Run it as a plain `it`: `Too few parameter values were provided`. Bind
  `.all(file.id, file.id)` and it passes.
- Repro: `sed -i 's/it.fails(/it(/' test/audit/query-plan.test.ts && npx vitest run test/audit/query-plan.test.ts`
  (then `git checkout` the file). Fix: bind both parameters and flip it to `it`, then close A2-01.

### Low

**A8-06: Search reports `semanticScore` 0 for lexical-only hits under two mutations.** Low.
- Evidence: SG14 looks up similarity only for lexical hits at or above the cut (`vector/search.ts:109-118`). M01
  (`>` for `>=`) and M02 (no lookup) both survive. Observable effect: `search --json` reports `semanticScore: 0`, and
  ties order by a wrong key.
- Repro: `A8-06` (plain `it`; fails under M01 and M02).

**A8-07: `/api/stats` counts a stray or unparseable `.md` under `.atlas/docs/files/` as a doc.** Low.
- Evidence: `countDocs` (`synth/persist.ts:166-184`) counts files by name. `listDocs` keeps only docs whose front
  matter parses and whose path matches. The SG15 test checks equality only on a clean docs dir. A hand-written note or
  a merge-mangled doc makes the dashboard count disagree with its list.
- Repro: `A8-07` (`it.fails`: `expected 3 to be 2`).

**A8-08: Paging through the graph never returns edges that cross pages, yet `totals.edges` counts them.** Low.
- Evidence: each page returns only edges among its own nodes (`graph/export.ts:73-76`, `edgesWithin`). On
  `fixtures/sample` with `limit: 5`, all pages together hold 2 of 15 edges, and the last page says
  `truncated: false`. An MCP client that pages to rebuild the graph gets a silently incomplete one. This matches the
  documented "edges among them" semantics, so it is an API gap, not a regression.
- Repro: `A8-08` (`it.fails`: `expected 2 to be 15`).

**A8-09: Scoped graph totals under paging and the `file` + `symbol` intersection are untested.** Low.
- Evidence: M07 (`totals.edges` counts only the page) and M08 (union instead of intersection, `export.ts:117-120`,
  uncovered) both survive.
- Repro: `A8-09` (plain `it`; fails under M07 and M08).

**A8-10: Three surviving mutations with small effects.** Low.
- M10: `truncated` without `offset > 0` (`drift/detect.ts:180`). Visible only on a last page that starts past 0.
- M18: matching an unreadable `lib/` without its slash keeps a deleted sibling `library.ts` from being pruned
  (`ingest/indexer.ts:87`).
- M15: `a.b.c.d()` stores `refs.object` as `a.c.b` (`parse/ts.ts:311`). Verified non-equivalent by parsing that
  snippet. The resolver splits on the first segment only, so edges are unchanged today.
- Repro: three `it.todo` `A8-10 (M10|M18|M15)` in `audit-8.test.ts`.

**A8-11: SG17's guarantees are tested only in a findings file.** Low.
- Evidence: see "Covered only by `test/audit/`". Removing or rewriting `audit-4.test.ts` would drop coverage of
  `indexer.ts:85-91` and `walker.ts:91-94, 112-114`. There is still no coverage threshold in `vitest.config.ts`
  (AUDIT-4 recommended lines 90 / branches 85 on `src/core`), so such a drop would go unnoticed.
- Should exist: move the A4-01/A4-02 tests to `test/ingest/`, and add `coverage.thresholds` for `src/core` with the
  out-of-process files excluded (A4-16).

**A8-12: Two wall-clock assertions in the default suite.** Low.
- Evidence: `vector/hybrid.test.ts:103` (p95 ≤ 50 ms; 22–33 ms measured under contention) and
  `synth/perf.test.ts:44,53` (≤ 1 s). Should exist: gate them behind an env var or `scripts/bench.mjs`, or widen the
  margin.

## Re-verified (AUDIT-4)

| Finding | Status | Evidence |
| --- | --- | --- |
| A4-01 unreadable dir/file prunes | fixed | `audit-4` A4-01 (3 tests) pass; M17 and M19 killed by them |
| A4-02 real parse failure wipes rows | fixed | A4-02, `ingest/failure.test.ts` pass; M20 killed by 5 tests |
| A4-03 dashboard read-only untested | fixed | R1 (AUDIT-4 M1) killed by A4-03 |
| A4-04 tombstones via `runDrift` | fixed | R2 (AUDIT-4 M6) killed by A4-04 |
| A4-05 ask budget boundary | fixed | R3 (AUDIT-4 M9) killed by A4-05 |
| A4-06 tests never typechecked | fixed | `npm run typecheck` runs `tsconfig.test.json` (includes `test/**/*`); passes |
| A4-08 delete-before-reindex drift | pinned | A4-08 passes |
| A4-07, A4-09–A4-17 | still open | Not in SG17's scope. `core/index.ts`, `budget.total()`, `getEmbeddingMeta`, `isSupported`, `findSymbolsByKind`, `getLastRun` still have no caller; `llmClient.ts:45-61` and `config.ts:77-78` still uncovered; read-only open still has no schema-version check (`db/database.ts:49`) |

## No finding

- **SG14 vector store.** Point deletes of vec0 and meta rows are pinned (`store.test.ts`; M04 killed). KNN
  pre-filtering is pinned by five tests (M05).
- **SG15 params.** Bounds and defaults of `graphParams`/`driftParams` are asserted on CLI, HTTP (400) and MCP
  (`isError`). Compact MCP JSON, the DOT truncation comment and CLI completeness by default are tested.
- **SG16 parser.** The prototype type cache is safe: the base `SyntaxNode` prototype owns `type`, so the `hasOwn`
  guard alone skips it (M12 equivalent). The native and cursor walks give identical golden output (M13/M14). The
  `tree-sitter` mock used by the failure tests extends the real `Parser`, so `cacheNodeTypes` still finds
  `Parser.SyntaxNode` through the inherited static.
- **SG17.** Unreadable root, directory, unstatable file, tree-sitter failure and `filesFailed` accounting are all
  pinned (M17, M19, M20 killed). The prune cascade to embeddings is pinned (M21).
- **`prepareCached`.** No caller changes a cached statement's mode (`pluck`, `raw`, `expand`) or iterates one, so a
  shared statement cannot leak state between callers.
- **Assertion strength.** All 29 other `it.fails` in `test/audit/` (27 in `audit-1/3/5`, 2 in `audit-8`) fail on
  assertions; only the A2-01 repro does not (A8-05).
