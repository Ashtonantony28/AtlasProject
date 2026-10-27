# AUDIT-47: performance under load (round 12)

Auditor: a fresh subagent that wrote none of the audited code. Base: `10cccef` (SG230, #92), worktree `atlas-audit-47`. `src/` is unchanged since AUDIT-43's base `6c68a67` (`git diff 6c68a67 10cccef -- src` is empty); SG160, SG230 and the audit rounds since touched tests and docs only. This round therefore leaves the leftover-WAL path alone (AUDIT-35, -40 and -43 covered it) and looks at what recent rounds measured less: search scoring, graph export of large graphs, drift and cached docs on many files, the dashboard and MCP under concurrent clients, and many CLI openers.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22, ext4 at 77–84% full. A soundness auditor (AUDIT-46) worked in a sibling worktree: the 1-minute load average was **0.95–11.5** (given with each run). Compare builds inside a group; they were interleaved run by run. The page cache was warm except where noted.

| Build | What it is |
| --- | --- |
| current | `10cccef` (`npm run build`) |
| `68fb2c2` | The AUDIT-31 test commit, the last base commit before SG120 (#72), extracted with `git archive` into the scratchpad and built. Its `src/` differs from current only in the WAL series: `database.ts` (+501 lines), signal handling in `cli/index.ts` and the `index`/`docs`/`drift` commands, and `mcp/server.ts`/`web/server.ts` (close on signal, `nameCorrupt`). Search, graph, drift, synthesis, ingest and the resolver are identical, so any difference on those paths is the WAL series. |

## Workloads

| Name | Source | Files | Symbols | Edges | `index.db` |
| --- | --- | --- | --- | --- | --- |
| 10k symbols | AUDIT-40's `r700` sources | 736 | 10,693 | 16,083 | 24 MB |
| realistic 10k | AUDIT-40's `r10k` sources (`scripts/audit-repo.mjs`), indexed fresh by each build | 10,501 | 152,773 | 230,352 | 347 MB (with docs) |
| dense 10k | AUDIT-40's `d10k` sources (every function calls `hub.log` and 6 imported functions) | 10,001 | 100,003 | 879,419 | 314 MB (with docs) |
| dense 3.5M edges | a copy of dense 10k with its `edges` rows inserted twice more | 10,001 | 100,003 | 3,517,676 | 569 MB |

Docs for the realistic, dense and 10k-symbol workloads were generated with `atlas docs --offline --budget 1000000000` (the default `tokenBudget` of 200,000 covers about 700 realistic modules, so a plain run stops at the budget each time).

## Indexing (`run.mjs` with the `probe.mjs` preload: total, the three longest gaps of a 5 ms timer, VmHWM)

| Workload (load) | Run | current total / longest block | `68fb2c2` total / longest block | HWM current / `68fb2c2` |
| --- | --- | --- | --- | --- |
| realistic 10k (1.0–1.3) | fresh | 88.3 s / 6.63 s (resolve; a 4.41 s block at start, cold cache after the copy) | 81.0 s / 6.70 s | 528 / 516 MB |
| | no-op ×2 | 1.70 / 1.94 s; 0.90–1.09 s (embed setup) | 1.97 / 1.78 s; 1.01–1.06 s | 224–228 / 226 MB |
| | 1 file edited | 7.77 s / 5.21 s (resolve) | 7.08 s / 4.88 s | 502 / 506 MB |
| | 100 files edited | 8.34 s / 5.25 s | 8.66 s / 5.23 s | 513 / 519 MB |
| | 525 files deleted | 8.48 s / 6.30 s | 8.24 s / 6.22 s | 471 / 473 MB |
| dense 10k (1.4–4.4) | fresh | 75.4 s / 15.29 s (resolve) | 77.7 s / 13.08 s | 769 / 768 MB |
| dense 10k beside `atlas docs` every 4 s (2.2–2.7) | `--force` | 190.7 s, exit 0 | not run | |

- No-op re-index: 10,501 files in 1.70–1.97 s is 16–19 ms per 100 files (budget 100 ms). `test:perf`: 14.4 ms/100 files.
- An edit of one file costs 7–8 s at realistic 10k, about 5 s of it the resolve block: every run re-resolves the whole graph (A2-07, A22-01). Deleting 525 files costs the same as editing one. Pruning is linear (point vec0 deletes, SG14).
- Every pair is within noise. The WAL series adds nothing measurable to index runs.

## Search (`searchbench.mjs`, `limitbench.mjs`, `knnparts.mjs`: in-process, read-only, warm)

### By query shape (current; p50 / p95 ms over 20 runs, 40 at 10k symbols)

| Query | 10k symbols (load 2.4) | realistic 10k (2.1) | dense 10k (2.1) |
| --- | --- | --- | --- |
| exact name `handleAccount13x1` | 11.1 / 13.2 | 139 / 159 | 97 / 116 |
| two words `account total` | 12.5 / 15.2 | 143 / 163 | 93 / 100 |
| one common word `order` | 11.6 / 14.6 | 145 / 167 | 121 / 146 |
| 16 words | 17.2 / 19.4 | 213 / 259 | 90 / 106 |
| **two words, `limit 100`** | **35.3 / 51.5** | **401 / 492** | **337 / 413** |
| **`process` (matches nearly every docstring), `limit 100`** | **42.0 / 62.0** | **471 / 643** | **410 / 485** |
| `kind: class` | 12.0 / 17.2 | 144 / 172 | 40 / 48 |
| `file: pkg1/` (selective) | 7.8 / 8.4 | 72 / 79 | 38 / 39 |
| `file: src/` (half the files) | 16.8 / 19.6 | 219 / 286 | 135 / 154 |
| `file: zzzz` (no file) | 6.1 / 8.0 | 67 / 85 | 39 / 52 |
| `kind: method` + `file: py/` | 13.8 / 14.4 | 130 / 152 | 40 / 42 |

### By `limit`, builds interleaved (10k symbols, 60 runs each, 2 rounds; load 1.37–1.52)

| `limit` | current p50 / p95 | `68fb2c2` p50 / p95 |
| --- | --- | --- |
| 10 | 11.8–13.9 / 17.8–19.3 | 11.5–11.9 / 14.9–16.2 |
| 25 | 15.5–17.2 / 23.7–25.5 | 14.6–16.2 / 22.0–23.5 |
| 50 | 22.3–23.2 / 33.6–35.7 | 22.2–23.3 / 30.5–33.8 |
| **100** | **34.1–35.2 / 48.8–54.3** | **34.0–36.1 / 49.4–51.7** |

### vec0 KNN alone (realistic 10k, 141 chunks; median of 8; load 2.1)

| k | 10 | 50 | 100 | 200 | 400 | 800 | 1,600 | 3,200 | 4,096 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ms | 115 | 127 | 140 | 169 | 215 | 357 | 516 | 481 | 531 |

- Search stays linear in symbols (A2-02: brute-force KNN, "left for decision" in SG14). The `test:perf` budget passes (p95 24.08 ms at 10,206 symbols, limit 10).
- The candidate pool is `max(50, 8 × limit)`, so `limit 100` asks vec0 for k = 800 and FTS for 1,600 rows. The KNN's cost grows with k, so `limit 100` is 2.8–3.2× `limit 10` at every size. At the 10k-symbol scale its p95 sits at the budget (48.8–54.3 ms). That is A47-02.
- Lexical hits outside the KNN pool that can reach the top `limit` each need a vec0 point read (0.26–0.29 ms each). Limit 100 made 27–61 of them, and limit 10 made none. This is bounded by the pool.
- Both builds alike (search is unchanged since SG14).

## Graph export

### Whole graph (`atlas graph --out`, builds interleaved; load 1.2–1.6)

| Workload | Format | current | `68fb2c2` | Output | HWM |
| --- | --- | --- | --- | --- | --- |
| realistic 10k | JSON | 2.78 s | 2.64 s | 77.5 MB | 482 / 490 MB |
| | DOT | 2.64 s | 2.28 s | 20.6 MB | 446 / 445 MB |
| dense 10k | JSON | 6.66 s | 7.47 s | 169.2 MB | 1,011 / 1,019 MB |
| | DOT | 6.27 s | 5.31 s | 37.8 MB | 910 / 907 MB |
| **dense 3.5M edges** (load 1.0) | **JSON** | **exit 1 after 38.4 s: `atlas: Invalid string length`** | not run | none | **2,168 MB** |
| | DOT | 39.2 s | not run | 133.4 MB | 2,464 MB |

- Time and memory are linear, at about 1.1 KB of RSS per dense edge. The JSON body is one `JSON.stringify(graph, null, 2)` string. V8 caps a string at 2^29 − 24 characters, which is about 2.8M edges of the dense shape (192 bytes per edge, indented). Past that, the export fails after doing all the work, and it prints nothing else. That is A47-01. DOT's ~38 bytes per edge leaves room to about 14M edges, though it holds every row in memory too.

### Paging and scopes (`graphpage.mjs`, `hub.mjs`: in-process, as `/api/graph` and `atlas_graph` run; current)

| Workload (load) | Walk | Pages | Total | First / slowest page |
| --- | --- | --- | --- | --- |
| dense 10k (1.4) | unscoped, `limit 5000` | 21 | 5.0 s | 202 / 882 ms |
| realistic 10k (1.4) | unscoped, `limit 5000` | 31 | 2.2 s | 47 / 358 ms |
| dense 10k (1.4) | **`file: src`** (every file), `limit 5000` | 21 | **93.4 s** | **4,130 / 5,424 ms** |
| realistic 10k (5.5) | **`file: src`**, `limit 5000` | 24 | **18.1 s** | 1,185 / 1,185 ms |

- Unscoped pages read each edge once (pinned): paging is linear.
- A scoped page materialises every edge in its scope to count `totals.edges`, so walking a broad scope is quadratic in pages. This is A6-01 (open since AUDIT-6), now 4.1–5.4 s per page at dense 10k. A neighbourhood of the dense hub (`log`, 90,000 callers) takes 3.1 s at depth 1 and 5.2 s at depth 3 for one bounded page. The realistic hub takes 2–12 ms.

## Drift and docs on a cached index (`run.mjs`, `driftscale.mjs`; builds interleaved)

| Workload (load) | `atlas drift` current / `68fb2c2` | `atlas docs --offline`, cached: current / `68fb2c2` | First full generation current / `68fb2c2` |
| --- | --- | --- | --- |
| 10k symbols, 736 files (5.0–5.8) | 1.39–1.40 s | 1.08–1.16 s | 1.34 s |
| realistic 10k (4.0–6.0) | 11.6–12.5 / 11.5–13.1 s | 8.4–8.8 / 7.9–10.1 s | 12.9 / 12.2 s |
| dense 10k (2.6–5.5) | 19.4–20.9 / 19.0–19.4 s | 16.2–17.0 / 15.6–18.9 s | 24.9 / 21.6 s |

In-process (`driftscale.mjs`, current, load 4.5–5.0):

| Workload | Files | Public symbols | `detectDrift` | per file | cached `synthesizeDocs` | per file |
| --- | --- | --- | --- | --- | --- | --- |
| 10k symbols | 736 | 9,100 | 791–808 ms | 1.08–1.10 ms | 412–497 ms | 0.56–0.68 ms |
| realistic 10k | 10,501 | 130,101 | 9.0–11.6 s | 0.86–1.11 ms | 6.4–6.7 s | 0.61–0.64 ms |

- Both are linear in files, and in edges on the dense shape (pinned by work counts). The per-file neighbour query returns 1,758,838 rows (2 × edges) in 6.8 s over dense 10k. The slowest file is the hub at 479 ms.
- Where drift's time goes (CPU profile, realistic 10k): `mentions` 3.4 s, which compiles a lookbehind `RegExp` for each of the 130,101 public symbols. Then `getSymbolsForFile` 2.1 s (called twice per file, re-prepared each call) and `prepare` 1.4 s (`getSymbolsForFile`, `getImportsForFile` and `readFileFromRoot` use `db.prepare` rather than `prepareCached`). These are constant factors (no finding). Caching the statements and testing names against one tokenised set of the doc's identifiers would roughly halve drift.
- `test:perf` budgets (1,002 files, 5 symbols each): cached synthesis 179 ms, drift 391 ms (≤ 1 s each). At 10k realistic files both are 6–12 s, linear from the 1k budget.
- An offline docs or drift run is one synchronous block (the probe's timer never fired). With a real client, synthesis awaits the network and yields.

## `atlas serve` under concurrent clients (`serveconc.mjs`: realistic 10k with docs, a closed loop of N clients over 8 endpoints for 15 s; builds in turn)

| Clients (load) | Build | Requests / errors | stats p50 / p95 | search p50 / p95 | search `limit=100` | files | graph | docs list | graph `file=pkg1/` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (3.5) | current | 80 / 0 | 156 / 189 | 169 / 225 | 411 / 542 | 42 / 67 | 21 / 22 | 487 / 531 | 27 / 33 |
| | `68fb2c2` | 78 / 0 | 184 / 230 | 174 / 262 | 442 / 473 | 53 / 79 | 15 / 28 | 443 / 563 | 23 / 39 |
| 8 (3.4) | current | 92 / 0 | 565 / 1,729 | 1,706 / 3,645 | 1,272 / 3,618 | 917 / 3,229 | 595 / 1,767 | 1,828 / 2,793 | 738 / 5,544 |
| | `68fb2c2` | 91 / 0 | 726 / 2,808 | 1,143 / 3,366 | 1,538 / 3,501 | 1,028 / 2,908 | 982 / 1,936 | 2,015 / 3,595 | 911 / 6,417 |
| 32 (4.2–4.4) | current | 98 / 0 | 1,209 / 18,306 | 2,984 / 18,457 | 3,212 / 18,869 | 2,257 / 18,919 | 1,873 / 18,920 | 2,396 / 19,453 | 1,922 / 19,725 |
| | `68fb2c2` | 126 / 1 | 913 / 22,045 | 1,674 / 22,217 | 2,574 / 22,847 | 1,857 / 22,908 | 429 / 21,330 | 3,335 / 21,710 | 1,282 / 23,547 |

- The server handles one request at a time (every handler is synchronous SQLite and JSON), so throughput is fixed at about 5–6 requests per second for this mix, and latency grows with the queue. The builds are alike, with 0 errors on current. The one `68fb2c2` error at 32 clients was not captured.
- Peak RSS: 459–467 MB on both builds.
- With docs generated, `/api/stats` takes 156 ms against AUDIT-43's 2.4 ms with none, because `countDocs` walks the 10,502 files of `.atlas/docs` on every call (A6-05). `/api/docs` takes 487 ms and returns 1.8 MB (A6-04). `/api/doc/file/<id>` reads every doc to return one (A6-02, the same 446 ms through MCP below).
- Start: 278–441 ms (p50 385) against 279–419 (336) on a clean index. Beside the index's own 54 MB WAL: **1,368–1,592 ms (p50 1,438) against 278–372 ms**, because `68fb2c2` does not check a leftover WAL (A35-01; load 5.4–7.0).

## MCP tools (`mcplat.mjs`: `atlas mcp --offline` over stdio on realistic 10k with docs; 5 calls each; p50 / p95)

| Tool (args) | current (load 3.2) | `68fb2c2` (load 2.2) | Response |
| --- | --- | --- | --- |
| initialize | 357 ms | 334 ms | |
| `atlas_search` | 140 / 160 | 137 / 169 | 2 KB |
| `atlas_search {limit: 100}` | 387 / 532 | 440 / 463 | 26 KB |
| `atlas_symbol` | **727 / 911** | 937 / 1,060 | 1 KB (A2-08: reads every symbol and file) |
| `atlas_graph` (default page) | 15 / 20 | 16 / 22 | 285 KB |
| `atlas_graph {file: pkg1/}` | 31 / 38 | 26 / 29 | 86 KB |
| `atlas_graph {symbol, depth: 3}` | 8 / 12 | 9 / 11 | 127 KB |
| `atlas_drift` (first page) | **7,562 / 10,398** | 7,534 / 10,975 | < 1 KB (A6-03: each page re-runs drift) |
| `atlas_docs` (list) | 456 / 590 | 488 / 511 | 1.8 MB (A6-04) |
| `atlas_docs {target}` | 446 / 598 | 416 / 440 | 2 KB (A6-02) |

The builds are the same. `atlas_drift` blocks the session for 7.5–11 s per page, and a dense index would take 19–21 s per page.

## Many concurrent CLI openers (`conccli.mjs`: N `atlas search 'account total'` processes started at once on realistic 10k; 2 rounds, builds interleaved)

| N (load) | current p50 / max | `68fb2c2` p50 / max | Errors |
| --- | --- | --- | --- |
| 1 (1.2) | 468–544 ms | 518–595 ms | 0 |
| 8 (1.2–2.1) | 1,541 / 1,579–1,580 ms | 1,397–1,649 / 1,512–1,760 ms | 0 |
| 32 (2.1–11.4) | 5,646–5,943 / 5,820–6,229 ms | 5,608–5,620 / 5,744–5,774 ms | 0 |

- Each search costs about 0.5 s of CPU at this size, so 32 processes on 4 vCPU take 5.6–6.2 s. The builds are the same.
- A read-only open (in a fresh process) takes 6.2–8.5 ms on both builds. Beside a live writer holding a few-KB WAL, it takes 8.3–9.3 ms (A35-03's `/proc/locks` read, cheap on this host's lock table today).

## Findings

Counts: **Critical 0, High 0, Medium 1, Low 1** (new). No SG rows. Every budget holds: search p95 24.08 ms at 10,206 symbols, no-op re-index 14–19 ms per 100 files, cached synthesis 179 ms and drift 391 ms at 1k files, parse+insert 4.03 ms per file, and the resolver 602 ms per 1k files. Index runs, search, graph export, drift, docs, `atlas serve`, MCP and 32 concurrent CLI openers are within noise of `68fb2c2` (pre-SG120), so the WAL series (SG120–SG190) adds nothing to them outside the leftover-WAL cases already filed. Drift and cached docs are linear in files and edges. Search is linear in symbols. Unscoped graph paging is linear.

### Medium

#### A47-01: `atlas graph` builds the whole export as one in-memory string, so past about 2.8M edges the JSON export fails with `Invalid string length` after doing all the work, at 2.2 GB RSS

- **Evidence:**
  - Dense 10k (879,419 edges): JSON takes 6.7 s, writes 169 MB and peaks at 1.0 GB RSS. DOT takes 6.3 s, writes 38 MB and peaks at 0.9 GB.
  - With the edges inserted twice more (3,517,676), `atlas graph --out g.json` exits 1 after **38.4 s** with `atlas: Invalid string length`. It writes nothing and peaks at **2,168 MB**. DOT still works there (133 MB, 39.2 s), at 2,464 MB.
  - The realistic shape uses 336 bytes of JSON per edge, nodes included (77.5 MB for 230,352 edges), so the cap falls around 1.5M edges, or about 70k files at this shape's 22 edges per file. The dense shape reaches it near 32k files.
  - The message names neither the graph nor a remedy (`--limit`/`--offset` paging works, and is linear unscoped: 21 pages of 5,000 nodes in 5.0 s at dense 10k).
  - `test/audit/audit-47.test.ts` A47-01 (`it.fails`): the JSON export of a 600-function index (310 KB) is written in pieces of at most 64 KiB. Today it is one 309,817-character write (pinned by the precondition test).
- **Repro:** `node <a47>/scripts/run.mjs <a47>/logs/graph.jsonl cur $PWD/dist <big> -- graph --out <a47>/g.out`, where `<big>` is a copy of a dense 10k project whose `edges` rows were doubled twice (`INSERT INTO edges(src_symbol,dst_symbol,kind,weak,meta) SELECT src_symbol,dst_symbol,kind,weak,meta FROM edges`) · `npx vitest run test/audit/audit-47.test.ts`
- **Cause:** `src/cli/commands/graphCmd.ts:57` renders `JSON.stringify(graph, null, 2) + '\n'` (or `graphToDot(graph)`, which joins every line, `src/core/graph/export.ts:207`) and writes it with one `writeFileSync`/`stdout.write` (`:59`). `buildGraphJson` (`export.ts:76`) first loads every node and edge row, with its parsed `meta`, into arrays.
- **Fix:** Stream the CLI export. Write the header, then the nodes and edges in pages from `buildGraphJson`'s unscoped paging (`ORDER BY id` with `edgesFromRange`, already linear), one serialised row or page per write, and the `totals` at the end. That bounds memory by the page and removes the string cap. The bounded HTTP and MCP paths do not change.
- **Severity:** Medium. It is a hard failure with no output on large graphs, after all the work has been done. It is not High: the workaround is documented in `--help` (`-n/--offset`), DOT works further, and the sizes are a large monorepo (about 32k files of the dense shape, or 70k realistic).

### Low

#### A47-02: the search candidate pool is `8 × limit`, and vec0's brute-force KNN cost grows with k, so `limit 100` costs 2.8–3.2× `limit 10` (p95 48.8–54.3 ms at 10k symbols, on the 50 ms budget; 401–471 ms p50 at realistic 10k)

- **Evidence:**
  - At 10k symbols (limits interleaved with `68fb2c2`, 2 × 60 runs, load 1.4–1.5), the p95 is 15–19 ms at limit 10, 22–26 at 25, 31–36 at 50 and **48.8–54.3 ms at 100**. The budget (≤ 50 ms) is measured at limit 10 in `test:perf`. `limit` is 1–100 on every surface.
  - At realistic 10k, the p50 is 139–145 ms at limit 10 and **401–471 ms** at limit 100. Through `atlas serve` it is 169 against 411 ms, and through MCP 140 against 387 ms. At dense 10k it is 93–121 against 337–410 ms.
  - vec0 KNN alone at realistic 10k takes 115 ms at k = 10, 127 at k = 50 (limit ≤ 6), 357 at k = 800 (limit 100) and 531 at k = 4,096.
  - Limit 100 also fetches 1,600 FTS rows and makes 27–61 vec0 point reads for lexical contenders.
  - `test/audit/audit-47.test.ts` A47-02 (`it.fails`): a search at limit 100 asks vec0 for at most 2 × limit (200) neighbours. Today it asks for 800 (and 80 at limit 10, pinned).
- **Repro:** `node <a47>/scripts/limitbench.mjs <r700> 60 cur=$PWD/dist base=<a47>/ab-68fb2c2/dist` · `node <a47>/scripts/knnparts.mjs $PWD/dist <r10k>` · `npx vitest run test/audit/audit-47.test.ts`
- **Cause:** `src/core/vector/search.ts:53` sets `poolSize = max(50, limit * 8)` (capped at 4,096), which is used as vec0's `k` (`:57-66`, `store.ts` `vectorKnn`) and twice over as the FTS fetch (`ftsIds`). sqlite-vec keeps a top-k per chunk and merges them, so each of the 141 chunks pays for k.
- **Fix:** Decouple the pool from `limit`: for example `max(50, 2 × limit)` or `limit + 50`, measuring recall on the golden search fixtures. Or keep 8× only for the lexical lists, which are cheap, and cap the KNN pool.
- **Severity:** Low. The default limit (10) is unaffected and the budget holds there. Limit 100 is on the budget at 10k symbols, and A2-02's linear cost (left for decision in SG14) dominates at 150k symbols.

### Open from AUDIT-43, AUDIT-40, AUDIT-35, AUDIT-22 and earlier (re-checked against `68fb2c2` where it differs)

The `it.fails` tests for A22-01, A22-02, A35-01 (×2), A35-02, A40-01, A40-02, A43-01 (×2) and A43-02 still fail as expected on current. `npx vitest run test/audit/audit-22.test.ts test/audit/audit-35.test.ts test/audit/audit-40.test.ts test/audit/audit-43.test.ts`: 4 files, 25 tests pass, 4.5 s at load 10.6–11.5.

| ID | AUDIT-43 | Now | Status |
| --- | --- | --- | --- |
| A43-01 every open beside a matching set-aside WAL runs `inUse` | 5.7 → 22.2 ms per open | `it.fails` ×2 stand (3 `/proc/locks` reads; without them 3 lock takes and 3 probes); `src/` unchanged | Open (Low), unchanged |
| A43-02 an idle `atlas serve` keeps a writer's WAL | 27.9 MB WAL, serve start 1.28–1.45 s | `it.fails` stands (3 checks for 3 opens); `src/` unchanged | Open (Low), unchanged |
| A40-01 a failing WAL is checked twice plus a full read | 191 / 186 ms | `it.fails` stands; not re-timed (`database.ts` unchanged) | Open (Low), unchanged |
| A40-02 refused opens repeat the decision | 8 concurrent 1.73 s | `it.fails` stands; not re-timed | Open (Low), unchanged |
| A35-01 read-only opens repeat a passing check | serve start beside its own 54 MB WAL 1,339 ms | **1,368–1,592 ms (p50 1,438)** against `68fb2c2`'s 278–372 ms (no check) and 278–441 ms on a clean index; `it.fails` ×2 stand | Open (Low), unchanged |
| A35-02 signals wait for the current block | dense `--force` 14.5 s | `it.fails` stands; dense fresh resolve block **15.29 s** (`68fb2c2` 13.08 s), realistic 6.63 s; an offline `atlas docs` or `drift` at dense 10k is one 16–21 s block | Open (Medium), unchanged |
| A35-03 `holders()` per open beside a live writer | 23–26 against 8–10 ms | 8.3–9.3 against 6.2–8.5 ms with no writer (both builds; few host locks today) | Open (Low), unchanged in code |
| A22-01 resolve is one block | realistic 5.11 s, dense 12.9 s | realistic fresh **6.63 s** (6.70), one edit 5.21 s (4.88), dense fresh 15.29 s (13.08) | Open, unchanged |
| A22-02 carry quadratic in same-name symbols | `it.fails` stands | `it.fails` stands (not re-timed) | Open, unchanged |
| A22-03 a second writer fails after 5 s | one `docs` run failed beside `index --force` | dense `atlas index --force` with `atlas docs --offline` every 4 s: **1 of 9** docs runs failed after 20.5 s with `atlas: docs write: database is locked (another process is writing the index; retry when it finishes)` | Open (Medium), unchanged |
| A22-04 embed source cache unbounded | not re-timed | realistic 10k fresh with `--max-old-space-size=200`: **`FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory`** after 94 s (exit 134); HWM without the cap 516–528 MB | Open, unchanged |
| A22-05 embed setup block | 0.86–0.93 s | no-op longest block **0.90–1.09 s** (`68fb2c2` 1.01–1.06 s) | Open (Low), unchanged |

Also re-measured in passing (open, not re-rated): A6-01 scoped graph totals, now 4.1–5.4 s per `/api/graph?file=src` page at dense 10k and 93 s to page through it; A6-02, A6-03 (`atlas_drift` 7.5–11 s per page), A6-04 and A6-05 (`/api/stats` 156 ms with 10,502 persisted docs); A2-02 (search linear in symbols); A2-07 (every edit re-resolves the graph); A2-08 (`atlas_symbol` 727–937 ms).

## No finding

- **Indexing:** fresh, no-op, 1 and 100 edits, and 525 deletions are within noise of `68fb2c2` on realistic and dense 10k. Budgets hold.
- **Search:** the default limit is within budget (p95 24 ms at 10k symbols). Filters apply before truncation at the cost of one scan of `symbols` (`file: zzzz` 67 ms at realistic 10k). Point reads for lexical contenders are bounded by the pool.
- **Graph:** the bounded HTTP and MCP pages are fast (15–31 ms default and narrow scopes). Unscoped paging reads each edge once (pinned).
- **Drift and cached docs:** linear (work-count pins at 20 and 40 files; per-file times equal at 736 and 10,501 files). Constant factors are listed above.
- **`atlas serve`, MCP and concurrent CLI openers:** no errors on current. Latency is the single-threaded queue and is the same on both builds.

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a47>` is `<scratch>/audit-47`. The scripts are in `<a47>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first). The raw output is in `<a47>/logs/`.
- `run.mjs <log> <label> <dist> <cwd> -- <args>`: one CLI run under `probe.mjs` (from AUDIT-40), with the load before and after.
- `searchbench.mjs <dist> <root> <reps>`: in-process search by query shape, counting statement executions.
- `limitbench.mjs <root> <reps> <label=dist>…`: p50/p95 by limit, builds interleaved.
- `knnparts.mjs <dist> <root>`: vec0 KNN by k, and point reads.
- `graphpage.mjs <dist> <root> <limit> [file]`: page through `buildGraphJson`. `hub.mjs <dist> <root>`: neighbourhood of the busiest symbol.
- `driftscale.mjs <dist> <root>…`: in-process `runDrift` and cached `synthesizeDocs`. `nplan.mjs <db>`: the neighbour query's plan, and its cost over every file.
- `serveconc.mjs <root> <clients> <s> <label=dist>…`: `atlas serve` under N closed-loop clients. `mcplat.mjs <root> <reps> <label=dist>…`: MCP tools over stdio.
- `conccli.mjs <root> <n> <reps> <label=dist>… -- <args>`: N CLI processes at once. `besidemcp.mjs <root> <n> <label=dist>…`: a read-only open with and without a live writer.
- `startup.mjs` and `mkwal.mjs` (from AUDIT-40, repointed): serve start beside an own-WAL image. `writers.sh <dist> <root> <log>`: A22-03.
- Every process these scripts started exited or was killed by them, and `ps` found none left. The 10k indexes, the images and the 3.5M-edge copy were deleted afterwards.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-47.test.ts` | A47-01 (`it.fails`): `atlas graph` (in-process, JSON to stdout) on a 600-function index writes no piece above 64 KiB. Today it makes one 309,817-character write (pinned by the precondition test). A47-02 (`it.fails`): a search at limit 100 asks vec0 for at most 200 neighbours. Today it asks for 800, and 80 at limit 10 (pinned). Plain tests: unscoped graph paging reads each edge row once; doubling the files at most doubles (×2.2) drift's statement executions and rows, and a cached synthesis run's executions. It counts work and times nothing. About 0.9 s. Each `it.fails` was confirmed to fail as a plain `it` on its defect assertion (`expected 309817 to be less than or equal to 65536`, `expected 800 to be less than or equal to 200`). |

## Verification

`npm run typecheck && npm run lint && npx vitest run test/audit/audit-47.test.ts && npm run test:perf` passes (rc 0) in **39.0 s** in all at load 3.25–3.38. `audit-47`: 7 tests pass. `test:perf`: 5 files and 9 tests pass, with search p95 24.08 ms at 10,206 symbols (budget 50 ms), cached synthesis 179 ms and drift 391 ms at 1,002 files, parse+insert 4.03 ms per file, no-op re-index 14.4 ms per 100 files, and resolver 602 ms per 1k files.
