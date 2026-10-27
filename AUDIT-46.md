# AUDIT-46: soundness (round 14, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `10cccef` (SG230 #92 merged; test-only) on
`claude/atlas-audit-46`. Date: 2026-10-27.

Question: can Atlas silently lose data, serve wrong results, or report a clean state that isn't clean? Recent rounds
(AUDIT-33 to AUDIT-42) went almost entirely into the leftover-WAL work in `src/core/db/database.ts`. This round looks
first at the areas they covered less:
- incremental indexing and skipped files;
- drift's stale and undocumented detection on renames, deletes and moved files;
- `.gitignore` handling in the walker;
- search filters;
- MCP tool results against the CLI's core calls.

Also re-checked: A42-01, A42-02, A42-03 and A39-01. The two notes from AUDIT-44/45 (A44-01's startup offer, A43-02)
were looked at only for a new consequence. I found none.

Method:
- **In-process, sample fixture.** I used copies of `fixtures/sample` with the offline LLM, the core calls the CLI
  makes (`indexRepo`, `synthesizeDocs`, `exportDocs`, `runDrift`, `search`) and the MCP handlers
  (`createMcpContext`, `handleIndexTool`, `handleSymbolTool`, `handleAskTool`, `handleSearchTool`,
  `handleDriftTool`).
- **Real CLI.** I confirmed the high and the mediums with the CLI from this tree (`node --import tsx
  src/cli/index.ts`).
- **`.gitignore` fuzzing against git.** `fuzzgi.mts` builds random trees (6 directories, 14 files, 3 `.gitignore`
  files drawn from 36 patterns: negations, anchors, `**`, trailing `/`, character classes, escapes, mixed case).
  It compares `walkRepo` with `git ls-files --others --exclude-standard` (git 2.x, `core.ignorecase` unset, as on
  Linux and the `ubuntu-latest` CI runner).
  - Seeds 1–299 (the run stops at 8 disagreeing trees, reached at seed 69): 6 had files git keeps and Atlas skips, all from
    case-insensitive matching; 2 had only extra files (an escaped `?`, see Notes).
  - Seeds 1–599 again with the walker's `ignore()` patched to `ignorecase: false` in a scratch copy (not
    committed): 1 tree skipped files git keeps (`src/**/`).
- **Exported-flag probe.** `exp1.mts` parses 32 export forms (TS/JS/Python) and lists each symbol's `exported`
  flag. Drift's undocumented list depends on that flag.
- **Regressions.** I ran the soundness files audit-1, -5, -9, -13, -17, -21, -25, -29, -33, -34, -36, -39 and -42
  as they are: 13 files, 186/186 pass, 2m26s. Then I ran audit-39 and audit-42 with every `it.fails` turned into
  `it`.

The scripts are in the session scratchpad under `audit-46/`:
- `fuzzgi.mts`, `fuzzgi2.mts`;
- `exp1.mts`;
- `drift1.mts`, `arch.mts`;
- `excerpt.mts`.

Every process I started has exited. No mount, namespace or loop device was used.

Repros are in `test/audit/audit-46.test.ts`. Each `it.fails` asserts the correct behaviour. I ran the file with each
`it.fails` as a plain `it`: each failed on the assertion that names its defect (messages below). Plain `it` blocks
pin what was attacked and held. Everything runs in-process. `git` is used only to read git's own verdict on a
`.gitignore`.

**Summary: 0 critical, 1 high, 2 medium, 1 low.**
- What holds:
  - **Incremental indexing.** An unchanged re-index skips every file (`filesIndexed: 0, filesSkipped: 4`). One edit
    re-parses only that file and re-resolves the graph. A rename, a move into a new directory, a delete, and a file
    that becomes ignored are each pruned with their embeddings.
  - **Drift on renames, moves and deletes.** The old path's doc is reported `missing` and fails the gate (exit 2),
    in index mode (tombstones) and with `--docs-dir`. The new path's exported symbols are listed undocumented.
  - **Drift on unindexed edits.** A file changed on disk since indexing is `unindexed` (stale) on the MCP surface
    too.
  - **Search filters.** `kind` and `file` are pushed into every candidate query. An exact-name hit survives the
    filter and nothing outside it comes back.
  - **MCP against the CLI.** `atlas_search` returns the same names, files and lines as the core `search` the CLI
    calls, with and without filters. `atlas_drift` (limit 1000) returns the same `stale`, `undocumented` and
    `failing` as `runDrift`.
  - **`.gitignore`.** Same-case patterns, negations, anchors and nested sets agree with git on the tested trees.
- The high (**A46-04**): `atlas_symbol` and `ask`/`atlas_ask` read excerpts from the file on disk at the line
  numbers the index stored, without checking the file still has the indexed content. After an edit that was not
  re-indexed, they return other lines labelled as the symbol. `ask` grounds the model on them and cites
  `file:line` ranges that no longer hold the symbol. Every check passes, and no surface says the file changed.
- The mediums:
  - **A46-01**: the walker matches `.gitignore` (and config `exclude`) rules case-insensitively, which is the
    `ignore` package's default. On Linux, `Build/` drops `src/build/`, `Config.ts` drops `src/config.ts`, and
    `[A-Z]*.gen.ts` drops `src/api.gen.ts`. Git keeps all three, and nothing reports them as skipped.
  - **A46-03**: a missing architecture doc is never reported. That happens when `atlas docs` runs out of budget
    after the module docs, or when `architecture.md` is deleted from `.atlas/docs`. Drift says "no drift: docs are
    up to date" and exits 0, and the CI comment says "All docs are in sync". A missing module doc, by contrast, is
    listed as undocumented.
- The low (**A46-02**): a `dir/**/` rule ignores `dir` itself, so every file directly in it is skipped. Git ignores
  only the directories below it.
- Still open: A42-01, A42-02, A42-03 and A39-01, with their recorded messages (re-check table). A39-02 and A39-03
  are also unchanged.

New PLAN row: SG240 (A46-04).

## Re-verified (open findings named in the brief)

| Finding | How | Result |
| --- | --- | --- |
| A42-01 (medium) | `audit-42.test.ts` with `it.fails` → `it` | **Still open.** `expected 'atlas: /tmp/atlas-audit42-…' not to match /move it back/`. Pin (real `/proc/locks` and probe see the holder) passes. |
| A42-02 (low) | same | **Still open.** `stderr "", seen {"stale":0,"docs":0}: expected false to be true`. Pin (every process stopped restores 24 rows and 4 docs) passes. |
| A42-03 (low) | same | **Still open.** 64.4 s, then `atlas: open: database is locked (another process is writing the index; retry when it finishes): expected 1 to be +0`. Pin (no set-aside file, no wait) passes. |
| A39-01 (medium) | `audit-39.test.ts` with `it.fails` → `it` | **Still open.** `expected 'atlas: /tmp/atlas-audit39-…' not to match /does not belong to/`. |
| A39-02, A39-03 (low; not in the brief) | same run | Still open, same messages as AUDIT-42. |
| Earlier soundness files | audit-1/5/9/13/17/21/25/29/33/34/36/39/42 as they are | 13 files, 186/186 pass (2m26s). No regression from SG230. |
| A44-01 (startup offer), A43-02 | read again against this round's paths (serve/MCP startup, `schema_version` read) | No new consequence found. Not re-reported. |

## Critical

None found.

## High

### A46-04 Excerpts are read from disk at the indexed line numbers without checking the file: `atlas_symbol` and `ask` serve other lines as a symbol's source after an unindexed edit

- **Evidence:**
  - **Why.** Three callers rebuild an excerpt the same way: `handleSymbolTool` (`src/mcp/server.ts`), `retrieve`
    (`src/core/qa/retrieve.ts`) for `atlas ask` and `atlas_ask`, and `buildModuleContext`. Each calls
    `readFileFromRoot`, which reads the file as it is now, then slices it at the symbol's indexed
    `start_line`..`end_line`.
    - Nothing compares the text with `files.content_hash`. Drift already does that comparison
      (`indexedContentChanged`, DECISIONS: "hashes each documented file on disk").
    - So once a file is edited and not re-indexed, the excerpt matches neither state. The line numbers come from the
      index and the text comes from the new file.
    - This is the usual MCP case: an editor's agent edits a file, then calls `atlas_symbol` or `atlas_ask` before
      `atlas_index`.
  - **Real run (CLI, sample).** `atlas index`, then 12 comment lines are prepended to `src/math.ts`, then
    `atlas ask --offline --json "What does add do?"`:
    - It exits 0. The answer says "`add` is defined in src/math.ts:4 (see [1])", and citation 1 is
      `src/math.ts` lines 4–6, `symbol: add`.
    - Lines 4–6 are now `// header added after indexing`, and `add` is at line 16.
    - The citation checks say `valid: true`.
    - With a real model, the snippet sent as `[1] function: add (src/math.ts:4-6)` contains no code from `add`.
  - **MCP.** `atlas_symbol {name: "add"}` returns `startLine: 4` and `excerpt: "// header added after
    indexing\n…"` (three comment lines), with `truncated: false` and nothing else in the result.
  - **Docs.** `atlas docs` run before re-indexing builds the module prompt the same way. That prompt mixes indexed
    symbols with shifted source, and its doc is stored. Drift then reports it `unindexed`, and the next re-index plus
    `atlas docs` replaces it. So docs recover, while `atlas_symbol` and `ask` never say anything.
  - **Why high.** The answer is wrong and looks like success: the excerpt is presented as the symbol's source, and
    the citation checks pass. It happens in the main MCP workflow with no fault, race or unusual filesystem. The index
    already has what it needs to notice (`content_hash`, as drift uses).
- **Tests:**
  - `A46-04 atlas_symbol does not return other lines as \`add\`’s source after an edit that was not re-indexed`
    fails with `excerpt "// header added after indexing\n// header added after indexing\n// header added after
    indexing": expected false to be true`.
  - `A46-04 atlas_ask does not ground the model on other lines labelled as \`add\` (or says the file changed)` uses
    an injected client that captures the prompt. It fails with `the snippet labelled add holds the inserted header:
    expected 'Question: What does add do?\n\nGround…' not to match /header added after indexing/`.
  - A plain `it` pins that before the edit the excerpt is `add`'s source, and that after it drift marks the doc
    `unindexed`.
- **Repro (scratchpad):** `excerpt.mts`; or the CLI steps above.
- **Fix:**
  - Read source for excerpts through one helper that hashes what it read and compares it with
    `files.content_hash`.
  - On a mismatch:
    - `atlas_symbol` returns `excerpt: null` with a `stale: true` (or `changedSinceIndex`) flag and a hint to run
      `atlas_index`;
    - `retrieve` leaves out the snippet, or marks it changed, so `ask` reports that the file changed since indexing
      instead of citing it;
    - `buildModuleContext` can keep its behaviour, since drift catches it, but should share the helper.
  - Each surface should say how many files were skipped this way.

## Medium

### A46-01 `.gitignore` and `exclude` rules match case-insensitively: files git keeps are silently not indexed on Linux

- **Evidence:**
  - **Why.** `walker.ts` builds every matcher with `ignore()`. That covers each `.gitignore` set, the merged
    segment-local groups and the config `exclude`/`include`. `ignore` 6.0.2 defaults to `ignorecase: true`. Git
    matches case-sensitively unless `core.ignorecase` is set, and it is unset on Linux, including the
    `ubuntu-latest` runner in `.github/workflows/atlas.yml`.
  - **Effects.** Any pattern that differs from a path only in case drops that path. Character classes lose their
    meaning: `[A-Z]` also matches lower-case letters.
  - **Fuzzing.** 6 of the first 69 random trees skipped files git keeps, all through case:
    - `A.TS` dropped `gen/A.ts`;
    - `/b/` dropped all 8 files under `B/`;
    - `[A-Z].ts` dropped `f.ts`.
  - **Real case (test tree).** The `.gitignore` is `Build/`, `Config.ts`, `[A-Z]*.gen.ts`.
    - Git's untracked, not-ignored set is `src/api.gen.ts`, `src/build/util.ts`, `src/config.ts` and
      `src/main.ts`.
    - `walkRepo` returns only `src/main.ts`, so `atlas index` has no row for the other three.
    - These are ordinary layouts: a capitalised build output folder or local override file in `.gitignore`, beside
      a lower-case source directory or module of the same name.
  - **What the user sees.** Nothing reports an ignored file, so:
    - `index` says nothing;
    - `search` and `atlas_search` never return the symbols;
    - drift never lists them as undocumented;
    - edges to them are weak.
  - **A file that was indexed before.** If a newly added `.gitignore` line matches it only by case, it is pruned,
    and its doc becomes a `missing` stale entry. The user then "fixes" that by regenerating docs without the file.
  - **Related.** This is a different case from A9-06 (tracked files that really match `.gitignore`). Here git does
    not ignore the file at all.
  - **Why medium.** Atlas loses files silently, on the platform CI runs on. It needs a case-variant or
    character-class pattern, as A9-06 needed a force-added file. It is the same severity class.
- **Test:** `A46-01 a file git does not ignore (the pattern differs in case, or uses a character class) is walked
  and indexed`. It fails with `expected [ 'src/main.ts' ] to deeply equal [ 'src/api.gen.ts', …(3) ]`. A plain `it`
  pins agreement with git for same-case patterns, a negation, a root anchor and a nested set.
- **Repro (scratchpad):** `fuzzgi.mts 1 300`.
- **Fix:**
  - Use `ignore({ ignorecase: false })` everywhere in `walker.ts`, including `extendGroups`' merged matcher and
    the `exclude`/`include` sets.
  - Optionally, honour `git config core.ignorecase` when the root is a git checkout.

### A46-03 A missing architecture doc is never reported: drift says "docs are up to date" and CI says "All docs are in sync"

- **Evidence:**
  - **Why.** `detectDrift` checks the architecture doc only `if (!opts.skipArchitecture && archDoc)`. With no
    architecture doc, in the index or in `--docs-dir`, nothing is pushed to `stale` or `undocumented`.
    `hasDrift` stays false. A file with no doc, by contrast, gets an undocumented `module` entry or one per
    exported symbol.
  - **Real run (CLI, sample):**
    1. `atlas index`.
    2. `atlas docs --offline --budget 3300` prints `modules: generated 4 … architecture: cached/skipped`, exits 0,
       and writes no `architecture.md`.
    3. `atlas drift` prints `no drift: docs are up to date and all public symbols documented. totals: files=4
       docs=4` and exits 0.
    4. `atlas docs --show architecture` then exits 1 with `no doc for 'architecture'`.
  - **CI.** With `architecture.md` deleted from the committed `.atlas/docs` in a PR, `drift --json --docs-dir
    .atlas/docs` is clean, and `ci-comment` renders "Drift check: passed. All docs are in sync and every public
    symbol is documented."
  - **Related.** A15-04 recorded that a budget-cut `docs` run does not say so. This is the drift side, which no
    audit covered. Unlike a skipped module, a skipped architecture doc is never listed.
  - **Why medium.** Drift reports a clean state that is not clean, and the only surface that would show the gap
    stays silent. It does not change the exit-2 gate, which a missing module doc does not fail either.
- **Tests:**
  - `A46-03 drift reports the architecture doc when it is missing from the index or from .atlas/docs` fails with
    `hasDrift=false: expected [] to include 'architecture'`.
  - `A46-03 after \`atlas docs\` skips the architecture doc for budget, drift does not say every doc is up to date`
    fails with `expected false to be true`.
  - A plain `it` pins that an architecture doc that no longer matches the index is stale in both modes.
- **Repro (scratchpad):** `arch.mts` (the budget scan); or the CLI steps above.
- **Fix:** when `!skipArchitecture`, files are indexed and there is no architecture doc, report it. Either:
  - an `undocumented` entry `{ file: 'architecture', symbol: 'architecture', kind: 'module' }`, which is
    informational like a missing module doc; or
  - a `stale` entry with `currentHash: 'missing'`, if the doc is meant to be required.

  Either way, `docs` should print `architecture: skipped (token budget exhausted)` rather than `cached/skipped`.

## Low

### A46-02 `dir/**/` ignores `dir` itself

- **Evidence:**
  - Git reads `src/**/` as "every directory below `src`". It keeps `src/main.ts` and ignores `src/nested/`.
  - `ignore` also matches `src/` against it. The walker then does not descend into `src` at all, so every file
    directly in `src/` is skipped with no message.
  - This was the only skip left in 599 fuzzed trees once case-insensitivity was patched out.
  - **Why low.** The pattern is uncommon. Its consequence is the same silent loss as A46-01.
- **Test:** `A46-02 a \`src/**/\` rule leaves the files directly in src/ walked, as git does`. It fails with
  `expected [] to deeply equal [ 'src/main.ts' ]`.
- **Repro (scratchpad):** `fuzzgi2.mts 228 229` (with the patched walker copy).
- **Fix:** in `isIgnored`, for a directory, skip a match whose pattern ends in `/**/`, or `/**` followed by `/`,
  when the tested path is exactly that pattern's prefix. Alternatively, ask `git check-ignore --stdin` in a git
  checkout.

## Notes (no test)

- **Over-inclusion found by the fuzzer.** These are not false negatives, so they are not findings:
  - An escaped glob character (`q\?.ts`) does not ignore `q?.ts`, which git ignores. Atlas indexes a file git
    ignores.
  - An unreadable `.gitignore` (`readGitignore` returns `null`) indexes everything it would have ignored. It also
    drops its own `!` re-includes, a false negative only in that unusual setup.
- **`export = function f() {}` produces no symbol.**
  - `exp1.mts` shows that a TS `export =` of a function or class expression yields no symbol, so drift can never
    list it as undocumented. `function f(){}; export = f` is flagged as exported correctly.
  - The other 31 forms tested, including CJS `module.exports`/`exports.x`, `export { a as b }`, destructured
    exports, namespaces and Python `__all__`/underscore rules, mark exported symbols as exported or over-report
    them. Over-reporting is safe for drift.
  - Left as a note: the form is rare in TypeScript sources.
- **A deleted file restored with the same content.** The deleted file's tombstone stays until the next `atlas docs`.
  In index mode, drift then treats the tombstone as the restored file's doc: the file is fresh and documented, and
  `totals.docs` is 5 against 4 rows. In the CLI flow `.atlas/docs` still holds the exported doc, so `docs --list`
  and `/api/docs` agree. No surface disagrees on the outcome, so this is not a finding.
- **Partial reads while an index runs.** `buildGraphJson` and `detectDrift` read with several statements. Each one
  is its own snapshot, so a concurrent `atlas index` can tear a response between them. Within one process,
  `atlas_drift` can run between an `atlas_index` run's per-file transactions (it yields every 50 ms, SG34). Each
  case I traced turns into a false *positive* (`unindexed` stale or a hash mismatch), not a false negative, so it is
  not reported.
