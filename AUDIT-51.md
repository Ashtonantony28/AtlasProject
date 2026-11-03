# AUDIT-51: performance under load (round 15)

Auditor: a fresh subagent that wrote none of the audited code. Base: `646f6b2` (AUDIT-49, #97), worktree `atlas-audit-51`. The only `src/` change since AUDIT-47 is SG240 (`9f3b7fc`, #94): `git diff 10cccef eba7861 -- src` and `git diff 9f3b7fc 646f6b2 -- src` are both empty, so AUDIT-47 measured the pre-SG240 code. SG240 added `readIndexedSource` (`src/core/vector/textForSymbol.ts:87`), which reads a file and SHA-256-hashes it against `files.content_hash` for `atlas_symbol` (`handleSymbolTool`), `ask`/`atlas_ask` (`retrieve`), `buildModuleContext` (`atlas docs`, and drift through `modulePrompt`) and drift's own unindexed check. This round measures that cost: repeated hashing of one file within a run, large files, many concurrent `atlas_symbol`/`atlas_ask` calls, and docs and drift on 10k files.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22, ext4 at 73–75% full, CPU with SHA-NI. Another auditor (AUDIT-50) worked in a sibling worktree: the 1-minute load average was **1.1–9.1** (given with each run). Builds were interleaved run by run; the page cache was warm.

| Build | What it is |
| --- | --- |
| current | `646f6b2` (`npm run build`) |
| `eba7861` | The AUDIT-46 commit, the last base commit before SG240, extracted with `git archive` into the scratchpad and built. Its `src/` differs from current only in SG240's seven files (`detect.ts`, `ask.ts`, `retrieve.ts`, `context.ts`, `vector/index.ts`, `textForSymbol.ts`, `mcp/server.ts`). |

## Workloads

| Name | Source | Files | Symbols | Edges | `index.db` |
| --- | --- | --- | --- | --- | --- |
| realistic 10k | `scripts/audit-repo.mjs <dir> 10500`, indexed by current (55 s), docs by `atlas docs --offline --budget 1000000000` (9 s) | 11,026 | 160,393 | 242,111 | 361 MB |
| large files | `genbig.mjs`: one 7.2 MB `src/generated.ts` (40,000 functions) and 60 modules of 0.72 MB (4,001 functions each, each with an `init`), `maxFileBytes` 64 MiB, docs as above | 61 | 280,121 | 0 | |

Both builds read the same index (SG240 changed no schema). `tokenBudget` was raised to 1e9 for the concurrent `atlas_ask` runs: at the default 200,000, 16 parallel calls are refused by the A17-02 reservation (`200000 tokens reserved by calls in progress`) on both builds, as designed.

## What SG240 hashes (`bench.mjs`: in-process, `fs.readFileSync` and `crypto.createHash` counted through `syncBuiltinESMExports`)

| Path (workload) | Reads (MB) | Source hashed: current / `eba7861` | Per file |
| --- | --- | --- | --- |
| `detectDrift` (realistic 10k) | 22,052 (67.7 MB) | **67.7 / 33.8 MB** | read twice, hashed **twice** (once before) |
| `detectDrift` (large files) | 122 (101.6 MB) | **101.6 / 50.8 MB** | read twice, hashed twice (once before) |
| cached `synthesizeDocs` (realistic 10k) | 11,026 (33.8 MB) | 33.8 / 0 MB | once / once |
| cached `synthesizeDocs` (large files) | 61 (50.8 MB) | 50.8 / 0 MB | once / once |
| `ask` default k 5 (realistic 10k) | 5 (0.02 MB) | 0.02 / 0 MB | once per distinct file |
| `ask` k 20, expand 20, question landing in `generated.ts` | 8 (12.3 MB) | 12.3 / 0 MB | once per distinct file (9 snippets from one file) |
| `atlas_symbol {name: init, limit: 100}` (large files) | 60 (43.6 MB) | 43.6 / 0 MB | once per matched file per call |

- No path hashes a file more than once per run except drift, which hashes every documented, unchanged file twice: `detectDrift` calls `readIndexedSource` for the unindexed check (`detect.ts:98`) and then `modulePrompt` → `buildModuleContext` reads and hashes the same file again (`context.ts:146`). Before SG240 the second read was unhashed. That is A51-01.
- SHA-256 over this host's string sources runs at 0.7–0.8 GB/s (with UTF-8 encoding): hashing all 11,026 realistic sources (33.8 MB) takes **41 ms** (best of 5), the 7.2 MB module about 10 ms, and a 9.8 MB non-ASCII string 13–20 ms against 27–35 ms to read it.

## Timings, builds interleaved (in-process `bench.mjs`, ms)

| Run (load) | current | `eba7861` |
| --- | --- | --- |
| `detectDrift`, realistic 10k (2.3–4.0) | 5,231–5,899 | 5,208–6,738 |
| cached `synthesizeDocs`, realistic 10k (2.2–3.9) | 3,678–3,767 | 3,644–3,959 |
| `ask` k 5, realistic 10k (3.6) | 1,181–1,466 | 1,277–1,299 |
| `detectDrift`, large files, steady state (1.3–1.6) | 3,867–4,577 (first run 7,801) | 3,816–4,420 (first 7,369) |
| cached `synthesizeDocs`, large files (1.3–1.6) | 985–1,186 | 936–1,069 |
| `ask` k 5, large files (1.4–1.7) | 1,204–1,862 | 1,228–1,837 |
| `ask` k 20, expand 20, large files (1.1–1.9) | 1,160–1,886 | 1,249–2,109 |
| `atlas_symbol {init, limit 100}`, large files (1.4–1.7) | 1,210–1,571 | 1,074–1,412 |
| **32 concurrent `atlas_symbol {init, limit 100}`**, large files (2.2–5.3) | **39,278–41,568**, 1.39 GB hashed, HWM 709–716 MB | **38,443–41,458**, HWM 703–708 MB |
| **16 concurrent `atlas_ask` k 20**, realistic 10k (1.6–2.3) | **17,460–18,167**, HWM 780–785 MB | **17,314–18,294**, HWM 697–700 MB |
| **16 concurrent `atlas_ask` k 20**, large files (1.9–4.4) | **24,321–24,766**, 156 MB hashed, HWM 1,242–1,243 MB | **25,331–25,357**, HWM 823–1,242 MB |

CLI, realistic 10k (`atlas drift`; `atlas docs --offline --budget 1000000000` on a fully cached index):

| Run (load) | current | `eba7861` |
| --- | --- | --- |
| `atlas drift`, 6 rounds (5.2–9.0) | 8.29, 8.59, 9.44, 10.27, 10.67, 10.92 s | 8.55, 8.99, 9.12, 9.54, 9.64, 10.19 s |
| `atlas docs --offline`, cached, 2 rounds (8.3–9.1) | 5.26, 6.07 s | 5.98, 4.37 s |

- Every pair is within noise. The extra drift hash is 41 ms of a 5–11 s run at realistic 10k (under 1%), and about 60 ms of 3.9–4.6 s on the large-file repo. Cached docs add one hash per file (the same 41 ms). `ask` hashes only the few files it excerpts. `atlas_symbol` hashes each matched file once per call: 43.6 MB per call at `limit 100` over 0.72 MB files, about 60 ms of 1.2–1.6 s, which is dominated by A2-08 (it reads every symbol and file row).
- Concurrency: the MCP handlers are synchronous apart from `search`'s and the LLM's awaits, so N calls cost N × one call on both builds (32 × `atlas_symbol` 38–42 s; 16 × `atlas_ask` 17–18 s at realistic 10k, 24–25 s on the large-file repo). No call failed. Peak RSS differs between runs of the same build (823 against 1,242 MB for `eba7861` on the large files): it follows how many in-flight asks hold `getAllSymbols`/`getAllEdges` at once (A2-08), not SG240, which keeps no source past a run.
- Large files: with `maxFileBytes` at 64 MiB, a 7.2 MB module is read, hashed and split per run. The hash is 10 ms of it. The split is repeated per snippet (A51-02); it was before SG240 too.

## Findings

Counts: **Critical 0, High 0, Medium 0, Low 2** (new). No SG rows. SG240's hash costs under 1% on every path measured, on 10k files, 7 MB files and 16–32 concurrent MCP calls, and it is cached per file within an `ask`, an `atlas_symbol` call and a docs run (pinned). Every `test:perf` budget holds (below).

### Low

#### A51-01: drift reads and hashes every documented file twice, once for the unindexed check and once inside `modulePrompt`

- **Evidence:**
  - Realistic 10k (11,026 documented files): `detectDrift` makes 22,052 reads (67.7 MB) and hashes 67.7 MB of source, against 33.8 MB before SG240. The extra pass costs about 41 ms (SHA-256 over all 11,026 sources), under 1% of a 5.2–6.7 s in-process run and inside the CLI's 8.3–10.9 s noise.
  - Large-file repo: 122 reads (101.6 MB) and 101.6 MB hashed, against 50.8 MB, per run.
  - `atlas_drift` re-runs the whole drift per page (A6-03), so each page pays both passes again.
  - `test/audit/audit-51.test.ts` A51-01 (`it.fails`): `detectDrift` reads and hashes each unchanged, documented file once. Today each is read twice and hashed twice (pinned by the precondition test).
- **Repro:** `node <a51>/scripts/bench.mjs $PWD/dist <r10k> drift 2` (and `<a51>/pre/dist`) · `npx vitest run test/audit/audit-51.test.ts`
- **Cause:** `src/core/drift/detect.ts:98` calls `readIndexedSource(opts.root, file)` and discards the source; when the file is unchanged, `:100` calls `modulePrompt(db, opts.root, file)`, whose `buildModuleContext` (`src/core/synth/context.ts:146`) calls `readIndexedSource` again. Before SG240 the first call was `indexedContentChanged` and the second an unhashed `readFileFromRoot`, so the reads were already doubled.
- **Fix:** read once: let `buildModuleContext`/`modulePrompt` take an optional already-checked source (or a per-run `readIndexedSource` cache keyed by file id), and pass drift's read through.
- **Severity:** Low. It doubles a cost that is under 1% of the run; drift's time is the `mentions` regexes and the per-file queries (AUDIT-47).

#### A51-02: `retrieve` splits the whole source file once per snippet, so `ask` on a large module splits it up to 40 times

- **Evidence:**
  - Large-file repo, `retrieveForQuery(…, 'ledger account total', {seedLimit: 5})`: 5 snippets from the 7.2 MB `generated.ts`, 5 full splits (36.1 MB), 51–52 ms. At `seedLimit 20, expansionLimit 20`: 20 splits of files over 100 KB (73.1 MB), **138–157 ms** of a 1.9 s run, on both builds. `k` and `expand` are capped at 20 each, so the bound is 40 splits of one file per question.
  - At the default `maxFileBytes` (1 MiB) the worst case is about 40 × 8 ms.
  - The source string and the hash are cached per file (`fileSourceCache`), but the lines are not: AUDIT-18's A18-01 shape (`sliceLines` split per symbol), fixed for embedding by SG55, on the ask path.
  - `test/audit/audit-51.test.ts` A51-02 (`it.fails`): `retrieveForQuery` with `k 20, expand 20` splits `src/gen.ts` at most once. Today it splits it 20 times, once per snippet (pinned).
- **Repro:** `node <a51>/scripts/splits.mjs $PWD/dist <big> 'ledger account total' 20` · `npx vitest run test/audit/audit-51.test.ts`
- **Cause:** `src/core/qa/retrieve.ts:95`: `add` runs `source.split('\n')` for each symbol it adds, although `sourceFor` caches `source` per file.
- **Fix:** cache the split lines (or line offsets) per file id next to `fileSourceCache`, as `handleSymbolTool` already does (`sources: Map<number, string[] | null>`).
- **Severity:** Low. It needs a module of several MB (above the default `maxFileBytes`) to reach 100 ms, and it is under 10% of the ask there; it predates SG240.

### Open from AUDIT-47, AUDIT-43, AUDIT-40, AUDIT-35, AUDIT-22, AUDIT-18 and earlier

`npx vitest run test/audit/audit-47.test.ts test/audit/audit-43.test.ts test/audit/audit-40.test.ts test/audit/audit-35.test.ts test/audit/audit-22.test.ts test/audit/audit-18.test.ts`: 6 files, 38 tests pass (every `it.fails` still fails as expected), 10.1 s at load 5–8. None of their code changed since they were filed, so none was re-timed except as below.

| ID | Last measured | Now | Status |
| --- | --- | --- | --- |
| A47-01 `atlas graph` one string | 3.5M edges: `Invalid string length` after 38 s | `it.fails` stands; `graphCmd.ts` unchanged | Open (Medium), unchanged |
| A47-02 search pool `8 × limit` | limit 100 p95 48.8–54.3 ms at 10k symbols | `it.fails` stands; `search.ts` unchanged | Open (Low), unchanged |
| A43-01, A43-02, A40-01, A40-02, A35-01..03 (leftover WAL) | AUDIT-47 | `it.fails` stand; `database.ts` unchanged | Open, unchanged |
| A22-01..05 | AUDIT-47 | `it.fails` stand; realistic 10k fresh index 54.9 s (current only, load 3.7) | Open, unchanged |
| A6-03 `atlas_drift` re-runs drift per page | 7.5–11 s per page | each page now also pays A51-01's second hash (+41 ms at realistic 10k) | Open, not worsened beyond A51-01 |
| A2-08 `atlas_symbol`/`ask` read every symbol (and edge) row | `atlas_symbol` 727–937 ms | 1.07–1.57 s per call on 280k symbols; 16 concurrent asks peak at 0.7–1.2 GB | Open, unchanged |

## No finding

- **`atlas_symbol`:** one read, one hash and one split per matched file per call, whatever the number of matches in it (pinned at 50 matches in one file). 32 concurrent calls are 32 × one call (pinned at 8).
- **`ask`/`atlas_ask`:** one read and one hash per distinct excerpted file per question, whatever the snippet count (pinned at 20+ snippets from one file). The hash is 0.02 MB per default question at realistic 10k.
- **Docs:** a cached run reads and hashes each file once (pinned), the same 41 ms at realistic 10k.
- **Large files:** hashing is linear in bytes at 0.7–0.8 GB/s, below the read itself; no path re-hashes within a run except A51-01.

## Budgets (`npm run test:perf`, load 7.6)

5 files, 9 tests pass in 17.7 s: search p95 **21.89 ms** at 10,206 symbols (≤ 50 ms), cached synthesis **159 ms** and drift **409 ms** at 1,002 files (≤ 1 s each), parse+insert **3.30 ms**/file (≤ 5), no-op re-index **10.5 ms**/100 files (≤ 100), resolver **560 ms**/1k files and **71 ms**/1k on the Python monorepo (≤ 2 s), walks 150 and 210 µs/file (≤ 1 ms).

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a51>` is `<scratch>/audit-51`. The scripts were in `<a51>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first).
- `bench.mjs <dist> <root> <drift|docs|ask|symbol|symconc|askconc> [reps] [json]`: in-process runs, counting `readFileSync` of repo files and every `createHash().update` (via `syncBuiltinESMExports`), with time, load and `maxRSS`. `symconc`/`askconc` start `n` `handleSymbolTool`/`handleAskTool` calls at once on one `createMcpContext({offline: true})`.
- `splits.mjs <dist> <root> <question> <k>`: `retrieveForQuery` with `String.prototype.split` counted on strings over 100 KB.
- `genbig.mjs <dir> <bigFns> <files> <fnsPerFile>`: the large-file repo.
- CLI runs were timed with `date` around `node <dist>/cli/index.js`.
- The two repos, their indexes and the `eba7861` build were deleted afterwards; no process was left running.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-51.test.ts` | One indexed, documented repo (a 60-function `src/gen.ts` and 6 callers). A51-01 (`it.fails`): `detectDrift` reads and hashes each documented file once; today 2 and 2 (precondition pinned). A51-02 (`it.fails`): `retrieveForQuery` at `k 20, expand 20` splits `src/gen.ts` at most once; today once per snippet, 20 (pinned). Plain tests: `ask` reads and hashes `src/gen.ts` once for 20+ snippets; `atlas_symbol` reads, hashes and splits it once for 50 matches; 8 concurrent `atlas_symbol` calls make 8 reads and 8 hashes; a cached docs run reads and hashes each file once. It counts reads, SHA-256 passes over a file's exact source and splits of it (`fs.readFileSync`, `crypto.createHash`, `String.prototype.split`, restored afterwards) and times nothing. About 0.2 s. Each `it.fails` was confirmed to fail as a plain `it` on its defect assertion (`expected 2 to be 1`, `expected 20 to be 1`). |

## Verification

`npx vitest run test/audit/audit-51.test.ts && npm run test:perf && npm run typecheck && npm run lint` passes (rc 0) in **29.1 s** in all at load 5.0–5.1, first try. `audit-51`: 8 tests pass. `test:perf`: 5 files and 9 tests pass, with search p95 12.44 ms at 10,206 symbols, cached synthesis 126 ms and drift 269 ms at 1,002 files, parse+insert 3.00 ms per file, no-op re-index 8.9 ms per 100 files, and resolver 378 ms per 1k files (45 ms on the Python monorepo).
