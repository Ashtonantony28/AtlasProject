# AUDIT-49: Test coverage (round 11)

This audit checks whether the product suite (every test file outside `test/audit/`) catches a regression in the code
SG240 (#94) changed. Scope:
- `readIndexedSource` (`src/core/vector/textForSymbol.ts`): the file is hashed and compared with
  `files.content_hash`; on a mismatch `source` is null and `changed` is true, and an unreadable file gives
  `{ source: null, changed: false }`;
- its four callers: `handleSymbolTool` (`atlas_symbol`, `src/mcp/server.ts`), `retrieve`/`retrieveForQuery`
  (`src/core/qa/retrieve.ts`), `buildModuleContext` (`src/core/synth/context.ts`, used by `atlas docs` and by drift's
  `modulePrompt`), and drift's "unindexed" check (`src/core/drift/detect.ts`, refactored onto the helper);
- `ask`'s note (`src/core/qa/ask.ts`): "Note: <paths> changed since indexing, so its/their snippets were left out; run
  `atlas index`.";
- AUDIT-45's open findings (A45-02..04), including G06, re-measured against the product suite.

Base: `9f3b7fc` on `claude/atlas-audit-49` (includes SG230 #92 and SG240 #94). Node 22.22, 4 vCPU. The auditor wrote
none of this code.

Method:
- `npx vitest run --coverage --exclude 'test/audit/**'` (the product suite: 65 files, 605 tests), and once more with
  `audit-49.test.ts` added (`--exclude 'test/audit/!(audit-49).test.ts'`).
- 23 hand mutants, one at a time, each one or two exact string replacements in a scratch copy of the tree (its own
  git repo, `node_modules` symlinked), restored with `git checkout -- src` and checked clean with
  `git status --porcelain -- src` after every mutant (all clean). The worktree's `src/` was never edited. Harness
  (`run.mjs`) and mutant list (`mutants.mjs`) are in the session scratchpad under `audit-49/`, not committed.
- Each mutant ran against the **whole product suite** (JSON reporter, no bail, every failing test recorded). The
  unmutated scratch tree passes 605/605 first. Every survivor was run a second time against the whole product suite
  (10/10 survived again). Survivors in SG240's code (C04, N02, H03, N04) were then run against all of `test/audit/`
  except `audit-49` (456 tests, about 165 s each); the carry-overs against the audit files
  AUDIT-45 named; and the SG240 survivors against `audit-49.test.ts`.
- No flaky result this round: every mutant gave the same verdict on every run.

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core`, without `test/audit` | **97.9% (5596/5716)** | 91.4% (2755/3015) | 97.8% (361/369) | 90% / 88% / 96%: pass |
| `src/core`, without `test/audit`, plus `audit-49` | 97.9% (5596/5716) | 91.5% (2765/3023) | 97.8% (361/369) | |
| `vector/textForSymbol.ts`, without `test/audit` | 81.9% (59/72) | 77.8% | 85.7% (6/7) | |
| `qa/retrieve.ts` / `qa/ask.ts` / `drift/detect.ts` | 100% / 100% / 100% | 95.5% / 80.0% / 96.5% | 100% each | |
| `synth/context.ts` | 99.2% (250/252) | 89.7% (91.0% with `audit-49`) | 100% | |

The 85% lines target is met (97.9%, the same as AUDIT-45). Functions dropped from 98.1% to 97.8%: SG240 left
`readFileFromRoot` with no caller in `src/`, so it is never run (A49-03).

**Mutations (23):**
- **SG240 (14 mutants): 10 killed (71%) by the product suite.** The four survivors: C04 (`buildModuleContext` reads the
  file without the hash check) survives every test in the tree before `audit-49` (A49-01); N02 (the note names only the
  first changed file) likewise (A49-02); H03 (an unreadable file counts as changed) is killed only by `audit-5`'s
  A5-11 `it.fails`, i.e. it is that finding's fix direction (A49-03); N04 is equivalent (below).
- **With `audit-49.test.ts`: 12 of 14.** Left: H03 (fix direction of A5-11) and N04 (equivalent).
- **Re-checks of AUDIT-45 (9 mutants): 3 killed by the product suite** (T03, B02, R02: `test/db/leftoverWal`, SG230).
  G06, V01, V02, X01, X02, X03 survive 605/605 twice and are each killed by the audit file AUDIT-45 named.
- **Total: 13 of 23 killed by the product suite**; 22 with the existing `test/audit` plus `audit-49` (G06 and H03 only
  through an `it.fails`); N04 is never killed (equivalent).

**Totals:** 0 critical, 1 high, 0 medium, 3 low. One new SG row (SG270).

## Coverage

### Not run by the product suite in SG240's code

| Lines / branch | What it is | With `audit-49` |
| --- | --- | --- |
| `textForSymbol.ts:95-96` | `readIndexedSource`'s `catch`: an unreadable or deleted file | not run |
| `textForSymbol.ts:71-81` | `readFileFromRoot`: no caller left in `src/` since SG240 | not run |
| `context.ts:147` (false branch) | `buildModuleContext` on a file with no source (changed or unreadable) | run |
| `ask.ts:90` (`'their'`) | the note for more than one changed file | run |
| `server.ts:218` (`file ?` false) | `handleSymbolTool` for a symbol whose file row is missing | not run |

Line coverage hides A49-01: `context.ts:146` (the `readIndexedSource` call) runs in every synth and drift test, but
never on a file that changed since indexing, so replacing it with an unchecked read passes.

## Mutation results

"Product" is the whole suite without `test/audit` (605 tests). "Audit" names the audit file that kills a product
survivor. Killing tests are named for product kills.

### SG240: `readIndexedSource`

| ID | Mutation | Product | Audit | audit-49 |
| --- | --- | --- | --- | --- |
| H01 | hash compare always "unchanged" (`sha256(source) === file.content_hash` → `true`) | killed (4: `drift/unindexed` ×2, `mcp/server` "withholds the excerpt", `qa/ask` "leaves out snippets") | | killed |
| H02 | mismatch still returns the source (`{ source: null, changed: true }` → `{ source, changed: true }`) | killed (`mcp/server`, `qa/ask`) | | killed |
| H03 | an unreadable file counts as changed (`catch` returns `changed: true`) | survived | only `audit-5` A5-11's `it.fails` (its fix direction) | survived |

### SG240: the callers ignore `changed`

| ID | Mutation | Product | Audit | audit-49 |
| --- | --- | --- | --- | --- |
| C01 | `handleSymbolTool` reads with `readFileFromRoot` (no hash check) | killed (`mcp/server` "withholds the excerpt …") | | |
| C02 | `retrieve` serves the unchecked source (still lists the path as changed) | killed (`qa/ask` "leaves out snippets …") | | |
| C03 | `retrieve` never records a changed path | killed (same) | | |
| C04 | `buildModuleContext` reads with `readFileFromRoot` (no hash check) | **SURVIVED** | **none** (456 audit tests pass) | killed (2 tests) |

### SG240: `ask`'s note

| ID | Mutation | Product | Audit | audit-49 |
| --- | --- | --- | --- | --- |
| N01 | `ask` drops the note | killed (`qa/ask` "leaves out snippets …") | | |
| N02 | the note names only the first changed file (`paths.join(', ')` → `paths[0]`) | **SURVIVED** | **none** | killed |
| N03 | the note names the first indexed file instead of the changed one | killed (`qa/ask`) | | killed |
| N04 | the note is passed to `checkCitations` too | survived | none | survived: equivalent (the note holds no `[n]` or `file:line`) |
| N05 | a changed file is not cached, so each of its symbols adds its path again | killed (`qa/ask`) | | |

### SG240: drift's refactored check

| ID | Mutation | Product |
| --- | --- | --- |
| D01 | inverted (`.changed ?` → `!….changed ?`) | killed (40 tests: `ci/workflow`, `drift/*`, …) |
| D02 | never "unindexed" (`.changed && false`) | killed (`drift/unindexed` "when the changed file fails to re-index") |

D02 is killed by one test only: after a plain edit the doc is still stale, because the prompt (now without snippets)
no longer hashes to the stored `source_hash`.

### Re-checks of AUDIT-45 and carry-overs

| ID | Mutation (finding) | Product | Audit |
| --- | --- | --- | --- |
| T03 | `SPACE` widened to any `SQLITE_IOERR*` (A45-02) | killed (`leftoverWal` "when the check cannot run …") | |
| B02 | a short read of the WAL names the `.check-wal` link (A45-02, AUDIT-45's N02) | killed (`leftoverWal` "on a short read of index.db-wal …") | |
| R02 | the read-only open's read error thrown at open (A45-03) | killed (`leftoverWal` "an error from the read-only open's read is not lost …") | |
| G06 | `inUse` probes without `<db>.open.lock` (`lockOpens(path)` → a no-op) (A45-03) | **SURVIVED** | only `audit-42` A42-03's `it.fails` |
| V01 | SG105 reverted: the size taken in the `catch` (A32-01) | **SURVIVED** | `audit-28` A28-01, `audit-30` A30-01 |
| V02 | a one-page file counts as empty (A32-02) | **SURVIVED** | `audit-32` S04 |
| X01 | `nameBusy` names an error twice | **SURVIVED** | `audit-27` SG80, `audit-28` N01 |
| X02 | `nameCorrupt` names an error twice | **SURVIVED** | `audit-31` |
| X03 | `closeOnSignal`'s remover a no-op | **SURVIVED** | `audit-31` "closeOnSignal closes the index …" |

To reproduce one mutant, for example C04:

```
# in src/core/synth/context.ts, replace
#   import { readIndexedSource } from '../vector/index.js';
# with
#   import { readFileFromRoot } from '../vector/index.js';
# and
#   const { source } = readIndexedSource(root, file);
# with
#   const source = readFileFromRoot(root, db, file.id);
npx vitest run --exclude 'test/audit/**'                      # 65 files, 605 passed: survives
npx vitest run test/audit --exclude test/audit/audit-49.test.ts # 456 passed: survives
npx vitest run test/audit/audit-49.test.ts -t A49-01           # 2 failed: expected '// header added after indexing\n// he…' not to match /header added after indexing/
git checkout -- src/core/synth/context.ts
```

## Findings

### Critical

None.

### High

**A49-01: SG240's hash check in `buildModuleContext` is pinned by no test. Without it, `atlas docs` after an edit that
was not re-indexed grounds module docs in other lines labelled as the file's symbols, and all 605 product tests (and
every audit file) pass.** High.
- Class: untested guarantee (C04; `context.ts:146`, and the false branch at `147`).
- Evidence:
  - SG240's row names three readers that must not slice a changed file: `handleSymbolTool`, `retrieve` and
    `buildModuleContext`. SG240 added product tests for the first two (`test/mcp/server.test.ts` "atlas_symbol
    withholds the excerpt …", `test/qa/ask.test.ts` "leaves out snippets …"), and C01, C02 and C03 are each killed.
    It added none for the third, and AUDIT-46's A46-04 tests do not reach it.
  - Every product test that builds a module context (`synth/*`, `drift/staleness`, `drift/unindexed`, `ci/workflow`)
    does it on a file that matches its index, or (drift) stops at the "unindexed" check before the prompt is built. So
    `context.ts:146` runs, but its `changed` answer is never true there, and C04 (the pre-SG240 unchecked read) passes
    605/605, twice, and all 456 tests under `test/audit/` (without `audit-49`).
  - Consequence under C04: after 12 lines are prepended to `src/math.ts` and `atlas docs` runs without `atlas index`,
    the module prompt's snippet labelled `add` (lines 4-6) is three of the inserted comment lines, and `multiply`'s
    starts with them (`expected '// header added after indexing\n// he…' not to match …`). The model writes
    `src/math.ts`'s doc from them and it is stored like any other doc, for the docs surfaces (`atlas docs --show`,
    `atlas_docs`, the dashboard) to serve. Drift does flag that doc ("unindexed") until the file is re-indexed and the doc regenerated, so the
    wrong doc is reported, but the docs surfaces serve it in the meantime: the A46-04 class (other lines served as a
    symbol's source), on the third reader.
- Repro: C04 above.
- Test (plain `it`, correct today): `A49-01` in `audit-49.test.ts`: `buildModuleContext` has `add`'s source before
  the edit and no snippet after it; `synthesizeDocs` with a capturing client after the edit sends no inserted line in
  `src/math.ts`'s prompt. Kills C04 (and H01, H02).
- Fix (SG270): move these tests into the product suite (for example `test/synth/synthesize.test.ts` or
  `test/drift/unindexed.test.ts`).

### Medium

None.

### Low

**A49-02: `ask`'s note is pinned for one changed file only; the note for two or more is pinned by no test before
`audit-49`.** Low.
- Class: untested boundary (N02; `ask.ts:90-91`, the `'their'` branch never run by the product suite).
- Evidence: `test/qa/ask.test.ts` changes only `src/math.ts` and matches the whole note for it. N02 (only
  `paths[0]` named) passes 605/605 twice and every audit file: with `src/math.ts` and `src/shapes.ts` both changed the
  note says only `src/shapes.ts` changed while `src/math.ts`'s snippets are also left out. Missing advice, not a
  wrong excerpt: the snippets themselves are still withheld (C02 is killed). N04 (the note passed through
  `checkCitations`) is equivalent: the note has no citation syntax.
- Repro: N02 (``return `Note: ${paths.join(', ')} changed`` → ``return `Note: ${paths[0]} changed``):
  `npx vitest run --exclude 'test/audit/**'` 605 passed; `npx vitest run test/audit/audit-49.test.ts -t A49-02`:
  `expected [ 'src/shapes.ts' ] to deeply equal [ 'src/math.ts', 'src/shapes.ts' ]`.
- Test (plain `it`): `A49-02` (two files changed: both named, sorted, with "their"; neither cited). Kills N02, N03.

**A49-03: `readIndexedSource`'s unreadable branch is never run by the product suite, and SG240 left
`readFileFromRoot` dead.** Low.
- Class: untested boundary (H03; `textForSymbol.ts:95-96`, `71-81`).
- Evidence:
  - No product test reads a file that is in the index but unreadable or deleted, so H03 (such a file counts as
    changed) passes 605/605 twice. Its only effect in the tree is to make `audit-5` A5-11's `it.fails` ("deleting a
    symbol-less file is stale in DB mode before re-indexing") pass: H03 is that open finding's fix direction, not a
    regression. Today a file deleted since indexing is dropped from `ask`'s snippets with no note, and its doc's drift
    status depends on whether it had symbols (A5-11).
  - `readFileFromRoot` (exported from `core/vector`) has no caller in `src/` since SG240 moved all four readers to
    `readIndexedSource`; it is the only function in `vector/` never run, and the reason `src/core` functions fell
    from 98.1% to 97.8%. It is also the unchecked read a future caller could pick up (C01, C02, C04 use it).
- Fix: none needed for coverage; deleting `readFileFromRoot` (or a test for the unreadable case, once A5-11's
  direction is decided) would close it.

**A49-04: Behaviour pinned only by `test/audit/`, and AUDIT-45 carry-overs.** Low.
- SG240 on the MCP surface: `atlas_ask` withholding a changed file's snippet from the prompt is pinned only by
  `audit-46` A46-04 ("atlas_ask does not ground the model …"), and `atlas_drift` reporting `unindexed` only by
  `audit-46` "held: … drift marks the doc unindexed". Both go through core calls the product suite pins (`ask`,
  `detectDrift`; C02, C03, D02 killed), so only the thin handler is unpinned.
- G06 (A45-03): `inUse`'s probe without `<db>.open.lock` is killed only by `audit-42` A42-03's `it.fails`.
- A32-01 (V01) and A32-02 (V02): killed only by `audit-28`/`audit-30` and `audit-32` S04.
- X01 (`nameBusy` once-guard) only by `audit-27`/`audit-28`; X02 (`nameCorrupt` once-guard) and X03
  (`closeOnSignal`'s remover) only by `audit-31`. `closeOnSignal`'s handler (`database.ts:603-607`) still runs only in
  `audit-31`'s child processes.

## Re-verified

| Finding | Status | Evidence |
| --- | --- | --- |
| A45-01 SG190's guard audit-only | **fixed** (SG230) | not re-run beyond AUDIT-45's list; SG230's acceptance kills G01–M02 in `leftoverWal` |
| A45-02 A41-03 remedy and WAL short-read name unpinned | **fixed** (SG230) | T03 and B02 killed by `test/db/leftoverWal` |
| A45-03 read-only read error, probe's open lock, both-locks rule | **in part**: R02 fixed (SG230); G06 **open** | R02 killed by `leftoverWal`; G06 survives 605/605 twice, killed only by `audit-42` A42-03's `it.fails`; G05 (fails safe) not re-run |
| A45-04 carry-overs | **open** | V01, V02, X01, X02, X03 survive 605/605 twice; killed only by `audit-27/28/30/31/32` |
| A46-04 excerpts sliced from a changed file | **fixed for `atlas_symbol` and `ask`** (SG240, pinned) | H01, H02, C01, C02, C03, N01 killed; `buildModuleContext` unpinned (A49-01) |

## Verification

On `9f3b7fc` plus `AUDIT-49.md`, `test/audit/audit-49.test.ts` and the PLAN lines, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npx vitest run --coverage --exclude 'test/audit/**'` | 65 files, 605 passed; thresholds pass | 82 s |
| `npx vitest run --coverage --exclude 'test/audit/!(audit-49).test.ts'` | 66 files, 608 passed; thresholds pass | 58 s |
| `npm run typecheck && npm run lint && npx vitest run test/audit/audit-49.test.ts` | pass; 3 tests; `src/` unchanged | 18 s |
