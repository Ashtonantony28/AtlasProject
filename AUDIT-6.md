# AUDIT-6: performance under load (round 2)

Auditor: a fresh subagent that wrote none of the audited code. Base: `1e804ae` (SG14–SG17 merged), branch `claude/atlas-audit-6`.
Machine: 4 vCPU, 16 GiB RAM, Node 22. Another auditor ran in `atlas-audit-5` at the same time. The 1-minute load average is given with each group of runs. Each timing is a median of several runs unless the cell says otherwise.

| Runs | Load average (1 min) |
| --- | --- |
| `bench.mjs`, 5 rounds × 4 targets | 0.71 to 1.02 |
| `audit-perf.mjs --gen 700`, ×3 | 1.42 to 2.36 |
| `audit-perf.mjs --gen 10000`, 1 run | 0.73 at start, 5.59 at end |
| `audit2-reindex.mjs` (1k / 3k / 10k) | 3.40 / 4.95 / 1.79 |
| `audit-load.mjs` and `audit2-load.mjs` at 10k | 2.90 |

The 10k `audit-perf` run ended at load 5.6 for a specific reason. While it ran, one of my own memory probes (`audit2-memory.mjs parse`, 3000 iterations) hit the 16 GiB cgroup limit. The OOM killer stopped that probe and a concurrent `audit-scaling.mjs force … 4000` run. I reran the scaling probe alone without the 4000 size, and that rerun is what the tables report. The script's default is now 200 iterations, with a warning in its header.

## Workloads

| Name | Source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| express | `expressjs/express` @ `0dee2c5` | 141 | 2,052 | 1,554 |
| got | `sindresorhus/got` @ `05b4476` | 96 | 5,752 | 5,004 |
| Atlas self | this worktree | 156 | 1,913 | 4,403 |
| synthetic10k | `bench.mjs --target synthetic10k` | 202 | 10,206 | 0 |
| realistic 700 | `scripts/audit-repo.mjs` (700) | 736 | 10,536 | n/a |
| realistic 1k / 3k | `scripts/audit-repo.mjs` | 1,051 / 3,151 | 15,051 / 45,151 | 23,032 / 69,072 |
| realistic 10k | `scripts/audit-repo.mjs` (10000) | 10,501 | 150,501 | 230,352 |

## Budget table (frozen §Interfaces / SG6)

| Budget | Measured | Result | Reproduce |
| --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express, Atlas) | express **2.25** (2.05–2.42, 5 runs); Atlas self **2.69** (2.45–3.20) | PASS | `node scripts/bench.mjs --target <express>` · `--target self` |
| (same, other targets) | got **4.60** (3.93–5.26; 1 run of 5 over 5); realistic 700 **2.96**; realistic 10k **3.40**; synthetic10k **5.86** (5.75–6.39) | PASS, got marginal; synthetic10k over (not a frozen target) | `bench.mjs --target <got>` · `--target synthetic10k` · `audit-perf.mjs --gen 10000` |
| no-op re-index ≤ 100 ms / 100 files | express **13.5**; self **11.9**; got **48.4**; synthetic10k **48.6**; realistic 10k **11.4–16.2** (1,193–1,697 ms total) | PASS | `bench.mjs` · `audit2-reindex.mjs --gen 10000` (`noop`) |
| `search` p95 ≤ 50 ms at 10k symbols | realistic 10.5k symbols **17.85** (15.86 / 17.85 / 17.95); synthetic10k **26.49** (19.67–28.38) | PASS | `audit-perf.mjs --gen 700 --skip docs,drift,ask` (×3) · `bench.mjs --target synthetic10k` |
| (known, deferred: 150k symbols) | p95 **218.65** (p50 144.6); exact 171, phrase 200, kind 242, file 189 | known (exact vec0 KNN, approximate KNN pending decision) | `audit-perf.mjs --gen 10000` (`search.all`) |
| resolver ≤ 2 s / 1k files | realistic 10k **0.49 s/1k** (5.14 s); reindex probe 0.43 s/1k (4.56 s); 3k 0.47; 1k 0.52 | PASS | `audit-perf.mjs` (`resolverMsPer1kFiles`) · `audit2-reindex.mjs` (`resolverMs`) |
| cached docs ≤ 1 s / 1k files | core `synthesizeDocs` realistic 10k **0.46 s/1k** (4.81 s); CLI `atlas docs --offline` (process start plus export of 10.5k `.md` files) 8.66 s = **0.82 s/1k** | PASS | `audit-perf.mjs --gen 10000` (`docs.cachedMs`) · `atlas docs --offline` in the 10k repo |

**No frozen budget fails.** Three margins are thin:
- got parse+insert: 1 run in 5 measured 5.26 ms/file, even at load 0.7.
- CLI cached docs at 10k files: 0.82 s/1k.
- drift (no budget): 1.09 s/1k files in-process (11.4 s), 10.3 s through the CLI.

## Re-check of AUDIT-2 findings after SG12–SG17

| ID | Was | Now | Status |
| --- | --- | --- | --- |
| A2-01 docs/drift O(files × call edges) | 7.1 s cached docs at 1k; 987 s at 10k | Cached docs 4.81 s at 10k (0.46 s/1k); drift 11.4 s (1.09 s/1k), linear. `test/audit/query-plan.test.ts` still pins the `idx_edges_kind` plan as `it.fails`. | **Fixed for the budget** (SG12). The plan pin remains. |
| A2-02 search linear in symbols | p95 247 ms at 150k; 50 parallel HTTP searches 8.8 s wall | p95 218.65 ms at 150k, 17.85 ms at 10.5k. 50 parallel HTTP searches: 7.0 s wall, p95 6.67 s. | **Improved**; known and deferred (ANN decision). |
| A2-03 vec0 `rowid IN` deletes | Forced re-index excess over a fresh index 1.6 / 4.0 / 15.5 s at 500 / 1k / 2k | Excess **1.05 / 2.18 / 4.77 s** (k ≈ 1.1–1.13); forced 3.59 / 7.90 / 15.41 s against fresh 2.54 / 5.72 / 10.65 s | **Fixed** (SG14) |
| A2-04 unbounded MCP responses | `atlas_drift` 29.6 MB plus disconnect; `atlas_graph` 88 MB | `atlas_drift` 0.24 KB (6.2 s); `atlas_graph` 0.27 MB (21 ms); no disconnects | **Fixed** (SG15). `atlas_docs` list is still unbounded (A6-04). |
| A2-05 parse+insert on express/got | express 5.14, got 8.28 ms/file | express 2.25, got 4.60, self 2.69 | **Fixed** (SG16). got is marginal; synthetic10k is 5.86. |
| A2-06 indexing RSS not released | 2,118 MB after a 10k index; 2.5 GB peak | 2,130 MB after a 10k index; 2.82 GB peak (`audit-perf`); **3.95 GB** high-water mark after about 22 re-index runs in one process | **Unchanged.** Cause narrowed (see below). |
| A2-07 every incremental re-index rebuilds the graph | One-file edit 0.60 / 1.60 / 5.89 s at 1k / 3k / 10k | edit1 **0.96 / 1.90 / 5.63 s**; edit100 at 10k 6.57 s; resolver 4.56 s and embedAll no-op 0.83 s of every run | **Unchanged** |
| A2-08 Q&A and `atlas_symbol` load the whole index | retrieve 1.53 s; MCP ask p50 1.72 s; symbol p50 839 ms | retrieve 1.85 s; MCP ask p50 1.37 s; symbol p50 711 ms (766 ms for a 10k-match name) | **Unchanged** |
| A2-09 dashboard materialises the index | `/api/graph` 47 MB / 2.3 s; `/api/stats` 1.33 s; serve RSS 818 MB | `/api/graph` 0.24 MB / 18 ms; a search during `/api/graph` takes 153 ms; `/api/stats` **260 ms** (A6-05); serve RSS 160 MB (default pages), 526 MB high-water mark under scoped queries | **Fixed** for the default page. Scoped and doc paths regress (A6-01, A6-02). |
| A2-10 quadratic embed text in big files | Embed 208 / 1,366 / 13,040 ms at 1k / 3k / 9k functions | 159 / 1,080 / **11,592 ms** | **Unchanged** |
| A2-11 per-row prepares; unbounded `/api/stats` | — | Inserts, deletes and search use `prepareCached`. `readFileFromRoot` still prepares per call (`src/core/vector/textForSymbol.ts:66`). | **Mostly fixed** |
| A2-12 harness cannot see graph costs | — | `test/synth/perf.test.ts` and `bench.mjs` still use the 0-edge `synthetic-repo.mjs` | **Unchanged** |

### A2-06: what the leak is

Tree-sitter 0.21.1 frees a `Tree` only through a GC finalizer. The finalizer reports no external memory to V8, so V8 has no pressure to collect the small JS wrappers, and the native trees accumulate.

- Raw tree-sitter loop, no Atlas code (`parser.parse` on got's 125 KB `source/core/options.ts`): RSS goes from 56 to 520 MB after 200 parses, and stays there after `gc()` and 100 ms of idle event loop. With natural GC and a 1 ms timer per parse, RSS plateaus at about 777 MB after about 350 parses.
- Atlas `parseSource` on the same file: about 3.5 MB per parse. The pre-SG16 (`51bbe95`) and pre-SG14 (`c7badd5`) builds give 3.7 MB per parse, so **SG16's cursor walk and prototype patching did not regress memory**.
- In-process re-index cycles (300 files edited per cycle, `gc()` between cycles): about 50 MB of `RssAnon` per cycle, linear. It is not returned after `closeDatabase`. The JS heap stays at about 11 MB.
- A long-lived `atlas mcp` server on a 1k-file repo, calling `atlas_index` with `force: true` 5 times: 345 → 373 → 379 → 394 → 426 → 422 MB (about 12 MB per call). It grows slowly under natural GC; no OOM.

Reproduce:

```
node --expose-gc scripts/audit2-memory.mjs parse <got>/source/core/options.ts 200
node --expose-gc scripts/audit2-memory.mjs reindex $W 1000 10 300
node scripts/audit2-mcp-index.mjs $W 1000 6
```

Severity stays Medium. A one-shot CLI index costs about 0.2 MB per file. The risk is a process that parses for a long time: `audit-scaling force` reached 7.5 GB RSS after about 21k parses in one process. The likely fix is in the dependency, not in Atlas code. A tree-sitter release with `Tree.delete()` or external-memory accounting would allow freeing each tree after `extract`. The 0.21 pin is a recorded decision (DECISIONS 2026-05-20).

## Incremental and mass re-index (`scripts/audit2-reindex.mjs`)

Times in ms. "Branch switch" means 30% of files edited, 5% deleted and one package directory renamed.

| Files | noop | edit1 | edit10 | edit100 | add1 | delete1 | branch switch (files indexed / removed) | switch back | fresh-index share of the switch | RSS high-water mark |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,051 | 178 | 957 | 778 | 2,123 | 587 | 636 | 5,239 (327 / 67) | 4,443 | 3,329 | 656 MB |
| 3,151 | 359 | 1,904 | 1,902 | 2,826 | 1,707 | 1,780 | 11,490 (957 / 172) | 12,008 | 7,646 | 1,350 MB |
| 10,501 | 1,193 | 5,630 | 5,928 | 6,575 | 5,700 | 5,781 | 31,152 (3,162 / 539) | 33,538 | 17,840 | 3,969 MB |

- A branch switch costs 1.5–1.75× a fresh index of the changed files at every size. The extra is the fixed resolver plus embedAll pass (about 5.4 s at 10k files) and point deletes. **Growth is linear: no super-linear mass-change path remains.** Before SG14, A2-03 made this quadratic.
- Any change at all costs at least the full-repo resolver plus embedAll scan (A2-07). Edit size barely matters below about 100 files.

## Load at 10k files (`scripts/audit-load.mjs`, `scripts/audit2-load.mjs`)

The target was the realistic 10k repo after `atlas index` and `atlas docs --offline`, so 10,502 docs are in the index and in `.atlas/docs`. `step0` is a method name shared by 10,000 symbols.

| Request | HTTP ms (size) | MCP ms (size) |
| --- | --- | --- |
| search | 136 | 134 |
| graph, default page | 16.5 (241 KB) | 21 (0.27 MB) |
| graph `file=pkg1/` (narrow) | 22 | — |
| graph `file=src` (broad), page 1 / page 2 | **958 / 863** (230 KB) | **885** |
| graph `symbol=step0` depth 1 / depth 3 | **460 / 1,433** | **1,467** (depth 3) |
| doc list | **413 (1.66 MB)** | **476 (1.84 MB)** |
| one doc (`/api/doc/file/:id`, `/api/doc/architecture`, `atlas_docs {target}`) | **382 / 410** | **384** |
| `/api/stats` | **260** | — |
| `/api/files` | 40–72 (2.0 MB) | — |
| `atlas_symbol` (hub name) | — | 711–766 |
| `atlas_ask` | — | p50 1,367 |
| `atlas_drift` page 0 / `offset=5000` | — | **6,183 / 6,264** (0.24 KB) |
| search sent while a drift call runs | — | **6,248** (drift 6,100) |
| 20 searches queued with 4 broad graph pages and 4 doc fetches | wall 7.57 s; search **p50 6.18 s, p95 7.43 s** | — |
| server RSS / high-water mark | 497 / 526 MB | 708 / 708 MB |

No request errored and no client disconnected. Every single request is now bounded in size. The cost per request is what still scales with the repo: several bounded endpoints do work proportional to the whole index or the whole docs directory. Because SQLite calls are synchronous, every concurrent request queues behind that work.

## Findings

Counts: **Critical 0, High 0, Medium 5, Low 1.**

No frozen budget fails in isolation (A6-06 covers a flake under suite load). None of the new paths below is super-linear; each is linear in the repository on a request that should cost O(page). None breaks a client at the measured scale. So none meets the High bar.

### Medium

#### A6-01: Scoped graph pages compute `totals.edges` by materialising every edge in scope
- **Evidence:**
  - At 10k files, `/api/graph?file=src&limit=1000` takes 958 ms and page 2 takes 863 ms. The narrow `file=pkg1/` takes 22 ms and the unscoped default 16.5 ms.
  - `symbol=step0` costs 460 ms at depth 1 and 1,433 ms at depth 3, over HTTP and over MCP (1,467 ms).
  - The response stays about 240 KB, so the cost does not depend on `limit`.
  - Four such requests delay 20 concurrent searches to p50 6.2 s.
  - `test/audit/audit-6.test.ts` (A6-01) shows that a 1-node, 1-edge page of a 40-file repo reads 119 edge rows, which is every edge.
- **Repro:** `node scripts/audit2-load.mjs <indexed 10k repo>` (`http.graphFileBroad`, `graphHubDepth3`, `mixedBurst`). The test is `npx vitest run test/audit/audit-6.test.ts`.
- **Cause:**
  - `src/core/graph/export.ts:83`: when the page is smaller than the scope, `totalEdges = edgesWithin(db, scope).length`. That passes the whole scope (up to 150k ids) through `json_each` twice, materialises every incident edge in JS, and filters it (`:142-158`), just to count.
  - `scopeIds` (`:106-122`) also loads every in-scope id and sorts it in JS before slicing a page.
  - `neighbourhood` (`:125-139`) expands every symbol with the given name. A common name such as `step0`, `constructor` or `__init__` therefore seeds thousands of nodes.
  - Possible fixes: count with one SQL `COUNT(*)` over a temp table of scope ids; page the ids in SQL (`ORDER BY id LIMIT/OFFSET`); cap the neighbourhood seed or frontier (and say so in `truncated`).

#### A6-02: Fetching one doc reads and parses every doc (index plus `.atlas/docs`)
- **Evidence:**
  - At 10,502 docs, a single doc costs 382 ms (`/api/doc/file/:id`), 410 ms (`/api/doc/architecture`) and 384 ms (MCP `atlas_docs {target}`). The response is about 1.3 KB.
  - The dashboard issues one of these on every file click (`src/web/static/app.js:62`) and one on every load (`:24`).
  - The A6-02 test reads 41 `.md` files to find 1.
- **Repro:** `node scripts/audit2-load.mjs <repo>` (`http.docFile`, `http.docArchitecture`, `mcp.docsTarget`), and the test above.
- **Cause:**
  - `src/web/server.ts:77-78`: `docFor` calls `listDocs(db, docsDir).find(...)`.
  - `src/core/synth/persist.ts:187` (`findDoc`) does the same.
  - `listDocs` (`:158-163`) reads and parses every persisted `.md` file (`readPersistedDocs`, `:127-135`) and loads every doc row with content (`docsFromDb`, `:72-80`).
  - `/api/doc/file/:id` also loads every file row to map one id (`server.ts:134`).
  - Possible fix: look up the index row by target, and read only `relPathFor(target)` as the fallback.

#### A6-03: Each drift page re-runs the full drift detection, and blocks the MCP server meanwhile
- **Evidence:**
  - At 10k files, `atlas_drift` takes 6.18 s for page 0 and 6.26 s at `offset=5000` for a 0.24 KB response.
  - A search sent right after it waits 6.25 s.
  - Paging through a report of U undocumented symbols at the maximum `limit` of 1000 costs ⌈U/1000⌉ × 6 s. A2-04 measured 100k+ undocumented at 10k files, which would be about 10 minutes of serial, server-blocking calls to read the whole list.
- **Repro:** `node scripts/audit2-load.mjs <repo>` (`mcp.driftPage0`, `driftPageDeep`, `searchBehindDrift`).
- **Cause:**
  - `src/mcp/server.ts:202-211` calls `pageDriftReport(runDrift(...), page)`. `pageDriftReport` (`src/core/drift/detect.ts:168-183`) slices the complete report after `detectDrift` has hashed every module neighbourhood.
  - `runDrift` is synchronous, so the stdio server handles nothing else meanwhile.
  - Possible fixes: memoise the report per index state (the latest `runs.id` plus the docs version), or compute `undocumented` with a paged SQL query.

#### A6-04: `atlas_docs` and `/api/docs` lists are unbounded and walk every doc
- **Evidence:**
  - At 10,502 docs, the list is 1.84 MB over MCP (476 ms) and 1.66 MB over HTTP (413 ms). It is linear in files, about 175 bytes per doc.
  - SG15 bounded `atlas_graph` and `atlas_drift` for the SDK's 10 MiB stdio frame limit. This list reaches 10 MiB at about 57k files (extrapolated, not measured), which would reproduce A2-04's disconnect for the doc list.
  - Each call also reads every doc body only to report `chars`.
- **Repro:** `node scripts/audit2-load.mjs <repo>` (`mcp.docsList`, `http.docsList`).
- **Cause:** `src/mcp/server.ts:214-223` and `src/web/server.ts:113-125` map `listDocs(...)` with no `limit`/`offset`. Possible fix: page it with `limit`/`offset` and `totals`, like `driftParams`.

#### A6-06: The 50 ms search p95 gate in `test/vector/hybrid.test.ts` flakes under the full suite
- **Evidence:** run alone it measures 22–28 ms. Under `npm test` (parallel workers) it usually measures 32–34 ms, but 2 of 6 full runs went over 50 ms and failed (one at 977 ms total test time). A frozen budget that fails on load rather than on a regression blocks unrelated PRs.
- **Repro:** `for i in 1 2 3 4 5 6; do npm test 2>&1 | grep -E "search p95 at|Tests "; done`
- **Cause:** the latency loop shares 4 vCPUs with the other vitest workers. Possible fix: run budget tests in a separate serial vitest project (`npm run test:perf`, also in CI), with warm-up, keeping the 50 ms limit unchanged.

### Low

#### A6-05: `/api/stats` walks `.atlas/docs` on every call (260 ms at 10k files)
- **Evidence:** SG15 recorded `/api/stats` at 6 ms at 10k files. With the docs exported, as after `atlas docs`, it is **260 ms**, and the dashboard calls it on every load.
- **Repro:** `node scripts/audit-load.mjs <repo with .atlas/docs>` (`httpStatsMs`).
- **Cause:**
  - `src/core/synth/persist.ts:166-185`: `countDocs` runs a `readdirSync` walk of the whole docs tree (10.5k files) plus a `Set` union, per request.
  - `src/web/server.ts:92` calls it.
  - The cost is linear and small, but the work is redundant, since `counts(db)` already has the doc count when the index is complete.

## No finding

- **SG14:** `prepareCached` memoises per connection in a `WeakMap`. Every cached SQL text comes from a bounded set (term count ≤ `MAX_TERMS`, plus fixed kind and file filter shapes), so the cache cannot grow without bound. Point deletes are linear (A2-03 above). The search paths are within budget at 10k symbols.
- **SG16:** the prototype `type` cache is per grammar class (bounded). The cursor walk does not change memory; the same per-parse retention is seen on the pre-SG16 build.
- **SG17:** the walker report adds one array. The unreadable-path loop in `indexer.ts:84-91` is O(unreadable × indexed). It is practically unreachable, because symlinks are skipped and a read as root rarely fails.
- **Mass changes and `--force`:** linear at 1k / 3k / 10k files (table above).
- **Concurrency:** 50 parallel HTTP searches and mixed bursts produce no errors and no disconnects. They only queue (A2-02, A6-01, A6-02).

## Files added

| File | What it does |
| --- | --- |
| `scripts/audit2-reindex.mjs` | noop, edit1/10/100, add1, delete1, branch switch and back, resolver and embedAll floor, RSS high-water mark |
| `scripts/audit2-load.mjs` | scoped graph, doc lookups, doc lists, drift paging, head-of-line and mixed bursts, server memory (HTTP and MCP) |
| `scripts/audit2-memory.mjs` | parse-loop and re-index-cycle RSS growth (anon vs file), with `--expose-gc` |
| `scripts/audit2-mcp-index.mjs` | RSS of a long-lived `atlas mcp` across repeated forced `atlas_index` calls |
| `test/audit/audit-6.test.ts` | `it.fails` pins for A6-01 (edge rows read for a 1-node page) and A6-02 (`.md` reads for one doc). About 0.3 s. |

All scripts require `npm run build`. Use a fresh work dir (`W=$(mktemp -d)`).
