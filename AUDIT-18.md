# AUDIT-18: performance under load (round 5)

Auditor: a fresh subagent that wrote none of the audited code. Base: `b4256d0` (SG34, SG40, SG50 and AUDIT-17 merged), branch `claude/atlas-audit-18`.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22. Other sessions ran the whole time, and the 1-minute load average moved between 0.1 and 9.5, often above the core count. The load is given with each group of runs. Compare builds inside a group, not across groups.

A/B builds were extracted with `git archive` into the scratchpad and built there:

| Build | What it is |
| --- | --- |
| `932eeee` | AUDIT-14 base (no SG31–SG34) |
| `303abb1` | Parent of SG34 (SG31–SG33, no yields) |
| `2f7ae40` | SG34 |
| `7f4cea0` | SG34 + SG40, parent of SG50 |
| current | `b4256d0` |
| `noyield` | current `dist` with `YIELD_MS = 1e12` (the per-file yield never fires) |
| `inst`, `inst0` | current and `7f4cea0` `dist` with timers around `carryEdges` and the symbol delete |

| Runs | Load average (1 min) |
| --- | --- |
| dense 3k, current / `7f4cea0`, 3 interleaved rounds | 1.4 to 5.0 |
| dense 3k, instrumented carry breakdown | 0.2 to 3.8 |
| 10k realistic, current / `7f4cea0` | 1.5 to 3.9 |
| 10k dense, current / `7f4cea0` | 4.9 to 7.4 |
| 10k realistic, `932eeee` | 6.8 to 7.8 |
| realistic 3k fresh, `932eeee` / `303abb1` / `2f7ae40`, 3 interleaved rounds | 6.7 to 8.0 |
| MCP queue 3k, current / `932eeee` | 6.6 / 5.7 |
| MCP queue 10k, current | 5.7 |
| `atlas_ask` at 10k, three builds ×2 | 3.5 to 5.9 |
| generated-file and duplicate-name runs | 3.6 to 7.3 |
| got bench, four builds × 4 | 6.4 to 9.0 |
| got / synthetic10k, `303abb1` / current × 3 | 3.0 to 4.4 |
| got, `noyield` / current × 4 | 1.9 to 2.1 |
| got, `noyield` / current / `932eeee` × 3 | 2.5 to 3.0 |
| `npm run test:perf` ×3 | 7.9 / 8.1 / 2.4 |
| bench express / self / synthetic10k | 5.2 to 5.6 |

## Workloads

| Name | Source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| realistic 3k / 10k | `scripts/audit-repo.mjs` | 3,151 / 10,501 | 45,839 / 152,773 | 69k / 230,352 |
| dense 3k / 10k (new) | `gen-dense.mjs` (Method): TS only, 8 functions per file, each calling 6 imported functions and `hub.log` | 3,001 / 10,001 | 27,002 / 90,002 | **224,769 / 749,769** |
| generated N | one `api.generated.ts` of N 4-line exported functions (836 KB at N = 8,000) plus one caller | 2 | N + 3 | 1 |
| dupN | one Python file of N `x = i` lines plus a module that imports `x` | 3 | N + 5 | 3 |
| express, got | `repos/` clones as in AUDIT-14 | 141 / 96 | 778 / 1,090 | |

SG31 adds about 1.5% symbols on the realistic layout (150,501 → 152,773 at 10k).

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-14 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express, Atlas) | express 1.91; self 2.81 | express **2.02**; self **3.76** (bench, load 5.6); `test:perf` self **3.55 / 3.19** (load 7.9–8.1) | PASS | `node scripts/bench.mjs --target <express>` · `--target self` |
| (same, got) | 4.03–4.43 | **5.07 / 5.18 / 5.73** at load 2.5–3.0 (`932eeee` 3.81–4.90, `noyield` 4.22–4.56 in the same rounds); 5.39–7.05 at load 1.9–2.1 (`noyield` 4.03–5.51) | **over 5 since SG34 (A18-05)** | `bench.mjs --target <got>` |
| (same, synthetic10k) | 4.09 | 4.25–4.73 (`303abb1` 5.09–6.68 in the same rounds) | PASS | `bench.mjs --target synthetic10k` |
| no-op re-index ≤ 100 ms / 100 files | self 7.2; synthetic10k 31.5; realistic 10k 11.0–12.3 | `test:perf` 14.8 / 10.3; synthetic10k 45.8; realistic 10k **11.6** (1,214 ms); dense 10k 7.0 | PASS | `bench.mjs` · `probe.mjs … noop` |
| `search` p95 ≤ 50 ms at 10k symbols | 16.4–16.5 | `test:perf` **18.0 / 19.2**; synthetic10k bench 20.0 | PASS | `npm run test:perf` |
| resolver ≤ 2 s / 1k files | self 338–370 ms/1k | `test:perf` 511 / 474 ms/1k; Python monorepo 95 / 60 | PASS | `npm run test:perf` |
| cached docs ≤ 1 s / 1k files | 125–152 ms | 186 / 174 ms; drift 387 / 263 ms | PASS | `npm run test:perf` |

Every gated budget passes. got is not gated. Its bench median moved above 5 ms when SG34 added yields, although the total index time did not change (A18-05).

## SG34: yields and coalescing

### Overhead of yielding

| Check | Result |
| --- | --- |
| Yields per run | 980 on a 75 s fresh 10k index (one every 77 ms); 1,484 on a 106 s forced run; 7 on a no-op run |
| Fresh realistic 3k, 3 interleaved rounds (load 6.7–8.0) | `303abb1` 20.5 / 21.5 / 22.4 s; `2f7ae40` 20.5 / 20.8 / 23.5 s. **No measurable wall-clock overhead.** (`932eeee` 19.0–21.0 s: SG31–SG33 cost about 7%, mostly SG31's extra symbols and patterns.) |
| Fresh realistic 10k | current 75.5 s (load 3.7), `7f4cea0` 76.5 s (2.8), `932eeee` 69.9 s (7.8) |
| Memory (VmHWM) | realistic 3k fresh **740 → 241 MB**; realistic 10k fresh **2,127 → 456 MB**; dense 3k fresh + force + upgrade in one process 1,881 → 551 MB. A14-01's memory half is fixed: tree-sitter trees are now freed during the run. |
| Per-file median | moved up on got only: see A18-05 |

### Search during a queue (`mcpq.mjs`, MCP stdio, a search probe every 100 ms)

| Files | Calls | Build | Wall | First / median / last reply | Search probes | Search median / p95 / **max** | RSS (HWM) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3,151 | 20 no-op | `932eeee` | 6.4 s | 1.1 / 3.9 / 6.2 s | 2 | 1.4 s / — / **4.8 s** | 777 → 938 MB |
| 3,151 | 20 no-op | current | **0.85 s** | 0.38 / 0.71 / 0.71 s | 3 | 207 / 231 / **231 ms** | 285 → 330 MB |
| 3,151 | 4 forced | `932eeee` | 114.2 s | 27.2 / 55.6 / 108.8 s | 2 | 28.6 s / — / **85.5 s** | 938 → **1,951 MB** |
| 3,151 | 4 forced | current | **36.7 s** (one shared run) | 36.5 s for all 4 | 209 | 47 / 88 / **3,784 ms** | 330 → 433 MB |
| 10,501 | 20 no-op | current (AUDIT-14: 20.6 s, max 15.4 s) | **3.8 s** | 1.8 / 3.5 / 3.5 s | 7 | 229 ms / 1.03 s / **1.03 s** | 514 → 550 MB |
| 10,501 | 2 forced | current | 163.3 s (one shared run) | 163.0 s for both | 695 | 105 / 181 / **14,097 ms** | 550 → 460 MB (HWM 549) |

Idle search: 46 ms (3k), 149 ms (10k). The queue is fixed. Queued calls share one run, the server answers between files, and memory stays flat. **Two blocking windows remain, at the end of every run that resolves:** the resolve transaction, then the embed phase. The slow probes in the table are those two windows (3k: 1.4 s and 3.8 s; 10k: 5.4 s and 14.1 s). The 10k forced run took 163 s through MCP and 106 s in-process: its 695 searches share the same thread.

### Blocking windows in-process (`probe.mjs`, longest event-loop gaps with a 5 ms interval timer)

| Workload | Run | Resolve block | Embed block | Next longest | Total |
| --- | --- | --- | --- | --- | --- |
| realistic 10k | fresh | 4.8 s | **14.2 s** | 0.23 s (walk) | 75.5 s |
| realistic 10k | forced | 4.6 s | **12.7 s** | 0.15 s | 105.9 s |
| realistic 10k | upgrade | 5.4 s | **14.0 s** | 0.27 s | 109.8 s |
| realistic 10k | no-op | — | 0.88 s (loads every symbol to find none to embed) | 0.14 s (walk) | 1.2 s |
| dense 10k | fresh / forced | **9.1 / 10.1 s** | 7.1 / 7.8 s | 0.23 / 1.18 s | 58.9 / 114.0 s |
| dense 3k | fresh / forced | 2.4–2.6 / 2.4–2.8 s | 1.9–2.1 / 2.0–2.3 s | 0.39 s | 15.0–16.2 / 31.0–32.9 s |
| `932eeee`, realistic 10k | fresh | one 69.9 s block | | | 69.9 s |

These are A18-02. The resolve block grows with edges and the embed block with symbols, both linearly.

## SG50: re-pointing edges on re-parse

| Workload (load) | Run | `7f4cea0` | current | Δ |
| --- | --- | --- | --- | --- |
| dense 3k, 3 rounds (1.4–5.0) | `--force` | 22.5 / 23.7 / 24.2 s | 31.0 / 31.3 / 32.9 s | **+33%** |
| | upgrade | 23.9 / 24.1 / 24.2 s | 31.8 / 33.1 / 35.0 s | **+37%** |
| | fresh | 15.2 / 16.0 / 16.1 s | 15.0 / 15.7 / 16.2 s | none |
| dense 10k (4.9–7.4) | `--force` | 84.0 s | 114.0 s | **+36%** |
| | upgrade | 88.0 s | 119.0 s | **+35%** |
| realistic 10k (1.5–3.9) | `--force` | 94.1 s | 105.9 s | +13% |
| | upgrade | 101.7 s | 109.8 s | +8% |

Breakdown on dense 3k `--force` (instrumented builds, one run each, load 0.4 / 3.1): `carryEdges` SELECTs **1.2 s**; remapping and re-inserting 392,601 edge rows (1.75 per final edge) **2.1 s**; the symbol DELETE's cascade 2.9 s against 2.0 s before SG50, because the edges it deletes are back in the table. That accounts for about 4.2 s. The remaining 4–5 s of the gap was not timed by the instrumentation; it falls outside those statements (commits and the larger WAL). Every one of those rows is then deleted by the resolve transaction's `clearEdges`. This is A18-03.

The query plan is indexed: `MULTI-INDEX OR` over `idx_edges_src` / `idx_edges_dst` via `idx_symbols_file`. The cost is linear in edges, not quadratic. An incremental edit carries only the edited file's edges (pinned in `audit-18.test.ts`).

**Duplicate names (A18-06):** `carryEdges` builds `fresh` with `[...(fresh.get(k) ?? []), id]` and drains it with `shift()`. Both are quadratic in the number of symbols that share a kind and name in one file. dup10000 `--force`: carry 0.17 s. dup30000: **5.97 s** (`7f4cea0`: 0). Overload lists, repeated module-level assignments and generated code produce such files. The parser emits one symbol per occurrence, for example 2,001 `f` symbols for 2,000 overloads.

**MCP reservation overhead:** no measurable CPU cost. Serial `atlas_ask` at 10k with a fake LLM (300 ms delay), median of 8, two runs each: current 1,765 / 1,835 ms, `7f4cea0` 1,580 / 1,642, `2f7ae40` 1,817 / 1,895 (load 3.5–6.0, noise). The cost is in capacity: see A18-04.

## SG40: config re-read per `atlas_ask`

`loadConfig` (read, JSON parse, zod) takes **45–88 µs** per call (1,000-call loop, three builds), about 0.005% of a 1.6 s ask at 10k. `reloadConfig` adds one `resolvePaths`. **No finding.**

## Findings

Counts: **Critical 0, High 1, Medium 4, Low 2.** A14-02 (coalescing) and the memory part of A14-01 are fixed. A14-01's latency part is reduced from minutes to the windows in A18-02. A14-03 got worse on its own metric (A18-05). A14-04 and A14-06 are unchanged (no walker or `modules.ts` change since AUDIT-14). A6-01..A6-05 and A2-06/07 are not re-measured here; their code did not change.

### High

#### A18-01: embedding text is O(symbols × lines) per file, so one large generated file blocks indexing and the MCP server for 11–47 s
- **Evidence:**
  - `buildSymbolText` → `sliceLines` (`src/core/vector/textForSymbol.ts:26-36`) runs `src.split('\n')` on the whole file once per symbol. `makeSourceLoader` caches the string, not its lines.
  - Fresh index of one generated TS file with N exported 4-line functions:

    | N | File size | Embed block | Total |
    | --- | --- | --- | --- |
    | 2,000 | 207 KB | 0.60 s | 1.0 s |
    | 4,000 | 417 KB | 2.0 s | 2.7 s |
    | 8,000 | 837 KB | **11.0 s** | 12.4 s |

    `932eeee` takes the same time (0.96 / 2.84 / 11.8 s), so this predates SG34. Load 6.0–7.3.
  - A 30,000-line Python file of assignments (about 300 KB) gives a **46.8 s** embed block and a 48.4 s fresh index. Parsing the same file takes 0.6 s and is linear: 150 / 271 / 568 ms at 5k / 10k / 20k lines.
  - Both files are under the 1 MB `maxBytes` cap. The cost recurs on every edit of the file, because all of its symbols are re-embedded, and on every `--force` and upgrade run. Through MCP, that is a search stall close to the SDK's 60 s default timeout from one file.
  - `test/audit/audit-18.test.ts` A18-01 (`it.fails`): indexing a 400-function file splits its source 400 times (`expected 400 to be less than or equal to 10`).
- **Repro:** write the generated-file repo described in Method notes (N = 8000), then `node <scratch>/a18/scripts/probe.mjs $PWD/dist <repo> <db> fresh` (the longest gap is the embed block) · `npx vitest run test/audit/audit-18.test.ts`
- **Fix:** split each file once, caching lines or line offsets in `makeSourceLoader`, and slice by line index. Proposed as **SG55**, together with A18-02's embed yield, because it is the same loop.
- **Severity:** High. A realistic input (generated clients, schema types, protobuf output) costs quadratic time inside a single synchronous block. It is the largest event-loop stall left after SG34, and it is reached by any `atlas_index` on such a repo.

### Medium

#### A18-02: the resolve transaction and the embed phase are still single blocks: 4.6–5.4 s and 12.7–14.2 s at 10k realistic files
- **Evidence:** see the blocking-window tables above. Through MCP, a search during a forced 10k run waited **14.1 s** (embed) and 5.4 s (resolve); idle search is 149 ms. At 3k files, 3.8 s and 1.4 s. On dense 10k, resolve is 9–10 s. No-op runs block for 0.88 s at 10k, because `embedAllSymbols` loads all 152k symbols and `embeddings_meta` to find none to embed.
  - `audit-18.test.ts` A18-02 (`it.fails`): a self-rescheduling `setImmediate` does not tick across the embed phase of a 4,000-symbol index (`expected 12 to be greater than 12`).
- **Repro:** `node <scratch>/a18/scripts/probe.mjs $PWD/dist <realistic10k> <db> fresh,noop,force` · `node <scratch>/a18/scripts/mcpq.mjs $PWD <realistic10k> 20 2` · `npx vitest run test/audit/audit-18.test.ts`
- **Cause:** `embedAllSymbols` (`src/core/vector/embedAll.ts:61-78`) awaits `embedder.embed`, which is synchronous for `local-hash-v1`, so its loop never leaves the microtask queue. `resolveGraph` runs read, compute and write in one `db.transaction`. SG34's PLAN row already notes "resolve and embed phases still run as single blocks".
- **Fix:** in `embedAllSymbols`, `await new Promise(setImmediate)` between batches every ~50 ms; each batch is already its own transaction. Resolve: compute outside the transaction and yield, then write once, so readers still never see a partial graph (SG50). The embed half is cheap and rides with SG55. The resolve half can follow.
- **Severity:** Medium. These are seconds, not AUDIT-14's minutes, and they stay under the 60 s client timeout up to roughly 40k realistic files. They grow linearly with repo size.

#### A18-03: SG50 re-inserts edges that the resolve transaction then deletes: `--force` and upgrade runs 33–37% slower on dense graphs
- **Evidence:** see the SG50 table. Dense 3k: `--force` 31.0–32.9 s against 22.5–24.2 s; upgrade 31.8–35.0 against 23.9–24.2. Dense 10k: 114.0 against 84.0 s, 119.0 against 88.0. Realistic 10k: +8–13%. The parse loop alone went from 18.2–19.5 s to 26.4–27.7 s on dense 3k. Each forced run inserts 2,816 edge rows for 1,218 final edges in the 20-file test repo, about 1.3 throw-away rows per edge (392,601 rows for 224,769 edges on dense 3k).
  - `audit-18.test.ts` A18-03 (`it.fails` ×2): rows inserted into `edges` during a forced run and during an upgrade run are at most 1.1 × the final edge count (`expected 2816 to be less than or equal to 1340`). A plain test pins that a one-file edit carries only that file's edges.
- **Repro:** `node <scratch>/a18/scripts/gen-dense.mjs <dense3k> 3000 && <scratch>/a18/scripts/rounds.sh <dense3k> 3 fresh,force,upgrade $PWD <scratch>/a18/ab-7f4cea0` · `npx vitest run test/audit/audit-18.test.ts`
- **Cause:** `carryEdges` (`src/core/ingest/indexer.ts:177-217`) runs in every per-file transaction where the file has edges. On a run where every file is re-parsed, each edge is carried once from each endpoint's file, and `resolveGraph`'s `clearEdges` then discards them all.
- **Fix options:**
  1. Update symbols in place: match old and new by kind and name, `UPDATE` the matched rows, and insert or delete only the difference. Ids then survive, edges are untouched, there is no cascade, and it is cheaper than before SG50.
  2. Skip the carry when the run already knows it will re-resolve every file (`force`, upgrade), and accept A17-03's window for those runs only.
- **Severity:** Medium. No frozen budget covers re-parse runs, and every extractor bump costs every user one such run. Upgrade time at dense 10k is 119 s, already above the MCP client timeout before SG50 (88 s).

#### A18-04: SG50 reservations cap concurrent `atlas_ask` at about 11 per session, and the refusal reports reserved tokens as spent
- **Evidence:** 12 parallel `atlas_ask` calls at 10k files, default `tokenBudget` 200,000, fake LLM. Eleven run with `max_tokens` 16,000. The 12th fails: `token budget exhausted: a call needs ~2803 tokens (~1779 prompt + 1024 output), 1688 of 200000 left; raise tokenBudget`. The 11 calls used **13,734** tokens in all, so 186k were unspent. Two runs, same result. `7f4cea0` and `2f7ae40` run all 12. Each call holds about 17.8k (prompt + `ASK_MAX_TOKENS`).
  - `audit-18.test.ts` A18-04 (`it.fails`): with `tokenBudget` 33,000 and two asks in flight, a third is refused with a message that does not mention reservations or in-flight calls.
- **Repro:** `node <scratch>/a18/scripts/ask.mjs $PWD <indexed realistic10k> 8 12 300` · `npx vitest run test/audit/audit-18.test.ts`
- **Cause:** `metered` (`src/mcp/server.ts:83-99`) folds `reserved` into a scratch `TokenBudget` and calls `affordableMaxTokens`, whose message reports `remaining()` of that scratch budget. The refusal is by design (A17-02). The message and its remedy are not.
- **Fix:** say "N tokens reserved by M in-flight calls; retry when they finish or raise tokenBudget", or wait for in-flight calls to settle before refusing.
- **Severity:** Medium. An agent fanning out 12 questions gets a spurious failure, and the remedy it is given (raise the budget 10×) is wrong.

#### A18-05 (A14-03): got parse+insert median is over 5 ms/file since SG34, with the same total work
- **Evidence:** `bench.mjs --target got`, interleaved:
  - Load 2.5–3.0: current **5.07 / 5.18 / 5.73**, `noyield` 4.22 / 4.28 / 4.56, `932eeee` 3.81 / 4.47 / 4.90.
  - Load 1.9–2.1: current 5.39 / 5.64 / 6.66 / 7.05, `noyield` 4.03 / 4.50 / 4.78 / 5.51.
  - Load 6.4–9.0: `303abb1` 4.66–5.69, `2f7ae40` 6.05–7.74.
  - `indexMs` for the whole run is the same in every pair (1.6–2.2 s). Warm in-process runs (`perfile.mjs`, 5 runs each) have equal medians (≈4.4) and per-file sums (1.3–1.8 s) for `303abb1` and `2f7ae40`.
  - The only difference between `noyield` and current is `YIELD_MS`. So the yields move work into the measured per-file windows: tree-sitter finalizers and GC that used to run after the loop now run inside it. They do not add work.
  - synthetic10k does not move (current 4.25–4.73). express and self stay at 2.0 and 3.2–3.8.
- **Repro:** `for i in 1 2 3; do node scripts/bench.mjs --target <got> | grep -o '"msPerFileMedian":[0-9.]*'; done`, alternating with a copy whose `dist/core/ingest/indexer.js` has `YIELD_MS = 1e12`.
- **Severity:** Medium. The frozen budget names express and Atlas itself, which pass, and the work is unchanged. But got was the tracked margin case (A10-02, A14-03), and its reported number now fails at any load.
- **Suggestion:** either measure parse+insert per file excluding the yield turn (time from read to commit), or record in DECISIONS.md that the got median includes deferred native frees since SG34. No PLAN row.

### Low

#### A18-06: `carryEdges` is quadratic in same-name symbols within one file
- **Evidence:** dup10000 `--force`: carry 0.17 s. dup30000: **5.97 s**, against 0 on `7f4cea0` (instrumented builds, load 3.6–5.1).
- **Repro:** dupN repo (Workloads), then `node <scratch>/a18/scripts/probe.mjs <scratch>/a18/inst/dist <dupN> <db> fresh,force` (the `carry` field)
- **Cause:** `fresh.set(key, [...(fresh.get(key) ?? []), id])` copies the list on each push, and `shift()` drains it from the front.
- **Fix:** push into the array and keep a per-key cursor, or fix A18-03 by updating in place.
- **Severity:** Low. It needs thousands of same-name symbols in one file. Inputs that large are dominated by A18-01 anyway: the same dup30000 fresh index spends 46.8 s embedding.

#### A18-07: a no-op run at 10k still holds the event loop for about 0.9 s
- **Evidence:** realistic 10k no-op: 1.21 s total, 0.88 s in one block at the end, plus 0.14 s for the walk. `7f4cea0`: 1.34 / 1.00 s. Inside budget (11.6 ms/100 files). Through MCP, the 20 queued no-op calls at 10k had a search max of 1.03 s.
- **Repro:** `node <scratch>/a18/scripts/probe.mjs $PWD/dist <realistic10k> <db> fresh,noop` (the `noop` row's longest gap)
- **Cause:** `embedAllSymbols` loads every symbol, every file and all of `embeddings_meta` to find the zero symbols that need embedding. A `LEFT JOIN … WHERE meta.symbol_id IS NULL OR model != ?` count would skip that work.
- **Severity:** Low.

## No finding

- **SG34 yield overhead:** no measurable wall-clock cost; one yield every ~75 ms. Memory is fixed: HWM 2,127 → 456 MB at 10k.
- **SG34 coalescing:** 20 no-op calls → at most 2 runs (10k: last reply 20.3 → 3.5 s). 4 forced calls → one run (3k: 114 → 37 s, search max 85 s → 3.8 s). No duplicate symbols in any phase.
- **SG40 config re-read:** 45–88 µs per call.
- **SG50 reservation CPU:** none measurable. Query plan of the carry SELECT is fully indexed.
- **SG50 incremental edits:** carry is bounded by the edited file's edges (pinned).

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`. Scratch scripts are in `<scratch>/a18/scripts/` and are not checked in, because they wrap `dist` builds by path (`npm run build` first; `<realistic10k>` is `scripts/audit-repo.mjs <dir> 10000`):
- `probe.mjs <dist> <repo> <db> fresh,noop,force,upgrade`: wall time, event-loop gaps from a 5 ms interval, `setImmediate` count, VmHWM, and carry timers when run on an instrumented build. Upgrade is simulated as in `audit4-fresh.mjs` by rewriting `state.extractorVersion`.
- `gen-dense.mjs <dir> <n>`: the dense layout described under Workloads.
- `mcpq.mjs <atlasRoot> <repo> <parallel> <forced>`: `scripts/audit4-mcp-queue.mjs` with the build as a parameter, plus search p95 and the slow probes.
- `ask.mjs <atlasRoot> <indexedRepo> <serial> <parallel> <delayMs>`: `handleAskTool` with a fake LLM, serial latency, the parallel admit/refuse split, `loadConfig` µs.
- `rounds.sh <repo> <rounds> <phases> <atlasRoot...>`: `probe.mjs` interleaved over builds.
- `perfile.mjs <dist> <repo> <runs>`: per-file median, p90 and sum over fresh in-process indexes.
- The generated-file repo: N blocks of `/** Op i. */ export function opi(input: Inputk): Output { return client.call("opi", input); }` in `src/api.generated.ts`, plus `src/use.ts` calling `op1`.

`src/` is unchanged. The instrumented and `noyield` builds are patched copies of `dist` in the scratchpad.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-18.test.ts` | A18-01: source split once per symbol (`it.fails`). A18-02: embed phase never yields (`it.fails`). A18-03: forced and upgrade runs insert about 2.3× the final edges (`it.fails` ×2), and a plain bound for a one-file edit. A18-04: a reservation refusal does not say it is one (`it.fails`). Counts work and orders events, no wall-clock limits; about 2.5 s. Each `it.fails` was run once as a plain `it` and failed with the message quoted above. |

## Verification

`npm run typecheck && npm run lint && npm test && npm run test:perf` pass. Wall clock: typecheck 10.3 s (load 0.4), lint 3.7 s (0.8), `npm test` 40.2 s (0.8; 78 files, 754 passed and 1 todo), `test:perf` 17.2 s (2.4; 9 passed).

| Gate | Run 1 / 2 / 3 | Budget |
| --- | --- | --- |
| parse+insert, Atlas self | 3.55 / 3.19 / 2.93 ms/file | 5 |
| no-op re-index | 14.8 / 10.3 / 10.3 ms/100 files | 100 |
| resolver, Atlas self | 511 / 474 / 379 ms/1k | 2,000 |
| resolver, Python monorepo 2k files | 95 / 60 / 54 ms/1k | 2,000 |
| walk, local `.gitignore` chain depth 200 | 158 / 173 / 169 µs/file | 1,000 |
| walk, anchored chain depth 200 | 213 / 199 / 194 µs/file | 1,000 |
| search p95 at 10,206 symbols | 18.0 / 19.2 / 21.2 ms | 50 |
| cached synthesis, 1k files | 186 / 174 / 129 ms | 1,000 |
| drift, 1k files | 387 / 263 / 280 ms | 1,000 |
