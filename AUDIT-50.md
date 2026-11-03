# AUDIT-50: soundness (round 15, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `646f6b2` (AUDIT-49 #97 merged; `src/` last
changed by SG240 #94) on `claude/atlas-audit-50`. Date: 2026-11-03.

Question: can Atlas silently lose data, serve wrong results, or report a clean state that isn't clean? This is the
final round. It looks first at what changed since AUDIT-46: SG240's `readIndexedSource`
(`src/core/vector/textForSymbol.ts`) and its callers:
- `handleSymbolTool` (`src/mcp/server.ts`);
- `retrieve` (`src/core/qa/retrieve.ts`) and the note `ask.ts` appends;
- `buildModuleContext` (`src/core/synth/context.ts`);
- `detectDrift` (`src/core/drift/detect.ts`).

The rest of the round went to areas earlier rounds covered least:
- the citation checks `ask` and `atlas_ask` return (`src/core/qa/citations.ts`);
- the embedding step's source reads (`embedAllSymbols`, `makeSourceLoader`);
- snapshot consistency between the reads in `retrieve`;
- the `.atlas/docs` round trip (`exportDocs`/`readPersistedDocs`), graph scoping and the CI comment.

Also re-checked: A46-01, A46-02, A46-03, A48-01..A48-07 and A49-01.

Method:
- **In-process, sample fixture.** I used copies of `fixtures/sample` with the offline LLM or an injected client, and
  the core calls the CLI and MCP make (`indexRepo`, `synthesizeDocs`, `runDrift`, `retrieve`, `ask`, `search`,
  `createMcpContext`, `handleSymbolTool`).
- **Citation forms.** `cite.mts` runs 22 citation forms an LLM writes through `checkCitations`, against two retrieved
  spans.
- **Edit during an index.** `emb.mts` edits `src/math.ts` from `indexRepo`'s `onFile` hook right after the file is
  parsed. That is the window between a file's parse and the embedding step at the end of the run. It then undoes the
  edit, re-indexes, and compares the vectors and a search with a fresh index of the same tree.
- **Torn reads.** A50-02's test wraps `search` (a `vi.mock` pass-through), so a second connection edits and indexes
  between `search`'s symbol read and `retrieve`'s file read. That is what another process (`atlas index`, or an
  `atlas mcp` server's `atlas_index`) can do between those two statements.
- **Symbol-less files.** `barrel.mts` adds a barrel (`export * from …`) and an entry script to the sample, writes
  docs, deletes both files without re-indexing, and runs drift.
- **Regressions.** I ran `audit-46`, `audit-48` and `audit-49` as they are: 29/29 pass, so every recorded `it.fails`
  still fails as recorded.

The scripts are in the session scratchpad under `audit-50/`: `cite.mts`, `emb.mts`, `barrel.mts`.

Repros are in `test/audit/audit-50.test.ts`. Each `it.fails` asserts the correct behaviour. I ran the file with each
`it.fails` as a plain `it`: each failed on the assertion that names its defect (messages below). Plain `it` blocks pin
what was attacked and held. Everything runs in-process. The file passes in 1.6 s.

**Summary: 0 critical, 0 high, 1 medium, 2 low.** One new consequence of the open A48-01 is recorded under it, not
re-filed.
- What holds:
  - **SG240's hash check.** It agrees with the indexer byte for byte. `readIndexedSource` and the indexer both hash
    the `utf8`-decoded text. A file with a BOM, CRLF line ends and invalid UTF-8 bytes reads as unchanged, and its
    excerpt is served. One edited byte reads as changed, and `atlas_symbol` withholds the excerpt.
  - **After an unindexed edit, no caller slices the new text at the indexed lines.** `atlas_symbol` returns
    `excerpt: null`. `retrieve` leaves out every `src/math.ts` snippet and lists the file in `changed`.
    `buildModuleContext` has no snippets, and drift marks the file `unindexed`. Re-indexing restores every excerpt.
  - **Parse failures, upgrades and size limits keep the check sound.** A re-index whose parse fails keeps the old
    rows and the old hash, so the file reads as changed. During an extractor upgrade, a failed file's hash is blanked,
    so it also reads as changed. A file that grows past `maxBytes` is pruned, and its doc becomes a `missing`
    tombstone. Each of these errs towards a false positive.
  - **Ordinary citation forms are checked.** Separate `[n]`, hyphen ranges, and backticked or bolded `file:line` are
    flagged when they fall outside the snippets.
  - **Embeddings after an ordinary edit.** An edit plus its undo, each followed by an incremental re-index, leaves the
    same vectors as a fresh index.
  - **`.atlas/docs` round trip and graph.** No false negative found in the round trip:
    - unparseable front matter, or a target that does not match its path, keeps the doc with an empty hash, so it is
      always stale;
    - CRLF and a BOM are normalised;
    - the module prompt keeps `Content hash` above its truncation point, so any content change moves the doc's hash.

    Graph scoping by `file` or `symbol` returns every owned edge whose endpoints are both in scope.
- The medium (**A50-01**): the citation checks skip a snippet number written `[1][9]` or `[1, 9]`, and they check only
  the first line of a range written with an en dash, an em dash or a spaced hyphen (`src/math.ts:4–60`). `ask --json`
  and `atlas_ask` then return `flagged: []` for a citation outside every snippet.
- The lows:
  - **A50-02**: `retrieve` takes a seed's line numbers from `search`'s read and the file's hash from a later
    `getAllFiles`. If an index commits between the two, the hash matches the new file. `add` is then served as lines
    4–6 of the new text, which are comments: A46-04 again, through a race.
  - **A50-03**: the embedding step reads source without the hash check. A file edited after its parse and before the
    embedding step gets vectors built from the edit at the old lines. If the edit is undone, every later re-index skips
    the file and keeps those vectors, until `index --force`.
- **A48-01, new consequence:** a documented file with no symbols (a barrel, an entry script), deleted and not
  re-indexed, gives the same module prompt as before. Drift reports `hasDrift: false`, "docs are up to date", where
  A48-01 recorded a stale entry with a hash.

No new PLAN rows (no critical or high).

## Re-verified (open findings named in the brief)

| Finding | How | Result |
| --- | --- | --- |
| A48-01 (medium) | `audit-48.test.ts` as is; `barrel.mts`; new `it.fails` here | **Still open, with a new consequence** (see "A48-01: new consequence"). A deleted file with symbols is still stale with a hash (pinned). |
| A48-02..A48-07 | `audit-48.test.ts` as is | Still open; each `it.fails` still fails as recorded. |
| A46-01 (medium) | `audit-46.test.ts` as is | Still open (`ignore()` still case-insensitive in `walker.ts`). |
| A46-02 (low) | same | Still open. |
| A46-03 (medium) | same | Still open: a missing architecture doc is still never reported. |
| A46-04 (high) | same; this round's pins | Fixed by SG240 for the sequential case (pinned here and in `test/mcp`, `test/qa`). A torn read can still produce it (A50-02, low). |
| A49-01 (high, SG270) | read `PLAN.md`; `test/synth`, `test/drift` | SG270 still `todo`. This round's pin covers `buildModuleContext` from `test/audit/`, which does not meet SG270's product-test criterion. |
| A1-18 (low) | read `detect.ts` `mentions` | Still open. It also covers top-level names that are English words (`add`, `run`, `get`): a prose "add" in the doc counts as documenting `add`. It never hides a gate failure, because the edit that adds such a symbol also changes `Content hash` and makes the doc stale. Not re-filed. |

## Critical

None found.

## High

None found.

## Medium

### A50-01 Citation checks skip `[1][9]` and `[1, 9]`, and check only the first line of a dash range

- **Evidence:**
  - **Why.** `CITATION_RE` (`src/core/qa/citations.ts`) matches `[n]` only when it is not preceded by `]` or a word
    character, so the `[9]` in `[1][9]` is skipped. It has no form for a list, so `[1, 9]` and `[1,9]` match nothing.
    A range is `:(\d+)(?:-(\d+))?`, so with an en dash (`4–60`), an em dash (`4—60`) or a spaced hyphen (`4 - 60`) only
    `:4` matches, and it is checked as the one-line range 4–4.
  - **Probe (`cite.mts`, 22 forms, retrieved spans `src/shapes.ts:17-26` and `src/math.ts:4-6`):**

    | Answer | Checks |
    | --- | --- |
    | `See [1][7].` | `[1]` valid; `[7]` not checked |
    | `See [1, 7].`, `[1,7]`, `[7, 1]`, `[1-7]` | none |
    | `add (src/math.ts:4–60)`, `4—60`, `4 - 60` | `src/math.ts:4` valid |
    | `src/math.ts:4, 40` | `src/math.ts:4` valid; 40 not checked |
    | `src/math.ts:L40`, `src/math.ts#L40` | none |

    Separate refs, `[1]–[7]`, `([7])`, `` `[7]` ``, `**src/math.ts:40**` and hyphen ranges are all checked correctly.
  - **What the user sees.** The checks are the guard the tool advertises. The `atlas_ask` description says "checks
    flagging citations outside them". `atlas ask` prints a "flagged" block only when `flagged` is non-empty. With
    the answer `add sums two numbers [1][9].` and five snippets, `ask` returns `flagged: []`. `ask --json` and
    `atlas_ask` report every citation valid, and the CLI prints no warning.
  - **Why medium.** These are common LLM citation styles. `[1][2]` and `[1, 2]` are among the most frequent ways a
    model cites several sources, and en-dash ranges are typographic defaults. The result is a clean grounding report
    for a citation that points at no snippet, or past the end of one. It is not high, because the citation list is
    printed next to the answer, so a careful reader can still see there is no `[9]`.
- **Tests:**
  - `A50-01 a snippet number cited as \`[1][9]\` or \`[1, 9]\` (no snippet 9) is flagged` fails with
    `add sums two numbers [1][9].: expected '' to match /9/`.
  - `A50-01 a range written with an en dash, em dash or spaced hyphen is checked whole` fails with
    `src/math.ts:4–60: expected [ [ 'src/math.ts:4', true ] ] to not deep equally contain [ 'src/math.ts:4', true ]`.
  - A plain `it` pins that `[9]`, `` `src/math.ts:4-60` `` and `**src/math.ts:40**` are flagged.
- **Repro (scratchpad):** `cite.mts`.
- **Fix:**
  - In `CITATION_RE`, accept `]` before `[n]` (keep skipping `\w]`, as in `arr[1][2]`, by checking the character
    before the first bracket of the run).
  - Parse `[n(, m)*]` and `[n-m]` as one check per index.
  - Accept `[-–—]` with optional spaces between range bounds, and `:L\d+` / `#L\d+`.
  - Flag a `file:line, line` list per line.

## Low

### A50-02 `retrieve` checks a newer file against a seed's older line numbers when an index commits between its reads

- **Evidence:**
  - **Why.** `retrieve` first awaits `search`, which reads the seed symbol rows (`loadSymbolsByIds`). It then reads
    `getAllFiles` and `getAllSymbols` in separate statements, with no read transaction around them.
    `add(hit.symbol, …)` slices with the line numbers from `search`'s read. `readIndexedSource` compares the file on
    disk with the `content_hash` from the later read.
  - **The race.** If another connection edits and indexes between the two reads, the hash matches the new file, and
    the old `start_line`..`end_line` slice other lines. The file is not listed as changed, and `ask` adds no note.
  - **Test run.** The second connection prepends 12 lines to `src/math.ts` and indexes. `retrieve(…, 'add')` returns
    the `add` snippet as lines 4–6, and those lines are `// header added after indexing`.
  - **Order matters.** `handleSymbolTool` reads files before symbols. A tear there gives an old hash against new
    text, which withholds the excerpt (a false positive), so only `retrieve` has the bad order.
  - **Why low.** It needs a commit from another process inside a window of a few statements. In one process, an
    in-process `atlas_index` yields on macrotasks and cannot run in `retrieve`'s microtask gap. AUDIT-46's note on torn
    reads found only false positives; this is the one false negative.
- **Test:** `A50-02 an index committed between \`search\` and \`retrieve\`’s file read does not label other lines as
  \`add\`` fails with `lines 4-6: expected '// header added after indexing\n// he…' to contain 'return a + b'`. A plain
  `it` pins the untorn case.
- **Fix:** read `getAllFiles`/`getAllSymbols` and then rebuild seeds from `symbolById` (same snapshot as `fileById`),
  dropping a hit whose id is gone. Better, run `search` and those reads in one read transaction.

### A50-03 The embedding step reads source without the hash check: an edit made during an index, then undone, leaves vectors that a re-index never fixes

- **Evidence:**
  - **Why.** `embedAllSymbols` builds each symbol's text with `makeSourceLoader`, which reads the file as it is now.
    It runs at the end of `indexRepo`, after every file is parsed and the graph is resolved. That is the last reader
    without SG240's check.
  - **Wrong vectors.** A file edited after its parse and before this step gets vectors built from the new text at the
    old line numbers.
  - **Why they persist.** If the edit is undone (an editor undo, `git stash`, a branch switch and back), the content
    matches the stored hash again. Every later `atlas index` skips the file and never re-embeds it.
  - **Probe (`emb.mts`).** The edit inserts 12 comment lines and `export function vortex() { return quantum; }`, and
    is then undone. The re-index reports `indexed 0, skipped 4, embeddings 0`.
    - `search("vortex quantum")` returns `multiply` with semantic score 0.216. A fresh index of the same tree scores
      no symbol above 0.
    - The vectors of `add`, `multiply` and `PI` differ from a fresh index's.
  - **Why low.** The vectors only change ranking: names, lines and excerpts come from the index and stay checked. It
    needs an edit inside the run plus an undo before the next run. Without the undo, the next index re-parses the
    file and re-embeds it.
- **Test:** `A50-03 a file edited after its parse and before the embedding step (then undone) does not keep vectors
  built from the edit` fails with `expected [ 'src/math.ts:PI', …(2) ] to deeply equal []`. A plain `it` pins that an
  edit and its undo, each re-indexed, match a fresh index.
- **Repro (scratchpad):** `emb.mts`.
- **Fix:** have `makeSourceLoader` use `readIndexedSource`. On `changed`, embed without the source slice (name,
  signature and docstring only) and blank that file's `content_hash`, so the next run re-parses and re-embeds it.
  Alternatively, embed each file from the content its parse read.

## A48-01: new consequence (not re-filed)

- **Evidence:** A48-01 (medium, open) recorded that a file deleted or unreadable since indexing is still reported, but
  with a hash rather than `missing`/`unindexed`. The cause is that `readIndexedSource` returns `changed: false` when
  the read fails, so drift rebuilds the module prompt without snippets.
  - For a file with no non-module symbols, the prompt never had snippets. It holds the indexed `Content hash` and the
    neighbourhood, which are both unchanged, so its hash equals the stored doc's.
  - **Probe (`barrel.mts`).** The sample plus `src/index.ts` (`export * from './math'; export * from './shapes';`) and
    `src/main.ts` (`import { add } …; console.log(add(1, 2));`), with docs. Both files are deleted and not re-indexed.
    `runDrift` returns `hasDrift: false` (`totals: files=6 docs=7 stale=0`), and the CLI says "no drift: docs are up
    to date". Deleting `src/app.ts`, which has symbols, is still reported stale.
  - **Scope.** It is local or MCP only (`atlas drift`, `atlas_drift` before `atlas_index`). In CI the index is fresh,
    so the doc's file is pruned and reported `missing`.
- **Test:** `A48-01 deleting documented files with no symbols (a barrel, an entry script) is drift, not "docs are up
  to date"` fails with `{"files":6,"docs":7,"publicSymbols":19,"stale":0,"undocumented":0}: expected false to be
  true`. A plain `it` pins the with-symbols case.
- **Fix:** A48-01's fix covers it. `readIndexedSource` should report an unreadable file as `missing` (or `changed`),
  and drift should mark it stale before building a prompt.

## Notes (no test)

- **An edit that changes only invalid UTF-8 bytes is invisible.** Both the indexer and `readIndexedSource` hash the
  decoded text. Swapping one invalid byte for another decodes to the same U+FFFD text, so the file is "unchanged"
  everywhere. The decoded text, and so every symbol, line and excerpt, is identical, so nothing served is wrong.
- **`retrieve` drops a changed seed's graph neighbours too.** The seed snippet is left out before expansion, so its
  callers and callees in unchanged files are not added either. The note names the changed file, and nothing wrong
  is served. This is a recall loss only.
- **Basename citations.** `math.ts:4` is valid if any retrieved `…/math.ts` covers line 4, even when the model meant
  another `math.ts`. It is ambiguous rather than wrong, and the full path is always available to the model.
