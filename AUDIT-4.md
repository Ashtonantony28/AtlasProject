# AUDIT-4: Test coverage

This audit measures test coverage of Atlas and looks for behaviour that has no test. Base: `ae12887` on
`claude/atlas-audit-4`. The auditor wrote none of this code.

Method:
- Added `@vitest/coverage-v8@2.1.9`, pinned to the installed `vitest@2.1.9`.
- Added an `npm run test:coverage` script (`vitest run --coverage`) and a `coverage` block in `vitest.config.ts` (provider
  `v8`, `include: ['src/**']`, reporters `text-summary`, `json-summary` and `json` into the gitignored `coverage/`). The
  extra `json` reporter gives per-statement data for the uncovered ranges below. There is no threshold yet.
- Read every uncovered range in `src/core`, `src/web` and `src/mcp`.
- Ran ten mutations, one at a time, against the full suite. Each was reverted afterwards; `git diff -- src` is empty.
- Ran `npx tsc -p tsconfig.test.json --noEmit` to typecheck the test files.

Repros are in `test/audit/audit-4.test.ts`:
- `it.fails` marks a real defect; the test asserts the correct behaviour. Each was also run once as a plain `it` to
  confirm it fails on the stated assertion.
- `it.todo` names a test that should exist (a surviving mutation or an untested path).

**Headline (suite as of `ae12887`, before the audit's tests):** lines **91.2%** overall and **96.6% in `src/core`**,
which meets the PLAN target of at least 85%. Branches are 87.2% overall and 88.4% in `src/core`; functions are 95.8% and
96.9%.

**Totals:** 0 critical, 5 high, 7 medium, 5 low.

The line number is not the problem. The gaps are:
- untested failure modes in the indexer that can silently lose data (A4-01, A4-02);
- three surviving mutations on safety paths: dashboard read-only, drift tombstones through `runDrift`, and the budget
  boundary;
- test files that are never typechecked.

## Coverage tables

Baseline: `npm run test:coverage` on `ae12887` (302 tests). The audit's two `it.fails` repros drive the indexer and parser
failure paths, which raises the run with them to 91.4% lines overall and 96.9% in `src/core`. The numbers below are the
baseline.

### Overall and by directory

| Scope | Lines | Branches | Functions |
| --- | --- | --- | --- |
| **All `src/`** | **91.2%** (4232/4642) | 87.2% (1673/1918) | 95.8% (253/264) |
| **`src/core`** | **96.6%** (3410/3531) | 88.4% (1457/1648) | 96.9% (217/224) |
| core/ingest | 92.8% (244/263) | 89.4% (76/85) | 87.5% (7/8) |
| core/parse | 96.4% (978/1014) | 87.8% (504/574) | 100% (59/59) |
| core/graph | 99.2% (387/390) | 91.9% (285/310) | 100% (22/22) |
| core/vector | 96.0% (407/424) | 85.9% (146/170) | 97.0% (32/33) |
| core/synth | 95.0% (608/640) | 82.3% (205/249) | 94.9% (37/39) |
| core/qa | 100% (204/204) | 89.2% (66/74) | 100% (7/7) |
| core/drift | 98.7% (154/156) | 91.2% (62/68) | 100% (5/5) |
| core/db | 98.6% (273/277) | 96.9% (63/65) | 94.6% (35/37) |
| core (root: `config`, `params`, `project`, `index`) | 95.1% (155/163) | 94.3% (50/53) | 92.9% (13/14) |
| `src/cli` | 88.2% (425/482) | 75.2% (100/133) | 88.2% (15/17) |
| `src/web` | 40.1% (152/379) | 75.8% (50/66) | 87.5% (7/8) |
| `src/mcp` | 98.0% (245/250) | 93.0% (66/71) | 93.3% (14/15) |

`src/web` is low because `static/app.js` (0/204 lines) runs inside jsdom in `test/web/rendering.test.ts`. That code is
evaluated, not imported, so v8 cannot see it. `web/server.ts` alone is 86.9% (152/175). Code that only runs in a
subprocess also reads as 0%: `src/cli/index.ts` (0/9) and `startMcpServer`.

### Per file (lines, branches)

| File | Lines | Branches | File | Lines | Branches |
| --- | --- | --- | --- | --- | --- |
| core/config.ts | 97.5 | 95.7 | core/parse/parser.ts | **81.0** | 77.4 |
| core/params.ts | 98.1 | 95.2 | core/parse/py.ts | 98.8 | 86.3 |
| core/project.ts | 100 | 100 | core/parse/refs.ts | 100 | 93.5 |
| core/index.ts | **0** | 0 | core/parse/ts.ts | 97.1 | 88.5 |
| core/db/database.ts | 100 | 100 | core/qa/ask.ts | 100 | 76.9 |
| core/db/repo.ts | 98.0 | 95.7 | core/qa/citations.ts | 100 | 95.8 |
| core/db/schema.ts | 100 | 100 | core/qa/retrieve.ts | 100 | 89.2 |
| core/drift/detect.ts | 98.4 | 92.2 | core/synth/budget.ts | **82.2** | 92.9 |
| core/drift/run.ts | 100 | 88.2 | core/synth/context.ts | 99.2 | 88.8 |
| core/graph/export.ts | 96.1 | 60.0 | core/synth/llmClient.ts | 87.3 | 51.9 |
| core/graph/resolver.ts | 99.7 | 93.6 | core/synth/persist.ts | 98.3 | 90.1 |
| core/ingest/indexer.ts | 92.1 | 91.4 | core/synth/synthesize.ts | 100 | 100 |
| core/ingest/language.ts | 90.9 | 100 | core/vector/embedAll.ts | 96.2 | 69.2 |
| core/ingest/walker.ts | 93.3 | 84.2 | core/vector/embedder.ts | 100 | 87.2 |
| core/ingest/hash.ts | 100 | 100 | core/vector/search.ts | 100 | 90.5 |
| | | | core/vector/store.ts | 88.8 | 89.5 |
| | | | core/vector/textForSymbol.ts | 91.1 | 66.7 |
| cli/commands/askCmd.ts | 92.5 | 80.0 | cli/commands/searchCmd.ts | 94.9 | 61.1 |
| cli/commands/ciCommentCmd.ts | 87.2 | 100 | cli/commands/serveCmd.ts | **63.0** | 33.3 |
| cli/commands/docsCmd.ts | 89.2 | 70.4 | cli/commands/indexCmd.ts | 96.1 | 90.9 |
| cli/commands/driftCmd.ts | 100 | 94.4 | cli/commands/init.ts | 95.8 | 50.0 |
| cli/commands/graphCmd.ts | **73.5** | 50.0 | cli/commands/mcpCmd.ts | 92.3 | 100 |
| mcp/server.ts | 98.0 | 93.0 | web/server.ts | 86.9 | 76.9 |

### `src/core` files under 85% lines

| File | Lines | Uncovered lines | Class | Note |
| --- | --- | --- | --- | --- |
| `core/index.ts` | 0% (0/5) | 1-5 | (c) dead | Barrel re-export that nothing imports. The package `main` is `dist/cli/index.js`. |
| `core/parse/parser.ts` | 81.0% (68/84) | 52-54, 88-90 | (b) | `never` exhaustiveness defaults. |
| | | 108-115 | **(a)** | `parseChunked` throws and the result becomes empty with an internal diagnostic. The indexer then wipes the file's symbols and records its hash (A4-02). |
| | | 120-121 | (b) | `syntaxDiagnostics` throws. |
| `core/synth/budget.ts` | 82.2% (37/45) | 19-26 | (c) dead | `TokenBudget.total()` has no caller. `tryCharge()` (31-36) has no caller in `src/` either; only the boundary branch is missing from coverage. |

Other uncovered ranges in `src/core`, all files at or above 85%:

| File | Uncovered lines | Class | What it is |
| --- | --- | --- | --- |
| `ingest/walker.ts` | 49 | (b) | `.gitignore` read failure. |
| | 73-74 | **(a)** | `readdirSync` failure: the subtree is skipped, then pruned (A4-01). |
| | 92-93 | **(a)** | `statSync` failure: the file is skipped, then pruned (A4-01). |
| `ingest/indexer.ts` | 91-98 | (a) | Read failure. Not pruned, because `existingByPath.delete` runs first; untested. |
| | 115-118 | (b) | `onFile` payload on a parse throw. The throw itself is reachable only by mocking. |
| `ingest/language.ts` | 27-28 | (c) | `isSupported()` has no caller. |
| `drift/detect.ts` | 167-168 | (a) | A file is deleted on disk but not yet re-indexed. Today this is correct only because `readFileFromRoot` returns `null` and the prompt changes. No test covers it (A4-08). |
| `graph/resolver.ts` | 338 | (b) | A `this.m()` call in an object-literal method whose owner is not a class. |
| | branches 298, 332 | (b) | Heritage from a module-level ref; `super` with no resolved class. |
| `parse/ts.ts` | 202-205 | (a) | Heritage through `nested_type_identifier` (`implements ns.I`). Untested (A4-10). |
| | 577-579 | (a) | Side-effect `import './x'` adds a dependency edge. Untested (A4-10). |
| | 622-628, 659-661, 690-691 | (a) | `require(...)` through parentheses or member chains, with no binding name, or as a destructuring pattern other than an object (A4-10). |
| `parse/py.ts` | 55-56 | (b) | Single-quoted docstrings. |
| | 147 | (b) | `function_definition` with no name. |
| `synth/llmClient.ts` | 38, 45-61 | (a) | The real Anthropic `complete()`: request shape and usage accounting are never executed (A4-11). |
| | 177, 192 | (b) | Offline mock fallbacks. |
| `synth/context.ts` | 308-309 | (b) | Halving loop when the architecture prompt exceeds `MAX_ARCH_PROMPT_CHARS`. |
| `synth/persist.ts` | 121-122 | (b) | Removing empty parent directories after an orphan doc is deleted. |
| `vector/store.ts` | 13-14 | (b) | Dimension-mismatch throw. |
| | 72-79 | (c) | `getEmbeddingMeta`: only re-exported, never called. |
| `vector/embedAll.ts` | 85-86 | (b) | "Embedding write did not persist" sanity throw. |
| `vector/textForSymbol.ts` | 59-61 | (b) | `makeSourceLoader` read failure. |
| | 74-75 | (a) | `readFileFromRoot` read failure. Drift deletion detection depends on it (A4-08). |
| `db/repo.ts` | 111-112, 292-293 | (c) | `findSymbolsByKind` and `getLastRun` have no callers. |
| `config.ts` | 77-78 | (a) | Invalid JSON in `.atlas/config.json`. Untested (A4-15). |
| `graph/export.ts` | 59-60 | (b) | Non-JSON edge `meta`. |

### Migrations (`db/schema.ts`, 100% lines)

All five migrations execute on every fresh DB, so line coverage says nothing about the upgrade paths:

| Upgrade path | Tested? |
| --- | --- |
| v2 → v3 (`exported`, FTS backfill) | yes: `test/contracts/schema-v3.test.ts` |
| v3 → v4 (`refs`, forced re-parse) | yes: `test/db/refs-v4.test.ts` |
| v4 → v5 (`reexport`, forced re-parse) | yes: `test/db/refs-v4.test.ts` |
| v1 → v2 (drops the old `embeddings` table, creates vec0) | **no** |
| v1 → v5 in one open | **no** |

The auditor ran v1 → v5 ad hoc: a raw v1 schema, then `openDatabase`, then `indexRepo` on `fixtures/sample`. It succeeded
and reached version 5. A read-only open (`serve`) skips migrations and has no schema-version check (A4-09).

## Mutation results

Each mutation ran against the full suite (`npx vitest run`) and was then restored. `git diff -- src` is empty afterwards.

| ID | Mutation | Location | Result | Killed by |
| --- | --- | --- | --- | --- |
| M1 | `openProjectIndex(…, { readonly: true })` → `openProjectIndex(…, {})` | `cli/commands/serveCmd.ts:22` | **SURVIVED** | none |
| M2 | `budgeted()` drops `budget.record(...)` | `synth/budget.ts:58` | killed | `mcp/server.test.ts` atlas_ask |
| M3 | Citation range: `endLine <= c.endLine` → `startLine <= c.endLine` | `qa/citations.ts:48` | killed | `qa/grounding.test.ts` |
| M4 | Weak flag: `binding.kind === 'external' \|\| dst === null` → `dst === null` | `graph/resolver.ts:238` | killed | `graph/reexports.test.ts` |
| M5 | Drift `indexedContentChanged(...)` → `false` | `drift/detect.ts:95` | killed | `drift/unindexed.test.ts` (2) |
| M6 | `runDrift` DB mode drops `...deletedDocsFromDb(db)` (tombstones) | `drift/run.ts:32` | **SURVIVED** | none |
| M7 | Prune: `existingByPath.size > 0` → `< 0` | `ingest/indexer.ts:184` | killed | `ingest/prune.test.ts`, `drift/completeness.test.ts`, `ci/workflow.test.ts` (4) |
| M8 | `--force` ignored (drop `!opts.force &&`) | `ingest/indexer.ts:101` | killed | `ingest/indexer.test.ts`, `mcp/server.test.ts` |
| M9 | Budget slack: `reserve > budget.remaining()` → `reserve > budget.remaining() + 1000` | `synth/budget.ts:52` | **SURVIVED** | none |
| M10 | `failing` ignores `--strict` | `drift/detect.ts:156` | killed | 6 tests (CLI exit codes, drift contract, MCP, A3-02) |

Seven of ten were killed. All three survivors are on paths the rubric counts as safety-critical.

## Test quality

- **Assertion strength.** A scan of every `it` in `test/` found no test without `expect`. No test relies only on
  `toBeDefined` or `not.toThrow`. The weakest test is `vector/embedder.test.ts` "is deterministic across calls": one
  `toBeCloseTo(cosine, 1)`, which is adequate.
- **Over-mocking.** `test/ingest/failure.test.ts` and `test/drift/unindexed.test.ts` (the "fails to re-index" case) mock
  `parseSource` to throw. Since SG11 the real `parseSource` never throws: it catches the tree-sitter error and returns an
  empty result. Both tests therefore cover a contract the product cannot reach, and the reachable failure is untested
  (A4-02).
- **Bypassing the shared entry point.** `test/drift/completeness.test.ts` covers deleted-file tombstones through
  `detectDrift` with no `docs` option, which loads tombstones itself. The CLI and MCP go through `runDrift`, which builds
  `docs` explicitly. No test covers that path, so M6 survives (A4-04).
- **Coverage artifact.** `cli/commands/askCmd.ts:43-47` reports as uncovered, but `test/cli/ask.test.ts` and
  `test/cli/surfaces.test.ts` clearly run them (output and budget errors are asserted). The likely cause is that
  `vi.mock` of `synth/index.js` changes v8's source mapping for that file. Treat that file's line data as unreliable.
- **Test typecheck.** `npm run typecheck` uses `tsconfig.json`, which excludes `test/`. CI runs only that script, and
  vitest's `typecheck` is disabled, so test files are never typechecked. `npx tsc -p tsconfig.test.json --noEmit`
  reports 6 errors, all on one line:

  ```
  test/ingest/prune.test.ts(95,7): error TS18048: 'gone.docs' is possibly 'undefined'.
  test/ingest/prune.test.ts(95,19): error TS18048: 'gone.refs' is possibly 'undefined'.
  test/ingest/prune.test.ts(95,31): error TS18048: 'gone.embeddings_vec' is possibly 'undefined'.
  test/ingest/prune.test.ts(95,53): error TS18048: 'gone.embeddings_meta' is possibly 'undefined'.
  test/ingest/prune.test.ts(95,76): error TS18048: 'gone.fts' is possibly 'undefined'.
  test/ingest/prune.test.ts(95,87): error TS18048: 'gone.edges' is possibly 'undefined'.
  ```

  `test/audit/audit-4.test.ts` typechecks clean under that config.

## Findings

### Critical

None. `src/core` has 96.6% line coverage, above the 85% target.

### High

**A4-01: An unreadable directory silently prunes every file indexed under it.** High.
- Class: (a), data loss. Not tested.
- Evidence:
  - `walkRepo` swallows a `readdirSync` error and returns (`ingest/walker.ts:70-74`). A `statSync` error is treated the
    same way (`walker.ts:89-93`).
  - `indexRepo` treats every indexed path the walk did not return as deleted (`ingest/indexer.ts:184-192`). It removes
    the file's symbols, imports, refs, edges and embeddings, and turns its docs into tombstones. The next `atlas docs`
    run clears those tombstones for good.
  - `stats.filesFailed` stays 0, so nothing is reported.
  - A transient `EACCES`, `EMFILE` or network-FS error on one directory therefore drops that subtree from the index and
    its docs.
- Repro: `A4-01` (`it.fails`). `readdirSync` is made to throw `EACCES` for `lib/`; the run returns `filesRemoved: 1` and
  `lib/b.ts` is gone.
- Test that should exist: a walk error on a directory or a file keeps the existing rows, and either counts the failure
  or aborts the prune.

**A4-02: A real parser failure wipes a file's symbols and records its new hash, so it is never retried. The existing
tests mock a failure that cannot happen.** High.
- Class: (a), data integrity.
- Evidence:
  - The §Interfaces contract says: "a file's `content_hash` is written … only after a successful parse".
  - `parseSource` catches a tree-sitter throw (`parse/parser.ts:105-115`) and returns `symbols: []` with an `error`
    diagnostic.
  - `indexRepo` only treats a thrown exception as failure (`indexer.ts:109-120`). It deletes the old symbols and refs,
    writes the new hash, and counts the file as indexed.
  - The next run skips the file as unchanged.
  - `test/ingest/failure.test.ts` and `test/drift/unindexed.test.ts` mock `parseSource` to throw, which the real code
    never does, so they pass while this path is broken.
- Repro: `A4-02` (`it.fails`). It injects `Invalid argument` from `tree-sitter`'s `Parser#parse`, the R1 error. Result:
  `filesFailed` is 0 instead of 1, and the hash is replaced.
- Test that should exist: the same retry contract as `failure.test.ts`, driven through the real `parseSource` with
  `tree-sitter` faulted. Either the indexer treats an internal-failure diagnostic as a failed parse, or the contract is
  changed explicitly.

**A4-03: The dashboard's read-only guarantee is untested.** High.
- Class: (a), read-only guarantee.
- Evidence:
  - `serveCmd.ts:22` opens the index with `{ readonly: true }`. M1 removes it, and the whole suite still passes.
  - A read-write open enables WAL, runs migrations and writes `-wal`/`-shm` files.
  - The `serve` action after `startServer` (`serveCmd.ts:27-36`) is never executed.
  - `test/web/server.test.ts` passes its own handle to `startServer`, and `test/cli/readonly.test.ts` does not cover
    `serve`.
- Repro: `it.todo('A4-03 …')` in `test/audit/audit-4.test.ts`.
- Test that should exist: run `atlas serve --port 0 --cwd <copy>` in-process. Then:
  - assert `db.readonly === true`, or that a `chmod -w` copy of `.atlas/index.db` serves `/api/stats`;
  - assert no `-wal` file appears;
  - stop the server.

**A4-04: Drift tombstones are not tested through `runDrift`, which the CLI and MCP use.** High.
- Class: (a), drift soundness.
- Evidence:
  - M6 removes `...deletedDocsFromDb(db)` from `drift/run.ts:32`, and the whole suite still passes.
  - Without it, `atlas drift` and `atlas_drift` in DB mode report "no stale docs" after a documented file is deleted and
    re-indexed. This is the R2 false negative SG12 fixed.
  - The only tombstone test (`drift/completeness.test.ts:145`) calls `detectDrift` without `docs`, which loads
    tombstones on its own.
- Repro: `it.todo('A4-04 …')`.
- Test that should exist: index, run `atlas docs`, delete a file, re-index, then `atlas drift --json` (and
  `handleDriftTool`) report it stale with `currentHash: 'missing'` and exit 2.

**A4-05: The ask budget's boundary is untested.** High.
- Class: (a), budget safety.
- Evidence:
  - M9 lets `budgeted()` overrun the remaining budget by 1,000 tokens (`synth/budget.ts:52`), and the whole suite still
    passes.
  - The only refusal test (`cli/surfaces.test.ts:87`) uses `tokenBudget: 100` against a call reserving thousands.
  - The MCP test checks only that spend is recorded.
  - The synthesis budget (`synthesize.ts:86`) is likewise tested only with a client whose billing exactly matches the
    estimate (`synth/bounded.test.ts:78`).
- Repro: `it.todo('A4-05 …')`.
- Test that should exist: a fake client and a budget set to exactly `ceil(chars/3) + maxTokens`, which must be
  accepted. One token less must be refused. A second call after spend must be refused once `remaining()` falls below
  its reserve.

### Medium

**A4-06: Test files are never typechecked.** Medium.
- Evidence: `tsconfig.json` excludes `test`, and `npm run typecheck` and CI use only it. `vitest.config.ts` sets
  `typecheck: { enabled: false }`, and esbuild strips types. `npx tsc -p tsconfig.test.json --noEmit` reports 6 errors at
  `test/ingest/prune.test.ts:95` (listed above).
- Should exist: `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"`, after fixing line
  95 (for example `Object.values(gone).reduce(...)`, or non-null assertions).

**A4-07: Migration upgrade paths v1 → v2 and v1 → v5 have no test.** Medium.
- Evidence: the table above. Line coverage of `schema.ts` is 100% only because every fresh DB runs all migrations.
  Migration v2 drops a table (`DROP TABLE IF EXISTS embeddings`). An ad hoc v1 → v5 upgrade succeeded.
- Should exist: build a DB with only migration 1 and a file and symbol row. Then open it, assert `MAX(version) = 5`, that
  the rows survive, that `symbols_fts` is backfilled, and that the next `indexRepo` re-parses the file.

**A4-08: Drift for a file deleted on disk but not re-indexed works only through an untested read failure.** Medium.
- Evidence:
  - `detect.ts:162-168` returns `false` on a read error. The comment says "the prompt check and pruning cover it".
  - The prompt check covers it only because `modulePrompt` calls `readFileFromRoot`, which returns `null` on a missing
    file (`vector/textForSymbol.ts:74-75`, uncovered). With no source in the prompt, its hash changes.
  - The auditor confirmed the behaviour is correct today, but nothing pins it. A refactor that drops source from the
    prompt would make it a silent false negative.
- Repro: `it.todo('A4-08 …')`.
- Should exist: index, run `atlas docs`, `rm` a file without re-indexing, then `runDrift` reports it stale (both DB and
  `--docs-dir`).

**A4-09: A read-only open skips migrations and does not check the schema version.** Medium.
- Evidence: `db/database.ts:38-43` runs no migrations and no version check when `readonly`. `atlas serve` on an index
  built by an older Atlas fails later with SQL errors (for example a missing `symbols_fts` gives a 500 on
  `/api/search`), instead of "re-run `atlas index`". Not tested.
- Should exist: a read-only open of a DB with `MAX(_migrations.version) < 5` raises a clear error.

**A4-10: Several import and heritage forms are never parsed in tests, so possible missing edges go unnoticed.** Medium.
- Class: (a), graph false negatives.
- Evidence: these `parse/ts.ts` paths are uncovered:
  - side-effect `import './x'` (577-579);
  - `implements ns.I` and `extends ns.Base` through `nested_type_identifier` (202-205);
  - `require()` wrapped in parentheses or member access, `const [a] = require(...)`, and `require` with no binding
    (622-628, 659-661, 690-691).

  None appears in `fixtures/graph/expected-edges.json`.
- Should exist: add each form to the golden fixture with its expected `imports` or `implements` edge.

**A4-11: The real Anthropic client is never executed.** Medium.
- Class: (a), budget accounting and key safety.
- Evidence:
  - `synth/llmClient.ts:44-61` is uncovered: request mapping, the `system` omission, the temperature default, text-block
    joining, and the `usage` → token mapping that budgets depend on.
  - Key handling is tested only for an unset key (`mcp/server.test.ts:269`).
  - No test asserts that the key is absent from errors or logs when the API rejects a call.
- Should exist: point `ANTHROPIC_BASE_URL` at a local fake HTTP server. Then assert:
  - the request body;
  - `inputTokens` and `outputTokens` mapped from `usage`;
  - that a 401 error message does not contain the key.

**A4-12: The dashboard's HTTP error paths are untested.** Medium.
- Evidence: these `web/server.ts` paths are uncovered:
  - `/api/doc/file/abc` → 400 (122-125);
  - `/api/doc/architecture` → 404 when there is no doc (136-139);
  - the `500` branch of the catch-all (203-205);
  - SPA fallback and `404` (194-202).

  The `403` branch (181-185) is unreachable: `normalize()` already removes the `..` segments. Class (c).
- Should exist: one table-driven test over those routes, plus a forced DB error for the 500.

### Low

**A4-13: Dead code.** Low.
- Class: (c).
- Evidence: none of these has a caller in `src/`:
  - `src/core/index.ts` (whole barrel);
  - `TokenBudget.total()` and `tryCharge()` (`synth/budget.ts:18-36`);
  - `getEmbeddingMeta` (`vector/store.ts:71-79`);
  - `isSupported` (`ingest/language.ts:26-28`);
  - `findSymbolsByKind` and `getLastRun` (`db/repo.ts:110-112`, `291-293`).

  The barrel and `budget.ts` together account for two of the three files under 85%.
- Should exist: delete them, or test them if they are meant as public API.

**A4-14: The budget is estimate-based, and no test uses a client that bills above the estimate.** Low.
- Evidence: the pre-call check reserves `ceil(chars/3) + maxTokens` (`synthesize.ts:86`, `budget.ts:51`). A tokenizer
  denser than 3 characters per token can overshoot the cap by at most one call. This is documented in `DECISIONS.md`
  but not pinned.
- Should exist: a client billing `chars/2` produces a bounded overshoot (at most one call) and stops afterwards.

**A4-15: Invalid `.atlas/config.json` JSON is untested.** Low.
- Evidence: `config.ts:76-78`.
- Should exist: the CLI exits 1 with "Invalid JSON in …".

**A4-16: Coverage blind spots: code that runs out of process.** Low.
- Evidence:
  - `src/web/static/app.js` (0/204) is evaluated in jsdom.
  - `src/cli/index.ts` (0/9) and `startMcpServer` (`mcp/server.ts:320-324`) run only in subprocesses.

  Their behaviour is tested, by `web/rendering.test.ts` and the MCP stdio test, but it is invisible to the numbers.
- Should exist: exclude these from `coverage.include`, or collect subprocess coverage (`NODE_V8_COVERAGE`), before
  adding a threshold.

**A4-17: `askCmd.ts` line data is unreliable under `vi.mock`.** Low.
- Evidence: lines 43-47 are reported uncovered although the ask tests run them (see Test quality).
- Should exist: nothing to fix in the product. Note this before trusting per-line numbers in mocked modules.

## Summary

The coverage target is met with room to spare: 96.6% lines in `src/core` against a target of 85%, and 91.2% overall.
Three `src/core` files are below 85% (`parse/parser.ts` 81.0%, `synth/budget.ts` 82.2%, `core/index.ts` 0%). Mostly
dead or defensive code, except the chunked-parse catch.

The suite is strong on its main paths: seven of ten targeted mutations were killed, often by several tests. The gaps
are on failure and safety paths:
- **A4-01 and A4-02** are real data-loss defects in the indexer, reproduced as `it.fails`.
- **A4-02** hides behind tests that mock an exception the product can no longer throw.
- **A4-03 to A4-05** are surviving mutations in the dashboard's read-only open, the CLI/MCP drift tombstones and the
  budget boundary. Each needs one targeted test.
- Test files are never typechecked (6 errors today).

Recommended next sub-goal:
1. Fix A4-01 and A4-02.
2. Add the A4-03 to A4-05 tests.
3. Typecheck `test/`.
4. Then add a coverage threshold: lines 90 and branches 85 on `src/core`, with out-of-process files excluded.
