# AUDIT-21: soundness (round 6, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `121fffa` (SG55 merged, after SG45 and SG50) on
`claude/atlas-audit-21`. Date: 2026-10-22.

Question: can Atlas silently miss something it claims to capture, or show something stale or wrong as current? Scope:
the fixes merged since AUDIT-17 and the mediums that are still open:
- SG50: `carryEdges` re-points a re-parsed file's edges, and MCP LLM calls reserve their maximum;
- SG45: migrations under `BEGIN IMMEDIATE`, extractor-version stamps on runs, and the `writers` logic;
- SG55: the `sliceLines` split cache;
- open mediums: A17-01, A17-04, A17-05 and A13-04..A13-06.

Method:
- **Oracles on real repos.** I used the read-only clones in the scratchpad (got, trpc, express, flask, attrs). For each
  repo I copied the tree, indexed it, then edited it. A reader polled the edges at every event-loop turn of the
  incremental run. I compared three graphs:
  - the **window** graph (the last one the reader saw before the run ended, which is the carried graph after the
    parse loop) against the graph from before the edit;
  - the **final** graph against a fresh `--force` index of the same tree;
  - both using labels `path::kind:qname#k`, where `k` counts same-key occurrences from the end. This is the
    occurrence that the resolver binds, because `byQName` is last-wins.

  I used two kinds of edit:
  - **edit**: 25 files per run, 2 seeds per repo. Each edit renames a function, prepends a new function or deletes
    the last one.
  - **dup**: in every file that has a duplicated top-level key (TS overloads, Python `@overload` and redefinitions),
    add or remove the first occurrence.
- **Tree-sitter output** for overloads and redefinitions (`parseSource`): every TS overload signature, every class
  method overload and every Python or JS redefinition is its own symbol with the same kind and qualified name.
- **Process-level migration races.** In 12 trials, 6 processes opened a fresh DB at the same instant. In another
  12 trials, 6 processes opened a DB left at schema v3 with rows in it.
- **In-process attacks** (`test/audit/audit-21.test.ts`):
  - MCP `atlas_ask` calls with a client billed for its whole estimate plus `max_tokens`, with a failure in flight
    and a `tokenBudget` lowered mid-call;
  - hand-written `runs` rows for every mix of finished, stamped, unstamped and older-stamped runs;
  - `buildSymbolText` against a naive split per call.

Repros are in `test/audit/audit-21.test.ts`. Each `it.fails` asserts the correct behaviour. I ran each one once as a
plain `it`, and each failed on the assertion that names its defect (messages below). Plain `it` blocks pin what was
attacked and held.

**Summary: 0 critical, 0 high, 1 medium, 1 low.**
- SG45, SG50's reservations and SG55 hold.
- SG50's carry is exact when no name in the file is declared twice: 0 dropped and 0 wrong edges over 10 runs of 25
  edited files. Every final graph equals a fresh index, on all 5 repos, in both edit modes.
- The medium: the carry pairs duplicate declarations from the first occurrence, but the resolver binds the last
  one. When the number of overloads or redefinitions changes, a reader mid-run sees that name's callers dropped, or
  pointed at a bodiless overload signature (A21-01).
- The low: SG45 ignores an unstamped interrupted run that follows a finished run, so a downgrade that was
  interrupted leaves rows from the older extractor in place for good (A21-02).
- A17-01, A17-04, A17-05 and A13-04..A13-06 are still open. Their `it.fails` still fail at `121fffa`.

No PLAN rows: there are no critical or high findings.

## Re-verified (fixes since AUDIT-17)

| Fix | Attack | Result |
| --- | --- | --- |
| SG50 carry (no duplicate names) | renames, prepended functions, deleted functions, reorders, class methods, Python and TS. 25 files × 2 seeds on got, trpc, express, flask and attrs. | Window: every old edge whose endpoints still exist was kept (got 932/1038, flask 891/603, attrs 1663/1748, express 151/285, trpc 823/338 surviving edges touching changed files), with 0 dropped, 0 new edges and 0 lost between unchanged files. Final graph = fresh `--force` index in 10/10 runs. Pinned. |
| SG50 stale edges after resolve | the dup edits above, plus the in-test scenarios | `resolveGraph` clears and rebuilds every edge whenever a file was parsed, so no carried edge outlives a finished run. Final = fresh in every dup run too (got, trpc, flask, attrs). An interrupted run leaves the carried graph until the next run, which re-resolves (`previous run interrupted` or `files changed`). |
| SG50 module symbol kept | re-parse a file and compare with a fresh index | The kept `<module>` keeps its id and its import edges. No parser emits `module`: a TS `namespace` is a `variable`. So no duplicate module symbol appears. |
| SG50 reservations | a call that throws in flight; parallel calls; `tokenBudget` lowered from 40k to 10k while two calls are in flight; refusal after settling | A failed call releases its hold and charges 0, and the next call gets the full 16000 (pinned). Calls admitted under 40k settle onto the new 10k budget. The new call is refused with the reservation message, later calls are refused, and total spend never exceeds what was admitted (pinned). No path records less than the client reports. A cancelled MCP request still settles, because the handler ignores the abort and runs to the end. |
| SG45 migrations | 6 processes × 12 trials on a fresh DB; 6 × 12 upgrading from schema v3 | 144 opens, all at `MAX(version) = 5` with 5 rows, and no `UNIQUE` or duplicate-column error. |
| SG45 `writers` | older stamp after a finished run; older stamp and current stamp with no finished run; unstamped alone; current stamp alone | Upgrade from v−1, upgrade from v−1, upgrade from `null`, and no upgrade (`previous run interrupted`), as intended (pinned). The exception is A21-02. |
| SG55 `sliceLines` | the same content under two paths (an equal string held in another object); alternating sources; an edit; equal-length sources with different content; identical files under two paths in a real embed run | The cache compares by string value, so a hit is always the same text. Every slice equals a fresh split per call, and every embedding text equals the naive reference (pinned). |

## Critical

None found.

## High

None found.

## Medium

### A21-01 Mid-run, the edges of a name declared more than once go to the wrong occurrence or are dropped (SG50)

- **Evidence:** `carryEdges` pairs old and new symbols by `kind + qualified_name`, in id order from the first
  occurrence (`fresh.get(key)?.shift()`). The resolver binds a duplicated name to its **last** occurrence
  (`byQName.set`, last wins), so the old edges sit on the last old occurrence. When the count of occurrences changes,
  the pairing shifts:
  - **TS overloads.** Add a signature on top of
    `f(a: string); f(a: any) { helper() }`. Mid-run, `u -calls-> f` and `f -calls-> helper` sit on the bodiless
    `f(a: string)` signature (line 2) instead of the implementation (line 3).
  - **Python redefinition or `@overload` stub removed.** `f` exists before and after the edit, but every edge
    touching it is gone mid-run: the caller `u -calls-> f`, the importer's `imports`, and `f`'s own calls.
  - **Real repos, dup edits.** flask: 19 surviving edges dropped and 9 re-pointed. For example, every caller of
    `helpers.stream_with_context`, plus `__init__`/`templating` imports, moved to its `@overload` stub, and the
    callers and calls of `cli.locate_app` were dropped. attrs: 44 dropped and 3 re-pointed. got: 2 dropped. trpc: 4
    dropped and 2 re-pointed.
  - **Exposure.** got has 52 duplicated keys (105 edges), attrs 23, flask 16 and trpc 12; express has none.
  - **Who sees it.** The window lasts from the parse loop to the end of `resolveGraph`. During it, `atlas_graph`
    and `atlas_ask` expansion (which may cite the stub's lines) and `atlas_drift` neighbourhoods read this graph. So
    does any other process (`atlas serve`, a CLI `drift`). After a killed run it persists until the next index.
  - **Final graph.** The final graph is always right (= fresh), so this is a mid-run defect only. It narrows A17-03
    (fixed) rather than reopening it.
- **Tests:** two `A21-01 …` tests.
  - As plain `it`, the TS one fails with
    `expected [ …(3) ] to include 'use.ts::u@2 -calls-> lib.ts::f@3'`.
  - The Python one fails with `expected [] to deeply equal ArrayContaining{…}`: the whole graph is empty mid-run.
- **Repro:** index `lib.ts` = `export function f(a: string): void;\nexport function f(a: any): void { helper(); }\nfunction helper() {}`
  and a `use.ts` that calls `f`. Prepend `export function f(a: boolean): void;`, re-index, and read the edges at the
  yield after the parse loop.
- **Cause and fix:** `src/core/ingest/indexer.ts:209-212`. Pair occurrences from the end (`pop()` on both lists,
  which matches the resolver for the edges it made), or carry only keys whose count is unchanged and drop the rest.

## Low

### A21-02 An unstamped run interrupted after a finished run is ignored, so its older-extractor rows are never re-parsed (SG45)

- **Evidence:** `writers` drops `null` stamps whenever any run has finished (`indexer.ts:251-254`).
  - **The case that breaks.** An older `atlas` without stamps (pre-SG45, for example the v2 extractor from SG26–SG30)
    runs on an index that the current version finished. It sees a "downgrade", re-parses files with its own extractor
    and is killed. The next current run sees `writers = [3]`, so there is no upgrade. The files that the older run
    re-parsed have unchanged hashes and are skipped, so they keep v2 rows: here, no destructured `p`/`q` symbols.
  - **Why it is permanent.** After this run finishes, the unfinished run is no longer "after the last finished one",
    so the rows stay. The resolve still runs (`previous run interrupted`), so the graph is consistent with the stale
    rows.
  - **Stamped case is fine.** The same sequence with a stamped older run upgrades correctly (pinned).
  - **Likelihood.** Two installed versions on one index (global vs `npx`, or a CI pin), plus a kill.
- **Test:** `A21-02 …` → `expected [] to deeply equal [ 'p', 'q' ]`.
- **Fix:** count a `null` stamp as an unknown writer even after a finished run. The cost is one full re-parse for an
  index whose last pre-SG45 run was interrupted, which is cheap and safe.

## Notes (no test)

- **Budget lowered mid-call.** Calls admitted under the old cap settle onto the new one, so `spent` can end above the
  lowered cap by what was in flight. Later calls are refused (pinned). I treat this as intended: the tokens were
  committed before the edit.
- **Estimate (A13-12/A15-06, still open).** Reservations hold the prompt *estimate* (3 chars/token). With N parallel
  calls, the overrun bound becomes N × one prompt's estimate error.
- **Unstamped first run.** `startRun` and its stamp are two statements. A kill between them leaves an unstamped run;
  with no finished run, the next run reports `extractorUpgrade.from: null` and re-parses everything. This is safe but
  unnecessary.
- **Cache retention.** The `sliceLines` cache is module state: it keeps the last embedded file's source and line
  array alive after the run. This is a memory note, not soundness.
- **Embed reads the disk.** Embedding text is still read from disk in the embed phase (A17-06). SG55's yields do not
  widen this window in-process, because no writer can run between batches: runs queue.
- **Still open.** A17-01, A17-04, A17-05, A13-04, A13-05 and A13-06 (and the lows A13-07..A13-12) are open. Their
  `it.fails` in `test/audit/audit-17.test.ts` and `test/audit/audit-13.test.ts` still fail.
