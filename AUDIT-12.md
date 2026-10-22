# AUDIT-12: Test coverage (round 3)

This audit measures test coverage of Atlas after SG18–SG27 and looks for behaviour that no test pins. Base: `556e572`
(SG27 merged) on `claude/atlas-audit-12`. The auditor wrote none of this code.

Method:
- `npm run test:coverage` (v8, `src/**`, thresholds from `vitest.config.ts`) on the base suite, and once more with
  `--exclude 'test/audit/**'` to see what the product tests alone cover.
- 102 hand mutations of the SG18–SG27 code, one at a time, each run against the full default suite
  (`npx vitest run --bail 1`) in a scratch copy of the tree (its own git repo), then restored with
  `git checkout -- <file>`. `git diff -- src` was checked empty after every mutant. The worktree's `src/` was never
  edited.
- Five perf mutations (PF1–PF5) run against both `npm run test:perf` and the default suite.
- Every `it.fails` in `test/audit/` was run once as a plain `it` to check it fails on its stated assertion.
- A differential test of the walker against git: 3,300 random nested `.gitignore` trees, `walkRepo` against
  `git ls-files --others --exclude-standard`.

Repros are in `test/audit/audit-12.test.ts`:
- a plain `it` pins behaviour that is correct today but that a surviving mutation showed no test checks. Each was
  re-run against its mutant and fails there (the mutant ID is in the test name);
- `it.fails` marks a real defect and asserts the correct behaviour. Each was run once as a plain `it` and fails on the
  stated assertion.

**Headline:** lines **98.3% in `src/core`** (threshold 90%), 94.4% overall. Branches 91.9% in `src/core` (threshold
88%), functions 98.4% (threshold 96%). The thresholds pass with room: 6.2 points on branches is ~170 branches.

**Mutations:** 102 run. 8 are equivalent and 2 more showed no observable difference, so 92 count. The existing suite
killed 70: kill rate **70/92 (76%)**, up from 43% in AUDIT-8. Of the 22 survivors, the new audit tests kill 20 (19 plain
tests, 1 `it.fails` that turns red); 2 remain (X07 order only, T12 arguably an improvement).

**Totals:** 0 critical, 1 high, 3 medium, 7 low.

## Coverage

Base: `npm run test:coverage` on `556e572`, 68 files, 622 tests (+1 todo). With this audit: 69 files, 642 tests.

### By directory

| Scope | Lines | Branches | Functions | Lines without `test/audit` |
| --- | --- | --- | --- | --- |
| **All `src/`** | **94.3%** (5989/6350) | 90.8% (2821/3108) | 97.5% (355/364) | 93.8% |
| **`src/core`** | **98.3%** (4982/5070) | 91.6% (2523/2754) | 98.4% (315/320) | 98.1% |
| core (root: `config`, `params`, `project`, `index`) | 96.0% (191/199) | 95.0% (57/60) | 93.3% (14/15) | 96.0% |
| core/db | 98.1% (352/359) | 95.6% (86/90) | 95.2% (40/42) | 98.1% |
| core/drift | 100% (182/182) | 94.9% (75/79) | 100% (6/6) | 98.9% |
| core/graph | 98.4% (1002/1018) | 93.9% (692/737) | 100% (62/62) | 98.0% |
| core/ingest | 98.1% (408/416) | 95.0% (190/200) | 94.1% (16/17) | 98.1% |
| core/parse | 98.2% (1533/1561) | 91.5% (940/1027) | 100% (96/96) | 98.2% |
| core/qa | 100% (205/205) | 89.6% (69/77) | 100% (7/7) | 100% |
| core/synth | 99.1% (683/689) | 85.0% (255/300) | 100% (42/42) | 99.1% |
| core/vector | 96.6% (426/441) | 86.4% (159/184) | 97.0% (32/33) | 96.1% |
| `src/cli` | 94.6% (578/611) | 83.1% (167/201) | 90.9% (20/22) | 91.0% |
| `src/mcp` | 98.2% (269/274) | 93.6% (73/78) | 93.3% (14/15) | 98.2% |
| `src/web` | 40.5% (160/395) | 77.3% (58/75) | 85.7% (6/7) | 40.5% |

With `audit-12.test.ts`: `src/core` 98.3% lines, **91.9%** branches (2537/2762); core/graph branches 94.2%, core/ingest
96.5%, `src/cli` branches 84.7%.

Compared with AUDIT-8 (`2e6a53f`): `src/core` lines 97.3% → 98.3%, branches 89.9% → 91.6%, though `src/core` grew from
3,906 to 5,070 lines. `src/web` is unchanged: `static/app.js` runs inside jsdom (A4-16).

### `src/core` files under 90% lines or 85% branches

| File | Lines | Branches | Note |
| --- | --- | --- | --- |
| `core/index.ts` | 0% | 0% | Dead barrel (A4-13, unchanged). |
| `vector/store.ts` | 88.9% | 93.8% | Dimension-mismatch throw; dead `getEmbeddingMeta` (A4-13). |
| `synth/llmClient.ts` | 98.8% | 63.8% | The real Anthropic client and offline mock branches (A4-11). |
| `vector/embedAll.ts` | 96.2% | 69.2% | "Embedding write did not persist" sanity throw. |
| `vector/textForSymbol.ts` | 94.6% | 73.3% | Lines 74-75 covered only by `test/audit/` (A12-11). |
| `parse/parser.ts` | 92.6% | 82.9% | Chunked-parse fallbacks. |
| `qa/ask.ts` | 100% | 81.3% | Option defaults. |

### Uncovered ranges in the SG18–SG27 code

| File | Uncovered | What it is |
| --- | --- | --- |
| `graph/modules.ts` | 275-277 | A workspace root below the repo root (`apps/package.json` with `workspaces`). No test. |
| | 322-323, 333 | Python imports whose dotted name is not a plain path (the slow root list). |
| | 427-429 | A config file that is listed but cannot be read. |
| | 498-499 | `configDigest` of a config deleted between scan and read. |
| `ingest/indexer.ts` | 196-199 | `onFile` payload of a parse failure (the failure itself is covered). |
| `ingest/walker.ts` | 66-67 | `.gitignore` read failure. |
| `parse/ts.ts` | 233-236, 1136-1205 | Rare declaration shapes (decorated exports, overload lists). |
| `cli/commands/ciCommentCmd.ts` | 25-26 | `--out`. |

### Covered only by `test/audit/`

Without `test/audit/**`, these become uncovered: `cli/commands/searchCmd.ts:41-57` (`search --json`),
`serveCmd.ts:27-29,35-36`, `drift/detect.ts:192-193`, `graph/export.ts:122-125` and `vector/textForSymbol.ts:74-75`.
SG24 moved the unreadable-path and filter-fallback tests into unit suites; these five are what is left of A8-11 (A12-11).

## Mutation results

Run against the full default suite. "Killed by" names the first failing test. "Audit-12 test" means the test added by
this audit; each was re-run against its mutant (`npx vitest run test/audit/audit-12.test.ts`) and fails there.

### `graph/modules.ts` (SG19, SG25, SG27)

| ID | Mutation | Line | Result | Killed by |
| --- | --- | --- | --- | --- |
| M01 | `prefixLengths` sorted ascending (shortest prefix wins) | 547 | killed | `graph/modules` longest wildcard prefix |
| M02 | `PathsMatcher.match` drops `spec.length >= n + suffix.length` | 560 | **SURVIVED** | audit-12 M02 (A12-10) |
| M03 | `paths` targets relative to the config dir even with `baseUrl` | 134 | killed | `graph/modules` child config overrides |
| M04 | No `baseUrl` fallback for bare specifiers | 140 | killed | `freshness` nested jsconfig |
| M05 | Solution-style `references` ignored | 157 | killed | `graph/modules` solution-style tsconfig |
| M06 | `extends` parent's `paths` not inherited | 210 | killed | `freshness` extends parent |
| M07 | `extends: "./dir"` never looks for `dir/tsconfig.json` | 204 | **SURVIVED** | audit-12 `it.fails` A12-07 turns red |
| M08 | Scoped workspace packages (`@s/p`) split at the first `/` | 237 | killed | `audit-9` A9-03 workspaces |
| M09 | No `dist/` → `src/` fallback | 245 | killed | `audit-9` M06 |
| M10 | A package name declared twice is not ambiguous | 288 | killed | `graph/modules` declared twice |
| M11 | Workspace `!exclude` patterns ignored | 279 | killed | `graph/modules` pnpm exclusions |
| M12 | Relative Python import climbs one directory too many | 303 | killed | `audit-9` stdlib `json` |
| M13 | No climb to the importer's package root | 307 | killed | `audit-9` stdlib `json` |
| M14 | Package root tried before the repo root | 318 | **SURVIVED** | audit-12 M14 (A12-06) |
| M15 | Discovered root used even when ambiguous (`>= 1`) | 320 | killed | `freshness` pyproject `where` |
| M16 | `heads` skips the last path segment (module files) | 369 | killed | `audit-1` A1-03 |
| M17 | Nested packages count as discovered roots | 380 | killed | `audit-9` stdlib `json` |
| M18 | A root `src/` needs a root config file to be a Python root | 355 | **SURVIVED** | audit-12 M18 (A12-06) |
| M19 | `package.json` digest hashes every field | 504 | killed | `freshness` version bump |
| M20 | `RESOLVER_VERSION` left out of the fingerprint | 485 | **SURVIVED** | audit-12 M20 (A12-03) |
| M21 | `setup.py` digested by content | 493 | killed | `freshness` fingerprint |
| M22 | `require` condition ranked first | 81 | killed | `audit-9` M19 |
| M23 | JSONC trailing commas not stripped | 673 | killed | `graph/modules` JSONC |
| M24 | `list()` reads `..` directories | 412 | equivalent | `read()` refuses `..` paths too |
| M25 | `exports` star key without the length check | 579 | equivalent | the bad candidate is `src/.ts`; the `sub` fallback still runs |
| M26 | Exact `paths` keys: last wins | 539 | equivalent | JSON object keys are unique |
| M27 | `setup.cfg` not read for package dirs | 356 | killed | `graph/modules` setup.cfg |

### `ingest/walker.ts` and `ingest/indexer.ts` (SG20, SG25, SG27)

| ID | Mutation | Line | Result | Killed by |
| --- | --- | --- | --- | --- |
| W01 | `segmentLocal` accepts `**` | 76 | equivalent | without `/`, `**` is a plain `*` in gitignore |
| W02 | `segmentLocal` accepts `/` | 76 | killed | `walker` nested .gitignore |
| W03 | No per-set carry-down of directory verdicts | 102 | killed* | `walker-gitignore` deeper re-include |
| W04 | Groups always start at the first set | 130 | killed* | `walker-gitignore` deeper re-include |
| W05 | `fileIgnored` falls back to "not ignored" | 153 | killed* | `walker-gitignore` random trees |
| W06 | A child always extends its parent's groups | 131 | no difference found | 3,300 random trees agree |
| W07 | `st.size >= max` (cap exclusive) | 229 | **SURVIVED** | audit-12 W07 (A12-10) |
| W08 | Virtualenvs (`pyvenv.cfg`) walked | 213 | killed | `walker` skip rules |
| W09 | Always take the fast file path | 203 | equivalent | the `exclude` set never ignores a visited directory |
| W10 | Merge non-local sets into local groups | 136 | killed | `walker-gitignore` random trees |
| W11 | Local test for all-dot names | 104 | equivalent | entries are never `.` or `..` |
| I01 | Fresh index reports an upgrade | 133 | killed | `freshness` fresh index |
| I02 | Unreadable walk entry not retried after an upgrade | 156 | **SURVIVED** | audit-12 I02 (A12-02) |
| I03 | Read failure not retried after an upgrade | 170 | **SURVIVED** | audit-12 I03 (A12-02) |
| I04 | Parse failure not retried after an upgrade | 192 | killed | `ingest/failure` upgrade retry |
| I05 | Pruning alone does not re-resolve | 291 | killed | `ci/workflow` custom exclude |
| I06 | No-op fingerprint ignores stored extra inputs | 293 | killed | `freshness` extends parent |
| I07 | Stored fingerprint ignores extra inputs | 303 | killed | `freshness` extends parent |
| I08 | Upgrade notice under `--force` | 134 | killed | `freshness` --force |
| I09 | Stored diagnostics not capped | 301 | killed | `freshness` diagnostics cap |
| I10 | Stored diagnostic count read back as 0 | 88 | **SURVIVED** | audit-12 I10 (A12-10) |
| I11 | Unreadable-dir prefix without `/` (AUDIT-8 M18) | 154 | killed | `ingest/unreadable` sibling prefix |
| X01 | State records extractor version 0 | 321 | killed | `freshness` records version |
| X03 | `--force` no longer a resolve reason | 290 | **SURVIVED** | audit-12 X03 (A12-05) |
| X06 | State records no fingerprint | 322 | killed | `freshness` upgrade |
| X07 | Too-large list not sorted | 250 | **SURVIVED** | none (order only; `readdir` order) |
| X08 | No diagnostics reason in `onFile` | 262 | killed | `index surfaces diagnostics` |

\* W03–W05 are killed only by tests that compare with the pre-SG27 walk, which has the A12-01 defect. On the A12-01
case each of them walks one of the two files git keeps (W03 `x/build/deep/h.ts`, W04 and W05 `x/build/f.ts`); the
tests fail them for that.

### `db/repo.ts`, `graph/resolver.ts` (SG18, SG27)

| ID | Mutation | Line | Result | Killed by |
| --- | --- | --- | --- | --- |
| R01 | Rows reversed inside each batch | 192 | killed | `db/repo` batched inserts |
| R02 | Batch sizes `[64, 1]` | 165 | equivalent | same rows, same order |
| R03 | Last-run state from the oldest run | 364 | killed | `freshness` upgrade |
| R04 | Edge `meta` dropped | 159 | killed | `graph/modules` baseUrl |
| R05 | Ref `line` dropped | 262 | killed | `db/repo` batched inserts |
| G01 | Self `references` edges kept | 366 | killed | `graph/references` |
| G02 | `references` to variables | 380 | killed | `graph/references` |
| G03 | Module-level values have no source | 343 | killed | `graph/references` |
| G04 | Members of anonymous default classes importable | 110 | killed | `graph/references` |
| G05 | `references` refs treated as heritage | 316 | killed | `graph/references` |

### `parse/ts.ts`, `parse/py.ts` (SG18, SG26)

| ID | Mutation | Line | Result | Killed by |
| --- | --- | --- | --- | --- |
| T01 | Any `define` argument is a wrapper | 537 | killed | `parse/scopes` define |
| T02 | UMD factories are not wrappers | 538 | killed | `parse/scopes` UMD |
| T03 | `.call`/`.apply` IIFEs are not wrappers | 541 | killed | `parse/assigned` |
| T04 | `definedProperty` accepts any arity | 578 | **SURVIVED** | audit-12 T04/T06 (A12-08) |
| T05 | Import bindings accepted as `obj` | 586 | killed | `parse/scopes` defineGetter |
| T06 | Descriptor/callee pairing not checked | 583 | **SURVIVED** | audit-12 T04/T06 (A12-08) |
| T07 | Defined properties always exported | 593 | **SURVIVED** | audit-12 T07 (A12-08) |
| T08 | Loose module-level methods define symbols | 831 | killed | `parse/scopes` |
| T09 | Chain aliases not defined | 709 | killed | `audit-9` A9-12 |
| T10 | Alias kind copied from the main symbol | 727 | **SURVIVED** | audit-12 T10 (A12-08) |
| T11 | `satisfies` objects not scopes | 907 | killed | `audit-9` A9-07 |
| T12 | `var x = module.exports = <non-object>` gets a default row | 1058 | **SURVIVED** | none (see A12-08) |
| T13 | `export declare` not exported | 139 | killed | `audit-9` A9-11 |
| T14 | Callback calls dropped | 783 | killed | `parse/scopes` |
| T15 | Chain docstring not taken from the statement | 707 | killed | `parse/scopes` chains |
| T16 | `var x = exports.y = …` does not export `x` | 1057 | killed | `parse/scopes` |
| T17 | Alias equal to the main symbol defined twice | 726 | **SURVIVED** | audit-12 T17 (A12-08) |
| X02 | AUDIT-8 M15: `dottedAt` drops `.reverse()` | 343 | killed | `parse/golden` (A12-11) |
| P01 | `__all__ +=` before `=` accepted | 166 | killed | `parse/scopes` |
| P02 | `__all__` operator not checked | 160 | equivalent | only `+=` is valid on a list or tuple `__all__` |
| P03 | `__all__ +=` replaces | 167 | killed | `parse/scopes` |
| P04 | Star import filters values | 346 | killed | `parse/parser` star import |
| P05 | `return` values not refs | 76 | killed | `graph/references` |
| P06 | `boundValueRefs` drops the head-segment check | refs.ts:182 | no difference found | the resolver resolves no ref the head check keeps (A9-09 open) |
| P07 | Python import bindings not bound | 345 | killed | `parse/parser` |

### Synthesis, ask, CLI (SG20–SG22)

| ID | Mutation | Line | Result | Killed by |
| --- | --- | --- | --- | --- |
| S01 | `stop_sequence` incomplete | llmClient.ts:27 | killed | `synth/completion` |
| S02 | Whitespace-only completion accepted | llmClient.ts:34 | killed | `synth/completion` |
| S03 | Only `refusal` incomplete | llmClient.ts:31 | killed | `synth/completion` |
| S04 | `architectureFailed` never set | synthesize.ts:141 | killed | `synth/completion` |
| S05 | Unparsed persisted docs imported | persist.ts:158 | killed | `drift/persisted` |
| X05 | `ask` returns incomplete answers | ask.ts:75 | killed | `audit-7` A7-03 |
| C01 | Legacy report: `--strict` undocumented never fails | ciCommentCmd.ts:84 | **SURVIVED** | audit-12 C01/C03 (A12-09) |
| C02 | Legacy report: `truncated` ignores undocumented | ciCommentCmd.ts:86 | **SURVIVED** | audit-12 C02 (A12-09) |
| C03 | Legacy report: `hasDrift` ignores undocumented | ciCommentCmd.ts:83 | **SURVIVED** | audit-12 C01/C03 (A12-09) |
| C04 | `totals.stale` ignored | ciCommentCmd.ts:77 | killed | `ci/comment` |
| C05 | "…and N more" from the page | ciCommentCmd.ts:157 | killed | `ci/comment` |
| C06 | Strict reason from the page, not totals | ciCommentCmd.ts:111 | **SURVIVED** | audit-12 C06 (A12-09) |
| X04 | CLI says "graph unchanged" unless files were indexed | indexCmd.ts:46 | **SURVIVED** | audit-12 X04 (A12-05) |

Counted: 102 mutants minus 8 equivalent (M24, M25, M26, W01, W09, W11, R02, P02) and 2 with no observable difference
(W06, P06) = 92. Killed by the base suite: 70. Survivors: 22; killed by `audit-12.test.ts`: 20.

The harness is not committed; each mutation is one exact string replacement. To reproduce one, for example I03:

```
# in src/core/ingest/indexer.ts, delete line 170 `if (upgrade && existing) retry.push(existing.id);`, then:
npx vitest run                                    # 622 passed: survives
npx vitest run test/audit/audit-12.test.ts        # I03 fails
git checkout -- src/core/ingest/indexer.ts
```

### Perf gates

Each perf mutation was run against `npm run test:perf` and the default suite. Base `test:perf` (quiet machine):
parse+insert 2.77 ms/file, no-op re-index 7.4 ms/100 files, resolver 326 ms/1k, Python monorepo 50 ms/1k,
`.gitignore` chain 150 µs/file, cached synthesis 111 ms, drift 247 ms, search p95 15.7 ms; 8 passed in 10.2 s.

| ID | Mutation | `test:perf` | Default suite |
| --- | --- | --- | --- |
| PF1 | Revert A10-01: every Python import scans all roots (`modules.ts:312` → `if (false)`) | **fails**: 2,869 ms/1k (budget 2,000) | killed (`audit-10` A10-01 op count) |
| PF2 | Revert A10-04: no segment-local sets (`walker.ts:64` `local: false`) | **fails**: 1,691 µs/file (budget 1,000) | survives |
| PF3 | Revert A10-02: one-row inserts (`BATCH_SIZES = [1]`) | passes: 2.62 ms/file | survives |
| PF4 | Always walk natively (`NATIVE_MIN_DESCENDANTS = 0`) | passes: 2.65 ms/file | survives |
| PF5 | Batched statements not cached (`db.prepare` per chunk) | passes: 2.86 ms/file | survives |

PF1 and PF2 are caught, with 1.4× and 1.7× margin. PF3–PF5 pass both suites (A12-04).

## Test quality

- **A test that pins a wrong result.** `test/ingest/walker-gitignore.test.ts` "keeps a deeper re-include of a directory
  a shallower set ignores" compares `walkRepo` with `referenceWalk`, the pre-SG27 walk. Both drop `x/build/f.ts` and
  `x/build/deep/h.ts`, which git keeps, so the test expects `[]` while its title says the files are kept (A12-01). The
  random-tree test has the same oracle. Neither can catch a divergence from git that both walks share.
- **A test whose name claims more than it checks.** `freshness.test.ts` "resolverFingerprint covers the version, …"
  asserts only `RESOLVER_VERSION > 0`; M20 removes the version from the hash and survives (A12-03).
- **`it.fails` pins.** All 24 `it.fails` in `audit-1/3/5/6/7/9` fail on their stated assertion when run as a plain
  `it` (all `AssertionError`, none a setup error). `query-plan.test.ts` (A8-05) is now a plain test and passes.
- **Stale todo.** `audit-8.test.ts:290` `it.todo('A8-10 (M15) …')` says M15 survives. It does not: `parse/golden`
  kills it (X02) (A12-11).
- **Timing tests.** None left in the default suite (SG23 moved them to `test:perf`). `test:perf` is in CI
  (`.github/workflows/atlas.yml`).
- **Typecheck and lint** cover `test/**`; both pass with this audit's test.

## Findings

### Critical

None. `src/core` has 98.3% line coverage and the configured thresholds pass.

### High

**A12-01: The walker drops files that git keeps when a deeper `.gitignore` re-includes a directory that a shallower
one ignores, and the SG27 test pins that.** High.
- Class: wrong result (silent false negatives in the index), test that passes for the wrong reason. SG20 says the walk
  follows `.gitignore`.
- Evidence:
  - With `.gitignore` = `build/` and `x/.gitignore` = `!build/`, git lists `x/build/f.ts` and `x/build/deep/h.ts`
    (`git ls-files --others --exclude-standard`). `walkRepo` returns neither. The directory *is* visited (the deeper
    set re-includes it), but `fileIgnored` falls back to `g.from > 0` (`ingest/walker.ts:153`), and `verdict` keeps
    the shallower set's carried `state[i]` (`:102`), so every file in it is ignored unless a deeper rule re-includes
    the file itself. Git decides files by their own patterns once the directory is re-included.
  - The pre-SG27 walk did the same (checked on `6fce5a2`), so this is SG20 behaviour. The SG27 parity tests use that
    walk as their oracle, and the test named "keeps a deeper re-include…" asserts the files are dropped.
  - The 3,300-tree differential found no other divergence from git.
  - Effect: every file under such a directory is missing from symbols, edges, search, docs and drift, with no
    diagnostic. A common shape is a root `.gitignore` ignoring `build/` or `lib/` (compiled output) and one package
    re-including its own `lib/` because it is source there.
- Repro: `A12-01` in `audit-12.test.ts` (`it.fails`: `expected [] to deeply equal [ 'x/build/deep/h.ts',
  'x/build/f.ts' ]`; the git half of the test passes).
- Should exist: SG30 (proposed below), with a git-oracle differential test next to the SG27 parity tests.

### Medium

**A12-02: The SG25 retry of files that fail during an extractor upgrade is untested for unreadable paths.** Medium.
- Class: untested guarantee, surviving mutations.
- Evidence: when an upgrade run cannot stat (`indexer.ts:156`) or read (`:170`) a file, its id goes into `retry` so
  its hash is blanked and the next run re-parses it. I02 and I03 delete those pushes; all 622 tests pass. The file then
  keeps the old extractor's symbols and refs after the version is recorded as current, and no later run re-parses it
  until its content changes. Parse failures (I04) are covered by `ingest/failure.test.ts`.
- Repro: `I02`, `I03` in `audit-12.test.ts` (plain `it`; each fails under its mutant). They fault `statSync` /
  `readFileSync` on one file during an upgrade and assert the next run re-parses it and the leaked symbol is gone.

**A12-03: Nothing checks that `RESOLVER_VERSION` is in the resolver fingerprint.** Medium.
- Class: untested freshness guarantee (SG25), misleading test name.
- Evidence: M20 removes `resolver:${RESOLVER_VERSION}` from the hash (`graph/modules.ts:485`); all tests pass. The
  next resolver change that bumps the version, as its doc comment requires, would then not re-resolve existing indexes
  until a file or config changes. The test that claims to cover the version asserts only `RESOLVER_VERSION > 0`.
- Repro: `M20` in `audit-12.test.ts` (plain `it`; pins the hash of an empty tree to `sha256("resolver:<v>\n")`).

**A12-04: The parse+insert perf gate cannot see the SG27 insert work regress.** Medium.
- Class: perf gate blind spot.
- Evidence: `test/perf/index.test.ts` measures Atlas itself at ~2.6–2.8 ms/file against a 5 ms budget. Reverting
  A10-02's batching (PF3), dropping the statement cache (PF5) or always walking natively (PF4) leaves it at
  2.6–2.9 ms/file, and nothing in the default suite counts statements. The workload that is close to the budget, got
  (3.95–4.71 ms/file in SG27/AUDIT-10), is measured only by `scripts/bench.mjs`, which needs a network clone and is
  not in CI.
- Should exist: an operation-count test for `insertBatched` (statements stepped per file, as `audit-10` does for the
  resolver), or a synthetic symbol-dense fixture in `test:perf` that sits near the budget.

### Low

**A12-05: `atlas index` reasons and messages on the resolve path are untested.** Low.
- X03: `--force` is a resolve reason only when no file is re-indexed (empty or all-failing tree); dropping it survives.
- X04: the CLI line after a resolver config change ("resolved N edges … after a resolver config change") survives a
  revert to the pre-SG25 condition, which prints "graph unchanged" after rebuilding the graph.
- Repro: `X03`, `X04` (plain `it`).

**A12-06: Python root precedence is untested.** Low.
- M14: trying the importer's package root before the repo root survives; the order is documented in the
  `modules.ts` header. M18: a root `src/` with no root `pyproject.toml`/`setup.cfg` survives being dropped, because the
  discovered-root fallback hides it unless the package name is ambiguous.
- Repro: `M14`, `M18` (plain `it`, on `ModuleResolver` directly).

**A12-07: `extends: "./base"` prefers `base/tsconfig.json` over `base.json`; tsc does the opposite.** Low.
- Evidence: `tsconfig()` checks for a directory first (`graph/modules.ts:204`). tsc treats a relative `extends` as a
  file: `./base`, then `./base.json`, and errors on a directory (checked with `ts.getParsedCommandLineOfConfigFile`).
  The directory lookup is untested (M07 survives). The results differ only when both exist.
- Repro: `A12-07` (`it.fails`: `expected [ …(2) ] to include 'app.ts::use -calls-> src/util.ts::foo'`).

**A12-08: SG26 property-definition and chain-alias guards are untested.** Low.
- T04 (any arity), T06 (descriptor/callee pairing), T07 (always exported), T10 (alias kind copied), T17 (duplicate
  alias) all survive. Under T07 every `defineGetter(obj, …)` property is reported as an undocumented public symbol.
  T04/T06 turn `wrap(app, 'x', opts, fn)` or `register(app, 'x', { get() {} })` into a method `app.x`.
- T12 (a default row for `var x = module.exports = <call>`) also survives. It changes what a default import binds to
  and may be an improvement, so it is noted, not pinned.
- Repro: `T07`, `T04/T06`, `T10`, `T17` (plain `it`).

**A12-09: `ci-comment` derivations for older reports and the strict reason on an empty page are untested.** Low.
- C01, C02, C03 change how `parseDriftReport` derives `failing`, `truncated` and `hasDrift` for reports that lack them;
  C06 takes the strict reason from the page, so `--strict --offset` past the list prints "failed ()".
- Repro: `C01/C03`, `C02`, `C06` (plain `it`).

**A12-10: Three small boundaries.** Low.
- W07: `maxFileBytes` is inclusive (a file of exactly the cap is indexed); `>=` survives.
- M02: a `paths` pattern `ab*b` must not match `ab`; without the length check a shorter-prefix alias is shadowed.
- I10: a no-op run reports the last resolve's diagnostic count; reading it back as 0 survives.
- Repro: `W07`, `M02`, `I10` (plain `it`).

**A12-11: Leftovers from AUDIT-8.** Low.
- `audit-8.test.ts:290` `it.todo` A8-10 (M15) is stale: `parse/golden.test.ts` kills M15 (X02). Remove it.
- Five ranges are still covered only by `test/audit/` (see Coverage): `search --json`, `serve` startup, `detect.ts:192-193`,
  `export.ts:122-125` and `textForSymbol.ts:74-75`. The coverage thresholds would not notice if those files were
  rewritten, because `src/core` has ~8 points of line headroom.

## Re-verified (AUDIT-8)

| Finding | Status | Evidence |
| --- | --- | --- |
| A8-01 unreadable file pruned | fixed | `ingest/unreadable.test.ts`; I03's sibling path (no upgrade) is covered |
| A8-02 FTS filter fallback | fixed | SG24 unit test |
| A8-03 whole-graph truncation | fixed | SG22 |
| A8-04 drift paging gate | fixed | SG24 |
| A8-05 query-plan repro | fixed | plain test, passes |
| A8-07 stray `.md` counted | fixed | `audit-8` A8-07 is now a plain test |
| A8-08 cross-page edges | fixed | SG22 |
| A8-10 M10/M18 | killed | `drift/paging`, `ingest/unreadable` (I11 here) |
| A8-10 M15 | killed | `parse/golden` (X02); the `it.todo` is stale (A12-11) |
| A8-11 thresholds / tests in findings files | partly fixed | thresholds in `vitest.config.ts`; five ranges remain (A12-11) |
| A8-12 wall-clock tests in the default suite | fixed | SG23 |

## No finding

- **Batched inserts (SG27).** Row order and every column are pinned by `db/repo.test.ts` (R01, R05 killed); batch sizes
  are equivalent (R02).
- **`references` edges (SG18).** All five resolver mutations are killed by `graph/references.test.ts`.
- **Incomplete completions (SG21).** `incompleteReason`, synthesis and `ask` are pinned (S01–S05, X05).
- **Workspaces and tsconfig `paths` (SG19).** 11 of 13 non-equivalent mutations killed by `graph/modules.test.ts`,
  `freshness.test.ts` and `audit-9`.
- **Extractor version state (SG25).** Writing, reading and the `--force` exemption are pinned (I01, I08, X01, X06, R03).
- **Walker vs git.** Apart from A12-01, `walkRepo` matched `git ls-files --others --exclude-standard` on 3,300 random
  nested `.gitignore` trees (up to 28 patterns, including negations, anchors, `**` and directory-only rules).

## Verification

On `556e572` plus `test/audit/audit-12.test.ts` (4 vCPU):

| Command | Result | Time |
| --- | --- | --- |
| `npm run typecheck` | pass | 6.9 s |
| `npm run lint` | pass | 2.4 s |
| `npm run test:coverage` | 69 files, 642 passed, 1 todo; thresholds pass | 29.8 s |
| `npm run test:perf` | 8 passed | 10.7 s |
