# AUDIT-53: Test coverage (round 15, final)

This audit checks whether the product suite (every test file outside `test/audit/`) catches a regression in:
- the SG240/SG270 code paths: `readIndexedSource` (`src/core/vector/textForSymbol.ts`) and its callers
  `handleSymbolTool` (`atlas_symbol`), `retrieve` and `ask`'s note (`atlas ask`/`atlas_ask`), `buildModuleContext`
  (`atlas docs`, drift's `modulePrompt`) and drift's "unindexed" check, plus the indexer's `content_hash` they compare
  against;
- the files with the weakest branch coverage: `synth/llmClient.ts` (59.5%), `vector/embedAll.ts`,
  `vector/textForSymbol.ts`, `parse/parser.ts`, and the most uncovered branches in `vector/search.ts`;
- the carry-overs A49-03 and A49-04, re-checked (not re-filed).

Base: `960d277` on `claude/atlas-audit-53` (includes SG270 #98 and AUDIT-50 #99). Node 22, 4 vCPU, shared with other
audit runs (load average about 7). The auditor wrote none of this code.

Method:
- `npx vitest run --coverage --exclude 'test/audit/**'` (the product suite: 65 files, 608 tests), and once more with
  `audit-53.test.ts` added (`--exclude 'test/audit/!(audit-53).test.ts'`).
- 38 hand mutants (AUDIT-49's 23 re-run, 15 new), applied one at a time to the worktree's `src/` as exact, unique
  string replacements, each run against the **whole product suite** (JSON reporter, no bail, every failing test
  recorded), then reverted with `git checkout -- src/` and checked clean (`git status --porcelain -- src`) after
  every mutant. `git diff src/` is empty at the end. Harness (`run.mjs`) and mutant list (`mutants.mjs`) are in the
  session scratchpad under `audit-53/`, not committed.
- Product survivors in SG240's code and `search` (H03, H04, H05, H06, H07, N04, A01, S03) were then run against all of
  `test/audit/` (about 140 s each); the carry-overs against the audit files AUDIT-49 named. `audit-53.test.ts` was
  written while these ran, so the later "audit" runs include it; the table names the killing files, and every
  `audit-53` kill below is also given without it.
- No flaky result: every product run of the unmutated tree passed 608/608, and no mutant failed a test unrelated to
  its change.

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core`, without `test/audit` | **97.9% (5596/5716)** | 91.5% (2766/3024) | 97.8% (361/369) | 90% / 88% / 96%: pass |
| `src/core`, without `test/audit`, plus `audit-53` | 97.9% (5596/5716) | 91.5% (2769/3025) | 97.8% (361/369) | |
| all of `src/`, without `test/audit` | 94.1% (6665/7084) | 90.7% (3086/3401) | 97.1% (405/417) | |
| `vector/textForSymbol.ts` | 81.9% (59/72) | 77.8% | 85.7% (6/7) | |
| `qa/retrieve.ts` / `qa/ask.ts` / `drift/detect.ts` | 100% / 100% / 100% | 95.5% / 85.7% / 96.5% | 100% each | |
| `synth/context.ts` | 99.2% (250/252) | 91.0% (89.7% in AUDIT-49) | 100% | |

Unchanged from AUDIT-49 except branches: SG270's tests run `context.ts:147`'s no-source branch and `ask.ts`'s
`'their'` branch. Functions are still 97.8%: `readFileFromRoot` is still never run (A49-03, open).

**Mutations (38):**
- **SG240/SG270 (25 mutants): 16 killed (64%) by the product suite.** AUDIT-49's two holes are closed: C04
  (`buildModuleContext` reading unchecked) and N02 (the note naming one file) are now killed by SG270's tests, as are
  the new C05, N06, N07 and D03. Survivors: **H04, H06, H07** (the two sides of the hash comparison stop agreeing on
  a file with a BOM or a non-UTF-8 byte; A53-01), H03 (A49-03, carry-over), A01 (A49-04, carry-over), H05 (benign)
  and N04 (equivalent).
- **Weakest branches (6 mutants): 5 killed.** `search`'s filtered FTS fallback (S01, S02) and the Anthropic
  client's stop reason, text-block filter and usage (L01–L03) are pinned. S03 (structural ranks never tie) survives
  everything (A53-02).
- **Carry-overs (7 mutants): 3 killed** (T03, B02, R02 by `test/db/leftoverWal`, as in AUDIT-49). G06, V01, V02, X01,
  X02, X03 still survive 608/608 and are each killed only by the audit file AUDIT-49 named.
- **Total: 24 of 38 killed by the product suite; 35 with the existing `test/audit`** (H03 and G06 only through an
  `it.fails`); `audit-53` adds no new kill beyond them but pins H04/H06/H07's user-facing consequences. Never killed:
  N04 (equivalent), H05 (benign), S03 (A53-02).

**Totals:** 0 critical, 1 high, 0 medium, 1 low. One new SG row (SG310).

## Coverage

### Weakest branch coverage in `src/core` (product suite)

| File | Branches | What is not run |
| --- | --- | --- |
| `synth/llmClient.ts` | 59.5% (44/74) | almost all `?? ''` / `?? 0` defaults in the offline mock's regex captures (`:99-174`), `sdk.default ?? …` (`:54`); the real client's paths are run through `test/helpers/fakeAnthropic` and pinned (L01–L03 killed) |
| `vector/embedAll.ts` | 71.4% (10/14) | `:74-75` a symbol whose file row is gone; `:86-94` the progress callback's branches |
| `vector/textForSymbol.ts` | 77.8% (14/18) | `:63-66` `makeSourceLoader`'s unreadable file; `:71-81` `readFileFromRoot` (dead, A49-03); `:94-96` `readIndexedSource`'s unreadable file (A49-03) |
| `parse/parser.ts` | 82.5% (33/40) | `:52-54`, `:114-116` exhaustive-switch `never` defaults (unreachable); `:157` `syntaxDiagnostics` throwing |
| `vector/search.ts` | 88.9% (88/99) | `:46-48` blank query / no vector; `:199` the FTS fallback with no filter (unreachable: no filter means `keep` never drops a row); `:103` tie branch is run but S03 shows its effect is never asserted |

### Not run, or run but never asserted, in SG240's code

| Lines / branch | What it is |
| --- | --- |
| `textForSymbol.ts:95-96` | `readIndexedSource`'s `catch` (unreadable or deleted file): never run (A49-03, open) |
| `textForSymbol.ts:97` with a BOM or a non-UTF-8 byte | run on ASCII files only: nothing checks that it and `indexer.ts:358` hash the same text (A53-01) |
| `server.ts:218` (`file ?` false) | `handleSymbolTool` for a symbol whose file row is missing: never run |

Line coverage hides A53-01: `textForSymbol.ts:97` and `indexer.ts:358` both run in hundreds of tests, but every file
the product suite indexes is plain UTF-8 with no BOM, where hashing the decoded text and hashing the bytes give the
same answer.

## Mutation results

"Product" is the whole suite without `test/audit` (608 tests). "Audit" names the audit file(s) that kill a product
survivor. Killing tests are named for product kills.

### SG240: `readIndexedSource` and the hash it compares with

| ID | Mutation | Product | Audit |
| --- | --- | --- | --- |
| H01 | hash compare always "unchanged" | killed (7: `drift/unindexed` ×2, `mcp/server`, `qa/ask` ×2, `synth/synthesize` ×2) | |
| H02 | a mismatch still returns the source | killed (5: `mcp/server`, `qa/ask` ×2, `synth/synthesize` ×2) | |
| H03 | an unreadable file counts as changed (`catch` returns `changed: true`) | survived | only `it.fails`: `audit-5` A5-11, `audit-48` A48-01, `audit-50` (its fix direction; A49-03) |
| H04 | `readIndexedSource` hashes the raw bytes (`sha256(source)` → `sha256(readFileSync(join(root, file.path)))`) | **SURVIVED** | `audit-50` "an untouched file with a BOM, CRLF … reads as unchanged", `audit-5` A5-10's `it.fails`; `audit-53` ×3 |
| H05 | `readIndexedSource` also accepts the hash of `trimEnd()` (or `trimEnd() + "\n"`) | survived | none: benign (trailing whitespace shifts no line, so no wrong lines are served) |
| H06 | the indexer hashes the raw bytes (`indexer.ts:358`, `sha256(content)` → `sha256(readFileSync(file.absolutePath))`) | **SURVIVED** | `audit-50` (same test), `audit-5` A5-10's `it.fails`; `audit-53` ×3 |
| H07 | `readIndexedSource` strips a BOM before hashing | **SURVIVED** | `audit-50` (same test) only; `audit-53` ×3 |

### SG240/SG270: the callers ignore `changed`

| ID | Mutation | Product |
| --- | --- | --- |
| C01 | `handleSymbolTool` reads with `readFileFromRoot` (no hash check) | killed (`mcp/server` "atlas_symbol withholds the excerpt …") |
| C02 | `retrieve` serves the unchecked source | killed (`qa/ask` ×2) |
| C03 | `retrieve` never records a changed path | killed (`qa/ask` ×2) |
| C04 | `buildModuleContext` reads with `readFileFromRoot` | **killed** (`synth/synthesize` "buildModuleContext has `add`'s source before the edit …", "synthesizeDocs sends no inserted line …"): AUDIT-49's A49-01, fixed by SG270 |
| C05 | `buildModuleContext` splits `''` when there is no source (`source ? … : []` → `(source ?? '').split`) | killed (`synth/synthesize` "buildModuleContext …") |

### SG240/SG270: `ask`'s note and `atlas_ask`

| ID | Mutation | Product | Audit |
| --- | --- | --- | --- |
| N01 | `ask` drops the note | killed (`qa/ask` ×2) | |
| N02 | the note names only `paths[0]` | **killed** (`qa/ask` "names every changed file in the note"): A49-02, fixed by SG270 | |
| N03 | the note names the first indexed file | killed (`qa/ask` ×2) | |
| N04 | the note is passed to `checkCitations` too | survived | none: equivalent (the note has no `[n]` or `file:line`) |
| N05 | a changed file is not cached (its path added per symbol) | killed (`qa/ask` ×2) | |
| N06 | the note always says "their" | killed (`qa/ask` "leaves out snippets …") | |
| N07 | the note always says "its" | killed (`qa/ask` "names every changed file …") | |
| A01 | `handleAskTool` strips the note (`result.answer.split('\n\nNote: ')[0]`) | survived | `audit-48` "SG240: after an unindexed edit, `atlas ask` … and `atlas_ask` … give the same answer" (A49-04) |

### SG240: drift

| ID | Mutation | Product |
| --- | --- | --- |
| D01 | the check inverted | killed (40 tests) |
| D02 | never "unindexed" | killed (`drift/unindexed` "… when the changed file fails to re-index") |
| D03 | `'unindexed'` renamed `'changed'` | killed (same test) |

### Weakest branches

| ID | Mutation | Product | Audit |
| --- | --- | --- | --- |
| S01 | `search`'s FTS fallback drops the kind/file filter | killed (3: `vector/hybrid` kind and file filters, `vector/search` "still returns an FTS-only match inside a selective file filter") | |
| S02 | the FTS fallback never runs | killed (`vector/search` same test) | |
| S03 | structural ranks never tie (`if (i > 0 && …) rank = i` → `rank = i`) | **SURVIVED** | **none** (488 audit tests pass) |
| L01 | the Anthropic client drops `stop_reason` | killed (5: `synth/completion`, incl. "max_tokens: exits 1 … persists nothing") | |
| L02 | the Anthropic client keeps non-text blocks | killed (`synth/completion` "returns the stop reason and joins only text blocks") | |
| L03 | the Anthropic client reports 0 input tokens | killed (2: `mcp/server` budget test, `synth/completion`) | |

### Re-checks of AUDIT-49's carry-overs (A49-03, A49-04)

| ID | Mutation (finding) | Product | Audit |
| --- | --- | --- | --- |
| H03 | unreadable file counts as changed (A49-03) | survived | only `it.fails` (above) |
| A01 | `atlas_ask` handler drops the note (A49-04) | survived | `audit-48` |
| G06 | `inUse` probes without `<db>.open.lock` (A45-03) | survived | only `audit-42` A42-03's `it.fails` |
| V01 | SG105 reverted (A32-01) | survived | `audit-28` A28-01, `audit-30` A30-01 |
| V02 | a one-page file counts as empty (A32-02) | survived | `audit-32` S04 |
| X01 | `nameBusy` names an error twice | survived | `audit-27` SG80, `audit-28` N01 |
| X02 | `nameCorrupt` names an error twice | survived | `audit-31` |
| X03 | `closeOnSignal`'s remover a no-op | survived | `audit-31` "closeOnSignal closes the index …" |
| T03 | `SPACE` widened to any `SQLITE_IOERR*` (A45-02) | killed (`db/leftoverWal`) | |
| B02 | a WAL short read names the `.check-wal` link (A45-02) | killed (`db/leftoverWal`) | |
| R02 | the read-only open's read error thrown at open (A45-03) | killed (`db/leftoverWal`) | |

To reproduce one mutant, for example H04:

```
# in src/core/vector/textForSymbol.ts, replace
#   return sha256(source) === file.content_hash
# with
#   return sha256(readFileSync(join(root, file.path))) === file.content_hash
npx vitest run --exclude 'test/audit/**'                 # 65 files, 608 passed: survives
npx vitest run test/audit/audit-53.test.ts               # 3 failed, e.g. src/latin.ts: expected true to be false
git checkout -- src/ && git diff --exit-code src/
```

H06 is the same check on the other side (`src/core/ingest/indexer.ts`: `    const hash = sha256(content);` →
`    const hash = sha256(readFileSync(file.absolutePath));`), H07 strips a BOM
(`sha256(source.replace(/^﻿/, ''))`).

## Findings

### Critical

None.

### High

**A53-01: Nothing in the product suite checks that `readIndexedSource` and the indexer hash the same text. If either
side hashes the bytes, or normalises a BOM, a file with a BOM or a non-UTF-8 byte reads as "changed" forever, and all
608 product tests pass.** High.
- Class: untested guarantee (H04, H06, H07; `textForSymbol.ts:97` against `indexer.ts:358`).
- Evidence:
  - SG240's guarantee is a comparison: `readIndexedSource` reads the file as UTF-8 text and compares
    `sha256(text)` with `files.content_hash`, which the indexer computed the same way. Every file the product suite
    indexes (`fixtures/sample`, the synthetic repos, the edits in `qa/ask`, `mcp/server`, `synth/synthesize`,
    `drift/unindexed`) is BOM-less ASCII, where bytes and decoded text hash alike. So changing either side to hash
    the raw bytes (H04, H06, a plausible "skip the decode" optimisation) or to drop a leading BOM (H07) passes 608/608.
    Only `audit-50`'s plain `it` (and, for H04/H06, `audit-5` A5-10's `it.fails`) catches them.
  - Consequence under any of the three, on a repo with a Latin-1 comment or a BOM-prefixed file (common in
    Windows-authored code), straight after `atlas index`: `atlas_symbol` returns `excerpt: null` for every symbol in
    the file; `atlas ask`/`atlas_ask` leave out its snippets and end with "Note: src/latin.ts changed since
    indexing …; run `atlas index`", and running `atlas index` does not clear it; `atlas drift` marks its doc
    `unindexed`, so the drift gate and the CI comment fail on every run with a remedy that does not work. Nothing
    wrong is served (it fails safe), but three shipped surfaces break permanently for those files.
  - The tests are compatible with A5-10's open fix direction: with both sides hashing the bytes (H04 and H06
    together) `audit-53` still passes and A5-10's `it.fails` turns green. What they pin is that the two sides agree.
- Repro: H04 above; or H07 and `npx vitest run test/audit/audit-53.test.ts`.
- Test (plain `it`, correct today): `A53-01` in `audit-53.test.ts` (3 tests): on the sample plus `src/latin.ts` (a
  `0xE9` byte) and `src/bom.ts` (BOM, CRLF), after `indexRepo`: `readIndexedSource` reads both unchanged and
  `atlas_symbol` returns their excerpts; `ask` with a capturing client sends both bodies and adds no note; after
  `synthesizeDocs`, `runDrift` reports nothing stale and a second `indexRepo` skips every file. Kills H04, H06, H07.
- Fix (SG310): move these tests into the product suite (for example `test/vector/textForSymbol.test.ts` and
  `test/drift/unindexed.test.ts`).

### Medium

None.

### Low

**A53-02: `search`'s tie handling for equal structural scores is asserted by no test.** Low.
- Class: untested behaviour (S03; `search.ts:103`).
- Evidence: `search` gives equal structural scores one competition rank, so tied symbols get the same structural
  RRF term. With `rank = i` for every hit (S03), all 608 product tests and all 488 audit tests pass. On the sample
  the scores change (`area`: `Square.area` 0.0226 → 0.0225, `Circle.area` 0.0225 → 0.0223; `shapes`: the six
  symbols in `src/shapes.ts` spread from 0.0164–0.0156 to 0.0164–0.0152) but no top-6 order does, so the effect is
  limited to the order among, and just below, many equally good matches (for example every symbol of a file whose
  path matches the query). Not pinned in `audit-53`: a deterministic test needs a crafted embedder and repo, which
  is more than the risk is worth.
- Repro: S03 (`if (i > 0 && h.structuralScore < structural[i - 1]!.structuralScore) rank = i;` → `rank = i;`),
  `npx vitest run --exclude 'test/audit/**'`: 608 passed.

## Re-verified

| Finding | Status | Evidence |
| --- | --- | --- |
| A49-01 `buildModuleContext`'s check unpinned | **fixed** (SG270) | C04 killed by 2 `synth/synthesize` tests; C05 too |
| A49-02 the note for several files unpinned | **fixed** (SG270) | N02 and N07 killed by `qa/ask` "names every changed file in the note" |
| A49-03 unreadable branch never run, `readFileFromRoot` dead | **open** | `textForSymbol.ts:71-81` and `:95-96` still unrun; H03 survives 608/608 and is killed only through `it.fails` (A5-11, A48-01) |
| A49-04 behaviour pinned only by `test/audit/` | **open** | A01 (`atlas_ask`'s note) only `audit-48`; G06 only `audit-42`'s `it.fails`; V01, V02, X01, X02, X03 only `audit-27/28/30/31/32` |

## Verification

On `960d277` plus `AUDIT-53.md`, `test/audit/audit-53.test.ts` and the PLAN lines, on 4 vCPU shared with other runs
(wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npx vitest run --coverage --exclude 'test/audit/**'` | 65 files, 608 passed; thresholds pass | 77 s |
| `npx vitest run --coverage --exclude 'test/audit/!(audit-53).test.ts'` | 66 files, 611 passed; thresholds pass | 50 s |
| `npx vitest run test/audit/audit-53.test.ts && npm run typecheck && npm run lint && git diff --exit-code src/` | pass; 3 tests; `src/` unchanged | 13 s |
