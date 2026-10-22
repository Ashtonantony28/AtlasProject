# AUDIT-14: performance under load (round 4)

Auditor: a fresh subagent that wrote none of the audited code. Base: `932eeee` (SG25–SG30 and AUDIT-12 merged), branch `claude/atlas-audit-14`.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22. Other sessions ran concurrently the whole time (AUDIT-13 among them), so the load moved between 0.5 and 4.4. The 1-minute load average is given with each group of runs. Each timing is a median of several runs unless the cell says otherwise. A/B comparisons ran interleaved in the same rounds against builds of `f65410c` (AUDIT-10 base) and `556e572` (SG27), extracted with `git archive` into the scratchpad.

| Runs | Load average (1 min) |
| --- | --- |
| `bench.mjs`, 5 rounds × 4 targets | 0.82 to 1.65 |
| `bench.mjs` on got, A/B current / SG27 / AUDIT-10 base, 6 interleaved rounds | 1.23 to 1.32 |
| per-file sum vs median on got, current vs SG27, 5 interleaved rounds | 1.29 |
| `audit3-patho.mjs pyroots`, `gitignore`, `workspaces`, `gitignore-wide` | 1.00 to 1.35 |
| deep `.gitignore` chain, local / anchored / none, current vs SG27 | 1.35 to 1.48 |
| `audit4-mcp-queue.mjs` 3k (new) | 1.21 |
| `audit4-mcp-queue.mjs` 10k, no-op phase | 3.32 |
| `audit2-mcp-index.mjs` 1k, current vs AUDIT-10 base | 0.52 / 2.02 |
| `audit4-fresh.mjs realistic` 1k / 3k / 10k (new) | 1.84 / 2.03 / 2.85 |
| `audit4-fresh.mjs wide` 2k / 10k / 20k dirs | 3.88 to 4.39 |
| `audit-perf.mjs --gen 700 --skip docs,drift,ask`, ×3 | 1.94 to 2.32 |
| `audit-perf.mjs --gen 10000 --runs 1 --skip ask` | 1.65 → 1.49 |
| resolver + search A/B at 150k symbols, same DB | 1.45 to 2.91 |
| budget path at 10k | 3.68 at end |
| `audit2-reindex.mjs` 1k / 3k | **3.56 / 3.90** |
| `audit-load.mjs` / `audit2-load.mjs` at 10k | **3.69 / 3.75** |
| `npm run test:perf`, ×3 | 2.05 to 2.51 |

The re-index and 10k load tables were measured at load 3.5–3.9, so their absolute times are 20–30% above AUDIT-10's. Compare ratios, not milliseconds.

## Workloads

| Name | Source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| express | `expressjs/express` @ `0dee2c5` | 141 | **764** | **1,274** |
| got | `sindresorhus/got` @ `05b4476` | 96 | **1,080** | **3,138** |
| Atlas self | this worktree | 195 | 1,471–1,488 | 5,835–5,872 |
| synthetic10k | `bench.mjs --target synthetic10k` | 202 | 10,206 | 0 |
| realistic 700 / 1k / 3k / 10k | `scripts/audit-repo.mjs` | 736 / 1,051 / 3,151 / 10,501 | 10,536 / 15,051 / 45,151 / 150,501 | n/a / 23,032 / 69,072 / 230,352 |
| `pyroots N`, `workspaces N`, `gitignore D` | `scripts/audit3-patho.mjs` | as AUDIT-10 | | |
| wide N | `scripts/audit4-fresh.mjs wide` (new) | N, one per directory | 2N | 0 |

SG26 (callback bodies are local scopes) cut the real-repo symbol counts: express 1,992 → 764, got 5,756 → 1,080, Atlas 2,603 → 1,471. Most of the dropped rows were locals inside test callbacks. got's parse+insert now does a fifth of the symbol inserts it did in AUDIT-10, so its ms/file is almost all parse.

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-10 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express, Atlas) | express 1.85; self 2.90 | express **1.91** (1.62–2.01); self **2.81** (2.63–2.85) | PASS | `node scripts/bench.mjs --target <express>` · `--target self` |
| (same, got) | **4.71** (1 of 10 runs over 5) | bench rounds **4.43** (4.02–5.47, 5 runs); interleaved A/B **4.03** (3.79–4.41, 6 runs); all 11 runs **4.29**, 1 of 11 over 5. SG27 build in the same rounds 3.59, AUDIT-10 base 4.80. | **PASS, 14–19% margin (A14-03)** | `bench.mjs --target <got>` |
| (same, other targets) | synthetic10k 4.48; realistic 1k / 3k / 10k 2.79 / 2.89 / 3.32 | synthetic10k **4.09** (3.94–4.21); realistic 700 **3.09**, 10k **3.46** | PASS | `bench.mjs --target synthetic10k` · `audit-perf.mjs --gen N` |
| no-op re-index ≤ 100 ms / 100 files | express 9.3; self 9.0; got 27.5; synthetic10k 32.8; realistic 1k / 3k / 10k 7.1 / 7.6 / 9.7 | express **8.9**; self **7.2**; got **15.6**; synthetic10k **31.5**; realistic 1k / 3k / 10k **8.4 / 10.7 / 11.0–12.3**; wide 20k dirs **9.8** | PASS | `bench.mjs` · `audit4-fresh.mjs realistic\|wide` |
| `search` p95 ≤ 50 ms at 10k symbols | 13.3; synthetic10k 15.1 | realistic 10.5k **16.4** (15.9 / 16.4 / 17.0); synthetic10k **16.5** (14.9–17.7) | PASS | `audit-perf.mjs --gen 700 --skip docs,drift,ask` (×3) |
| (known, decided: 150k symbols, exact search) | p95 151.6 | p95 **183** in `audit-perf` (load 1.6); same DB A/B: current **128 / 138**, AUDIT-10 base **128 / 131** | known; no regression | `audit-perf.mjs --gen 10000` · A/B script in Method |
| resolver ≤ 2 s / 1k files | realistic 0.28 / 0.32 / 0.37 s/1k; workspaces 0.16 | realistic 700 **0.31**, 10k **0.47** (A/B on the same DB: current 4.80 / 4.83 s, AUDIT-10 base 4.94 / 5.19 s); workspaces 100 / 300 / 1k / 2k **0.09 / 0.09 / 0.08 / 0.10** | PASS | `audit-perf.mjs` · `audit3-patho.mjs workspaces` |
| (same, Python monorepo) | **FAIL from 2.3k files**: 0.82 / 1.73 / 3.43 / 7.26 s/1k at 1k / 2k / 4k / 8k | **0.040 / 0.046 / 0.043 / 0.048 s/1k** (8k files: 382 ms, was 58 s) | **PASS, linear (A10-01 fixed)** | `audit3-patho.mjs pyroots <work> 125 250 500 1000` |
| cached docs ≤ 1 s / 1k files | 0.33 / 0.30 / 0.32 s/1k | 10k **0.40 s/1k** (4.17 s) | PASS | `audit-perf.mjs --gen 10000` |

**Every frozen budget passes**, including the one AUDIT-10 failed (A10-01). The 10k numbers are 10–25% above AUDIT-10's, and the same-DB A/B against the AUDIT-10 base build shows the same gap on the base build. The cause is machine load, not code.

## SG25–SG30 claims

| Claim | Check | Result |
| --- | --- | --- |
| SG27 / A10-01: Python resolver linear | `pyroots` 125–1000 projects: 40–48 ms/1k files, flat | **Holds** |
| SG27 / A10-02: got parse+insert ≤ ~4.2 ms/file median | 4.03 interleaved (holds), 4.43 in the 5-round bench (does not). Per-file **sum** over got is the same for current and SG27 (1,203–1,338 against 1,227–1,404 ms). No `src/` change since SG27 touches the parse or insert path, so the difference in medians is noise. | **Holds within noise**; margin to 5 ms is 14–19% (A14-03) |
| SG27: inserts batched | Statement steps on a 10-file dense repo: about 150 for 2,500+ rows; 3,046 with batching reverted | **Holds**; now gated by an operation-count test (A14-05) |
| SG27 / SG30 / A10-04: nested `.gitignore` walk linear in depth | Chain of D levels, 5 files and a `.gitignore` each. Segment-local patterns: 55 / 95 / 308 / 547 µs/file at D = 100 / 200 / 400 / 600. Anchored patterns (with `/`): 81 / 151 / 429 / 859. No `.gitignore` at all: 41 / 48 / 85 / 101. SG27 build, anchored: **497 / 1,536 / 4,893 / 11,373** | **Partly holds.** SG30 made the anchored shape 6–13× faster than SG27, which was still cubic on it. Per-file cost still grows linearly with depth, so the total is quadratic (A14-04, Low). Wide trees are linear: 2,000 packages with a `.gitignore` each take 403 ms for 40k files, against 352 ms without. |
| SG27 / A10-05: tsconfig `paths` | `workspaces` 100 → 2,000 packages: 0.09 → 0.10 s/1k (AUDIT-10: 0.11 → 0.16) | **Holds** |
| SG25: freshness checks are cheap | `resolverFingerprint` alone: realistic 1k / 3k / 10k **2 / 5 / 13 ms** (walk 13 / 33 / 110 ms); wide 2k / 10k / 20k dirs **30 / 167 / 320 ms** (16% of the 1.96 s no-op at 20k) | **Holds**; linear (A14-06, Low) |
| SG25: re-parse after an `EXTRACTOR_VERSION` bump | upgrade run against `--force`, 1k / 3k / 10k: **9.9 / 9.5 s, 31.6 / 27.3 s, 93.3 / 79.0 s**; every file re-indexed, symbol count unchanged | **Holds**; costs about as much as `--force` (load was rising 1.8 → 2.9 during these runs) |
| SG28: budget path | 10k index, offline client: fully cached 4.72 s; `force` + budget 20k: 16 generated, 10,485 skipped, **4.79 s**; budget 2k: 4 generated, 4.20 s | **Holds**: an exhausted budget costs the same as a cached run (it still builds every prompt to check the cache) |
| SG29: per-DB queue, no duplicate inserts | 20 parallel no-op and 4 parallel forced `atlas_index` calls at 3k, 20 no-op at 10k: symbol count unchanged, 0 errors | **Holds for correctness**; liveness and memory are A14-01 and A14-02 |

## SG29 queue under parallel MCP `atlas_index` (`scripts/audit4-mcp-queue.mjs`, new)

An `atlas_search` probe is sent every 100 ms while the calls run. "Search max" is the longest a probe waited.

| Files | Calls | Wall | First / median / last reply | Search max (probes) | RSS before → after (HWM) |
| --- | --- | --- | --- | --- | --- |
| 3,151 | 20 no-op | 5.2 s | 0.8 / 3.0 / 5.0 s | **2.96 s** (2) | 780 → 952 MB (984) |
| 3,151 | 4 forced | 96.8 s | 21.7 / 42.5 / 91.4 s | **96.5 s** (2) | 952 → **2,467 MB** |
| 10,501 | 20 no-op | 20.6 s | 1.0 / 12.0 / 20.3 s | **15.4 s** (2) | 2,216 → 2,248 MB |

Idle search on the same servers takes 82 ms (3k) and 125 ms (10k). Only 2 probes completed in each phase, because the first probe is stuck for the whole queue. In-process (`indexRepo` called directly, 3,151 files, 4 forced runs): queued, RSS goes 741 → 1,258 → 1,855 → 2,380 → **2,875 MB**; the same 4 runs awaited one after another with a 50 ms timer between them go 742 → 1,261 → 1,349 → 1,380 → **1,373 MB**. Serial forced MCP calls at 1k files grow 14 MB per call (AUDIT-10 base: 12), unchanged from A2-06.

## Incremental and mass re-index (`scripts/audit2-reindex.mjs`, load 3.6–3.9)

| Files | noop | edit1 | edit10 | edit100 | add1 | delete1 | branch switch (fresh share) | switch back | resolver | RSS high-water |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,051 | 94 | 598 | 611 | 1,269 | 483 | 515 | 3,098 (2,052) | 3,318 | 394 | 661 MB |
| 3,151 | 287 | 1,381 | 1,468 | 2,190 | 1,265 | 1,396 | 9,155 (5,296) | 9,613 | 1,057 | 1,369 MB |

The shape matches AUDIT-10: linear, the branch switch costs 1.5–1.7× a fresh index of the changed files, and every one-file change still pays the resolver (A2-07, unchanged).

## Load at 10k files (`audit-load.mjs`, `audit2-load.mjs`, load 3.7)

| Request | AUDIT-10 HTTP / MCP ms | Now HTTP / MCP ms |
| --- | --- | --- |
| search serial p50 / p95 | 104 / 129 · 102 / 116 | 116 / 145 · 118 / 138 |
| 50 parallel HTTP searches | wall 5.19 s, p95 4.99 s | wall 6.10 s, p95 5.86 s, 0 errors |
| graph default page | 8–9 · 14 | 9–15 · 14 |
| graph `file=src` page 1 / 2 (A6-01) | 496 / 465 · 444 | 579 / 525 · 584 |
| graph hub depth 1 / 3 (A6-01) | 105 / 805 · 783 | 125 / 982 · 1,058 |
| doc list (A6-04) | 306 (1.66 MB) · 306 (1.84 MB) | 389 (1.66 MB) · 481 (1.84 MB) |
| one doc (A6-02) | 286–299 · 279 | 386–405 · 368 |
| `/api/stats` (A6-05) | 107 | 132 |
| `atlas_symbol` hub / `atlas_ask` p50 | 509–523 / 1,023 | 591–622 / 1,401 |
| `atlas_drift` page 0 / deep (A6-03) | 5,476 / 4,539 | 6,068 / 5,136; a search behind it waits 5.44 s |
| mixed burst, search p95 | 4.92 s | 6.00 s, 0 errors |
| server RSS / HWM | 403 / 434 · 684 | 402 / 434 · 730 |

All 10–30% slower at 3.7× AUDIT-10's load. Nothing errored and no response size changed. A6-01..A6-05 are open and unchanged in shape.

## Memory

| Probe | AUDIT-10 | Now |
| --- | --- | --- |
| RSS per parse of got `options.ts` (200 parses, A2-06) | 3.76 MB | **3.74 MB** |
| `audit-perf` 10k: after index / peak | 2,140 / 2,875 MB | **2,171 / 2,651 MB** |
| `atlas mcp` at 10k after index + 20 no-op calls | — | 2,252 MB HWM |
| 3k reindex probe high-water | 1,388 MB | 1,369 MB |
| 4 queued forced index runs, 3k | — | **2,875 MB** (serial: 1,373) (A14-01) |

## Findings

Counts: **Critical 0, High 1, Medium 3 (plus A6-01..A6-04 still open), Low 2 (plus A6-05).**

### High

#### A14-01: an index run never yields to the event loop, so SG29's queue blocks the MCP server for every queued run back to back and keeps their native memory
- **Evidence:**
  - At 3,151 files, 4 parallel `atlas_index {force:true}` calls take 96.8 s. An `atlas_search` sent 0.1 s after them waits **96.5 s**; it takes 82 ms on an idle server. The MCP SDK's default request timeout is 60 s, so a default client would see that search fail.
  - At 10,501 files, 20 parallel no-op calls block a search for **15.4 s**. The last caller waits 20.3 s for a run that does nothing.
  - Memory: the same 4 forced runs queued in-process end at **2,875 MB** RSS. Run one after another with one timer turn between them, they end at **1,373 MB**. tree-sitter 0.21 frees trees from GC finalizers, which need a turn of the event loop (A2-06). Through MCP the 4 forced calls took the server from 952 to 2,467 MB. At 10k files a forced run alone peaks near 2.7 GB, so 3–4 queued forced calls could exhaust a 16 GB machine.
  - `test/audit/audit-14.test.ts` A14-01 (`it.fails`): a `setTimeout(0)` set while three index runs are queued fires only after all three end (`expected 3 to be less than 2`).
- **Repro:** `node scripts/audit4-mcp-queue.mjs $(mktemp -d) 3000 20 4` · `npx vitest run test/audit/audit-14.test.ts`
- **Cause:**
  - `runIndex` (`src/core/ingest/indexer.ts:110-343`) awaits only promises that are already resolved. `parseSourceOrThrow` gets a cached grammar bundle, and `embedder.embed` is synchronous inside an `async` function. Every await is therefore a microtask, and stdin, timers and finalizers never get a turn.
  - SG29's queue (`indexer.ts:95-108`) chains the next run with `.then`, also a microtask, so N queued runs execute as one uninterrupted block.
  - Before SG29, one forced run already blocked the server for its own duration (A6-03 is the drift equivalent). The queue turns that into N runs.
- **Possible fix:** `await new Promise(setImmediate)` in the per-file loop whenever about 50 ms has passed since the last yield, and between the walk, parse, resolve and embed phases. Start each queued run from a macrotask. Together with A14-02, this is proposed as **SG34**.
- **Severity:** High. A long-lived MCP server stops answering for minutes, and its memory roughly doubles per queued forced call, under a load pattern SG29 explicitly supports (parallel `atlas_index`).

### Medium

#### A14-02: queued `atlas_index` calls are not coalesced; N identical no-op calls do N full walks and hashes
- **Evidence:** at 10k files each queued no-op call costs about 1.0 s (walk, read and hash of every file, plus the fingerprint scan). 20 parallel calls give a median reply of 12.0 s and a last reply of 20.3 s, and all 20 return the same stats. At 3k files: 5.0 s for the last of 20.
- **Repro:** as A14-01; the `noop` phase of `audit4-mcp-queue.mjs`.
- **Cause:** `indexRepo` queues every call. A call that arrives while a run with the same options is already waiting could join that run instead.
- **Fix:** part of SG34. A call queued behind a running run joins the next queued run with equal `force`/walk options, so at most one run is running and one is waiting.

#### A14-03: got parse+insert is 4.0–4.4 ms/file, inside budget, but the margin is still under 20%
- **Evidence:** the 5-round bench gives a median of 4.43 (4.02–5.47, one run over 5 at load 1.14). The interleaved A/B gives 4.03 (current) against 3.59 (SG27 build) and 4.80 (AUDIT-10 base). Per-file sums are the same for current and SG27, and no parse or insert code changed after SG27.
- **Repro:** `for i in 1 2 3 4 5; do node scripts/bench.mjs --target <got> | grep -o '"msPerFileMedian":[0-9.]*'; done`
- **Status:** A10-02 is fixed in substance (+25% → about −10% against the AUDIT-10 base). The remaining cost is parse, because SG26 left got with a fifth of the inserts. Medium because one run in 11 still crossed 5 ms under modest load and the budget is ungated for got (A10-03 remainder). No new PLAN row; SG34 does not touch this path.

#### A14-05 (A12-04): no wall-clock gate can see an insert-batching regression; operation-count gate added
- **Evidence:** with batching reverted, `test/perf/index.test.ts` stays at 2.6–2.9 ms/file on Atlas itself (AUDIT-12, PF3). On a symbol-dense synthetic repo (100 files × 80 functions, 3 refs each), batched and unbatched builds measure 10–19 and 10–16 ms/file in interleaved runs: parse dominates and the noise is larger than the insert share. **So `test:perf` cannot catch it, and neither could a denser wall-clock fixture.**
- **Change made in this audit:** `audit-14.test.ts` A14-05 counts the `INSERT INTO symbols|imports|refs|edges` statements stepped while indexing 10 files of 60 functions. It passes at about 150 steps for 2,500+ rows, with the bound set at rows / 8. With batching reverted it fails (`expected 3046 to be less than or equal to 380.75`). It runs in the default suite in about 0.2 s.
- **Status:** closed by the gate.

### Low

#### A14-04: the nested-`.gitignore` walk costs O(ancestor rules) per entry, so a deep chain is quadratic
- **Evidence:** see the SG27/SG30 claims table. At D = 600, local patterns cost 547 µs/file and anchored ones 859 µs/file, against 101 µs/file with no `.gitignore`.
- **Cause:** `extendGroups` merges consecutive segment-local sets into one `ignore` matcher, so that matcher holds every ancestor's rules. Anchored sets are tested one by one (`walker.ts:96-125`). Git does the same per-path work, so this is the semantic cost, not a regression.
- **Change made in this audit:** `test/perf/walk-anchored.test.ts` gates the anchored shape at 1 ms/file at depth 200. Current code takes 0.19 ms; the SG27 build takes 2.09 ms and fails it.
- **Severity:** Low. Real trees are about 10 deep, where this is under 0.1 ms per file.

#### A14-06: `resolverFingerprint` re-lists every indexed directory on each no-op run
- **Evidence:** 13 ms at 10.5k files in 525 directories; 320 ms at 20k one-file directories, 16% of that no-op run (1.96 s, 9.8 ms/100 files, inside budget).
- **Cause:** `modules.ts:466-488` runs `readdirSync` on every directory in `dirsOf(paths)`, after the walk has already listed each of them. The walk could collect the config-file names it sees and pass them in.
- **Severity:** Low (linear, inside budget).

### Open from earlier audits (re-measured above)

A6-01 (scoped graph totals), A6-02 (one doc reads every doc), A6-03 (drift paging re-runs drift), A6-04 (unbounded doc lists) and A6-05 (`/api/stats`) are unchanged in shape. A2-06 (tree-sitter RSS), A2-07 (resolver on every edit), A2-08 and A2-10 are unchanged.

## No finding

- **SG25 extractor upgrade:** costs the same as `--force` and re-indexes every file once. The run after it is a no-op.
- **SG28 budget path:** linear, and the same cost as a cached run. Running out of budget does not make later files slower.
- **SG29 correctness:** no duplicate symbols under 20 parallel no-op and 4 parallel forced calls, and no errors.
- **SG30 walker on wide trees:** linear. With a `.gitignore` in each of 2,000 packages the walk takes 403 ms for 40k files, against 352 ms without.
- **Search at 150k symbols:** the same as the AUDIT-10 base build on the same DB (p95 128–138 against 128–131 ms).

## Method notes

- The per-file sum against median on got used a small in-process script that calls `indexRepo` with `onFile` on two `dist` builds alternately. The resolver and search A/B at 150k symbols opened the `audit-perf --gen 10000` DB with each build in turn.
- Mutation checks ran in a scratch copy of `src/` and `test/`; this worktree's `src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `scripts/audit4-mcp-queue.mjs` | Parallel `atlas_index` calls against `atlas mcp` with a search probe: per-call latency, search wait, RSS, duplicate check. |
| `scripts/audit4-fresh.mjs` | SG25 costs: fresh, no-op, walk, `resolverFingerprint` alone, the upgrade re-parse against `--force`; realistic and wide layouts. |
| `test/audit/audit-14.test.ts` | A14-05: operation-count gate for insert batching (passes; fails with batching reverted). A14-01: `it.fails`, a timer cannot fire while queued index runs execute. About 0.4 s. |
| `test/perf/walk-anchored.test.ts` | Anchored `.gitignore` chain at depth 200 ≤ 1 ms/file (0.19 now; 2.09 on the SG27 build). |

All scripts require `npm run build`. Use a fresh work dir (`W=$(mktemp -d)`).

## Verification

`npm run typecheck && npm run lint && npm test && npm run test:perf` pass. `npm test`: 72 files, 679 passed and 1 todo, 30 s at load 0.9. `npm run test:perf` ×3 at load 2.0–2.5: 9 tests passed each time in 13–15 s.

| Gate | Run 1 / 2 / 3 | Budget |
| --- | --- | --- |
| parse+insert, Atlas self | 2.65 / 2.60 / 2.98 ms/file | 5 |
| no-op re-index | 9.2 / 8.6 / 7.4 ms/100 files | 100 |
| resolver, Atlas self | 338 / 349 / 370 ms/1k | 2,000 |
| resolver, Python monorepo 2k files | 57 / 61 / 55 ms/1k | 2,000 |
| walk, local `.gitignore` chain depth 200 | 103 / 134 / 104 µs/file | 1,000 |
| walk, anchored chain depth 200 (new) | 193 / 178 / 179 µs/file | 1,000 |
| search p95 at 10,206 symbols | 17.9 / 16.1 / 21.6 ms | 50 |
| cached synthesis, 1k files | 152 / 125 / 131 ms | 1,000 |
| drift, 1k files | 271 / 319 / 253 ms | 1,000 |
