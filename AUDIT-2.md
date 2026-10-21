# AUDIT-2: performance under load

Auditor: a fresh subagent that wrote none of the audited code. Base: `f25ab12` (SG9 merged), branch `claude/atlas-audit-2`.
Machine: 4 vCPU, 15 GiB RAM, Node 22.22.0. Another auditor ran concurrently, so load average was about 2 during most runs. Absolute numbers are a few percent pessimistic. Growth ratios are not affected.

## Workloads

| Name | Generator / source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| realistic 700 | `scripts/audit-repo.mjs` (700) | 736 | 10,536 | not recorded |
| realistic 1k | `scripts/audit-repo.mjs` (1000) | 1,051 | 15,051 | 23,032 |
| realistic 3k | `scripts/audit-repo.mjs` (3000) | 3,151 | 45,151 | 69,072 |
| realistic 10k | `scripts/audit-repo.mjs` (10000) | 10,501 | 150,501 | 230,352 |
| synthetic10k | `scripts/bench.mjs --target synthetic10k` | 202 | 10,206 | 0 |
| express | `expressjs/express` @ `0dee2c5` | 141 | 2,052 | 1,444 |
| got | `sindresorhus/got` @ `05b4476` | 96 | 5,752 | 4,850 |
| django | `django/django` @ `0b4aaa7` | 3,048 | 49,427 | 113,711 |

`scripts/synthetic-repo.mjs` (used by `bench.mjs` and by `test/synth/perf.test.ts`) writes 50 near-identical functions per file. It has **no imports, calls or classes**, so it produces 0 edges and cannot exercise the resolver, docs or drift (see A2-12). This audit adds `scripts/audit-repo.mjs` instead. It writes mixed TS (50%), JS (25%, some `require`) and Python (25%) in packages of 20 files. Each file has 2–4 imports of earlier files and calls into them, 6 functions with docstrings, a class with 4 methods using `this.`/`self.` calls, and `extends` of an imported class half the time. That is about 14 symbols and 22 edges per file, with 2 weak edges in 887 at 40 files.

## Budget table

Each timing is a median of 3 runs unless the cell says otherwise. Search p95 comes from 240 queries per process run: 60 each of exact name, natural-language phrase, `kind` filter and `file` filter.

| Budget (§Interfaces / SG6) | Measured | Result | Reproduce |
| --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median | realistic 10k **4.57**; realistic 1k/3k 4.37/4.64; Atlas self 4.42 (4.2–4.61) | PASS | `node scripts/audit-perf.mjs --gen 10000 --work $W --slow-runs 1` · `node scripts/bench.mjs --target self` |
| (same, on the §Interfaces targets) | express **5.14** (6 runs: 4.79–5.86); got **8.28** (7.65/8.28/10.82); synthetic10k **7.51** (7.97/7.51/7.50) | **FAIL** | `node scripts/bench.mjs --target <express-clone>` · `... --target synthetic10k` |
| no-op re-index ≤ 100 ms / 100 files | realistic 10k **12.7** (1,333 ms total); 1k 11.9; 3k 13.3; got ~45; synthetic10k ~49 | PASS | `audit-perf.mjs` (`noopMsPer100Files`) · `bench.mjs` |
| `search` p95 ≤ 50 ms at 10k symbols | realistic 10.5k symbols **21.8** (21.8/19.5/24.6); synthetic10k **28.5** (27.3/28.5/31.5) | PASS | `node scripts/audit-perf.mjs --gen 700 --work $W --skip docs,drift,ask` (x3) · `bench.mjs --target synthetic10k` (x3) |
| `search` p95 at the symbol count of a 10k-file repo (150k symbols) | **247 ms** (p50 170) | **FAIL** (5x) | `audit-perf.mjs --gen 10000` (`search.all`) |
| resolver ≤ 2 s / 1k files | realistic 10k **0.48 s/1k** (5.06 s total); 1k 0.36; 3k 0.41; django 0.71 | PASS | `audit-perf.mjs` (`resolverMsPer1kFiles`) |
| SG6: cached `atlas docs` ≤ 1 s on 1k files | CLI **7.13 s** (runs 2–4: 7.23/7.13/7.08); core `synthesizeDocs` 7.33 s; django (3k real files) 124 s | **FAIL** (7x) | `atlas index . && atlas docs --offline -b 100000000` (x4) in a realistic-1k repo |
| cached docs at 10k files | **987 s** (1 run; first, uncached run 989 s) | **FAIL** | `audit-perf.mjs --gen 10000 --slow-runs 1` (`docs.cachedMs`) |
| drift at 10k files | **991 s** (1 run); 1k CLI 7.97 s (9.13/7.98/7.27); 3k 90 s; django 126 s | **FAIL** (no budget stated; impractical) | `audit-perf.mjs --gen 10000 --slow-runs 1` (`drift.ms`) · `atlas drift` |

## Growth (realistic shape, 1,051 → 3,151 → 10,501 files)

Exponent k is the log-log slope (time ∝ files^k) for 1k→3k and 3k→10k.

| Operation | 1k | 3k | 10k | k |
| --- | --- | --- | --- | --- |
| cached docs (core) | 7.33 s | 93.5 s | 987 s | 2.32 / 1.96 |
| drift | 9.25 s | 90.4 s | 991 s | 2.07 / 1.99 |
| resolver | 378 ms | 1,297 ms | 5,056 ms | 1.12 / 1.13 |
| no-op re-index | 125 ms | 420 ms | 1,333 ms | 1.10 / 0.96 |
| one-file edit re-index | 596 ms | 1,595 ms | 5,885 ms | 0.90 / 1.08 |
| search p95 | 30.3 ms | 80.3 ms | 247 ms | 0.89 / 0.93 |
| ask retrieval | 130 ms | 466 ms | 1,525 ms | 1.16 / 0.98 |
| full index | 7.9 s | 26.5 s | 87.9 s | 1.10 / 1.00 |
| peak RSS | 423 MB | 886 MB | 2,532 MB | |

The forced re-index (`indexRepo(..., { force: true })`) is super-linear: 500/1k/2k files take 5.3/11.4/31.3 s, against a fresh index of 3.7/7.4/15.7 s (A2-03).

Prompt and token growth: none. The largest module prompt plus system prompt is 9.8k/10.1k/11.0k chars at 1k/10k/django. `ask` prompts are 1.2k–6k chars at every size. The 6k/12k caps from SG6 hold. Total docs input does grow linearly (51 M prompt chars at 10k files), so the default `tokenBudget` of 200k covers only about 80 modules of a 10k-file repo per run. That is by design and is not a defect.

## Findings

### Critical

#### A2-01: Docs and drift are O(files × call edges) because the module call queries drive from `idx_edges_kind`
- **Severity:** Critical. It blows the SG6 budget by 7x at 1k files, and cached `atlas docs` and `atlas drift` take about 16.5 min each at 10k files, so CI drift is impractical.
- **Evidence:**
  - Growth exponent is about 2 (table above).
  - On the realistic-1k index, `node scripts/audit-explain.mjs <work>/audit.db` gives:
    ```
    OUTGOING  median 2.35 ms   SEARCH e USING INDEX idx_edges_kind (kind=?)
    INCOMING  median 3.20 ms   SEARCH e USING INDEX idx_edges_kind (kind=?)
    ```
    Each module prompt walks every `calls` edge in the repo twice. The same queries on a copy after `ANALYZE` take **0.07 / 0.09 ms**, with plans `SEARCH s USING INDEX idx_symbols_file` → `SEARCH e USING INDEX idx_edges_src|dst`.
  - On django (a real repo), cached docs take 124 s and drift 126 s.
  - `test/audit/query-plan.test.ts` pins this as an `it.fails`. It captures the SQL that `buildModuleContext` prepares and asserts that no plan uses `idx_edges_kind`. Once fixed it will fail; flip it to `it`.
- **Cause:**
  - `src/core/synth/context.ts:50-65` (`OUTGOING_SQL` / `INCOMING_SQL`). `e.kind = 'calls'` in the join lets the planner, which has no `sqlite_stat1`, choose the low-selectivity `idx_edges_kind`.
  - Every caller pays this: `synthesizeDocs` at `src/core/synth/synthesize.ts:394-395`, `detectDrift` at `src/core/drift/detect.ts:488` and MCP `atlas_drift`.
  - Possible fixes: run `ANALYZE` (or `PRAGMA optimize`) after indexing; write `+e.kind` to disqualify the index; or drop `idx_edges_kind` in favour of `(src_symbol, kind)` / `(dst_symbol, kind)`.
  - SG6's "~0.2 s" figure came from a 0-edge corpus (A2-12).

### High

#### A2-02: `search` latency is linear in symbols, so p95 is 247 ms at the 10k-file scale (5x budget)
- **Severity:** High.
- **Evidence:**
  - p95 is 30 / 80 / 247 ms at 15k / 45k / 150k symbols (k ≈ 0.9). Every query type is affected: at 10k files, exact name p95 is 171, phrase 272, `kind` filter 270, `file` filter 213.
  - The 10k-*symbol* budget passes (21.8 ms).
  - Through `atlas serve`, 50 parallel searches take 8.8 s wall time, with p95 8.4 s (at 1k: 1.38 s / 1.31 s). Reproduce with `node scripts/audit-load.mjs <indexed repo>`.
- **Cause:**
  - vec0 KNN is a brute-force scan over all vectors: `src/core/vector/store.ts:296-313`.
  - The filtered paths add a full `symbols` scan for the `rowid IN (subquery)` pre-filter. `instr(f.path, ?)` cannot use an index; see `FILE_FILTER_KNN_SUB` → `SCAN s` in `audit-explain.mjs` and `src/core/vector/search.ts:56-66,117-130`.
  - The budget needs restating for large repos, or an ANN index / quantized vectors are needed.

#### A2-03: Deleting a file's embeddings scans the whole vec0 table, so mass re-index is super-linear
- **Severity:** High. A branch switch or `atlas index --force` on 10k files is quadratic.
- **Evidence:**
  - `deleteEmbeddingsForFile` median is 3.64 ms at 14k embeddings and 11.27 ms at 46k (linear in table size). `DELETE ... WHERE rowid = ?` is 0.02 ms on the same tables.
  - `node scripts/audit-scaling.mjs force $W 500 1000 2000` gives forced re-index times of 5.3 / 11.4 / 31.3 s. The excess over a fresh index (1.6 / 4.0 / 15.5 s) roughly quadruples per doubling. Extrapolated to 150k embeddings, that is about 37 ms per changed file, or about 6 min extra for a full-tree change at 10k files.
- **Cause:** `src/core/vector/store.ts:277`: `DELETE FROM embeddings_vec WHERE rowid IN (...)`. The comment at `store.ts:322` already notes that vec0 scans every chunk for `rowid IN` outside KNN. It is called per changed file from `src/core/ingest/indexer.ts:122` and `:178`.

#### A2-04: MCP responses are unbounded, and at 10k files `atlas_drift` kills the session for stock MCP clients
- **Severity:** High. It crashes the client connection, and the size grows with the repo.
- **Evidence:**
  - `node scripts/audit-load.mjs <10k repo>` reports `atlas_drift: "MCP error -32000: Connection closed"`, and every later call fails with "Not connected".
  - With a raw stdio driver, the server stays alive and writes one JSON-RPC line of **29.6 MB** for `atlas_drift`: 100k+ `undocumented` entries plus a `formatted` copy of the same report, pretty-printed. `atlas_graph` writes **88.3 MB** after 75 s.
  - The SDK's `StdioClientTransport` caps a message at 10 MiB (`STDIO_DEFAULT_MAX_BUFFER_SIZE`), and its default request timeout is 60 s.
  - At 1k files `atlas_graph` is already 8.3 MB.
- **Cause:**
  - `src/mcp/server.ts` `handleDriftTool` (returns `{...report, formatted}`) and `handleGraphTool` (whole graph). `asText` pretty-prints with `JSON.stringify(value, null, 2)`.
  - These responses need paging or limits (e.g. top-N undocumented, graph by file or neighbourhood).

#### A2-05: The parse+insert budget fails on the §Interfaces targets express and got
- **Severity:** High. got is clearly over and express is marginal.
- **Evidence:**
  - express median is **5.14 ms/file** (6 runs, 4.79–5.86), got **8.28**, and `synthetic10k` **7.51**.
  - The realistic generator (about 100 lines per file) and Atlas self pass at 4.4–4.6.
  - Parse alone (tree-sitter plus CST walk, no DB) is 3.50 ms for express and 6.66 ms for got. That is 70–80% of the per-file cost; the rest is inserts.
  - The DECISIONS baseline for self was 2.6 ms; today it is 4.4 ms. Part of that is contention (load average ≈2), and part is likely the SG3/SG4 reference walks.
- **Cause:**
  - `src/core/parse/parser.ts:80-98`, `src/core/parse/ts.ts` (reference collection).
  - Minor: `insertSymbol` and `upsertEmbedding` call `db.prepare` per row (`src/core/db/repo.ts:421-438`, `src/core/vector/store.ts:233-238`). That costs about 10 µs per row against 1.6 µs with a cached statement, about 0.5 ms for a 60-symbol file.
  - The budget is per file with no size normalisation, so files with many symbols fail it.

### Medium

#### A2-06: Indexing RSS grows about 0.2 MB per file, all native, and is not released
- **Severity:** Medium.
- **Evidence:**
  - Peak RSS is 423 / 886 / 2,532 MB at 1k / 3k / 10k files (2,118 MB right after indexing 10k).
  - Indexing 3k files with `skipEmbeddings` gives RSS 698 MB with a JS heap of 9 MB, after `gc()` and after `closeDatabase`. With embeddings it is 728 MB.
  - Reproduce: under `node --expose-gc`, call `gc()` and read `process.memoryUsage()` before and after `await indexRepo(db, repo3000, { skipEmbeddings: true })`, then again after `closeDatabase(db)`.
- **Cause:** not isolated. The heap is flat, so the memory is native. The most likely cause is tree-sitter `Tree`s that are never explicitly released (`src/core/parse/parser.ts:86`). The other candidate is allocator retention. Extrapolating linearly (not measured), a 50k-file repo would need about 10 GB.

#### A2-07: Every incremental re-index rebuilds the whole graph and rescans all symbols
- **Severity:** Medium.
- **Evidence:**
  - A one-file edit costs 0.60 / 1.60 / 5.89 s at 1k / 3k / 10k files. It is proportional to repo size, not to the change; 5.06 s of the 10k figure is the resolver.
  - A no-op run also loads every symbol and every `embeddings_meta` row (`embedAllSymbols`), which is why got and synthetic10k pay about 45–49 ms per 100 files against about 12 for small files.
- **Cause:**
  - `src/core/ingest/indexer.ts:187-206`.
  - `src/core/graph/resolver.ts:61` (`clearEdges`, then a full rebuild).
  - `src/core/vector/embedAll.ts:381-394`, which uses `getAllSymbols`, `getAllFiles` and a full meta map to find new symbols.

#### A2-08: Q&A retrieval and MCP `atlas_symbol` load the whole index per call
- **Severity:** Medium.
- **Evidence:**
  - `retrieveForQuery` takes 130 / 466 / 1,525 ms at 1k / 3k / 10k files; search accounts for only about 170 ms of that at 10k.
  - MCP `atlas_ask` p50 is 1.72 s and `atlas_symbol` p50 is 839 ms (p95 1.07 s) at 10k files, against 137 ms and 54 ms at 1k.
- **Cause:**
  - `src/core/qa/retrieve.ts:267-269` (`getAllFiles`, `getAllSymbols`, `getAllEdges` on every question) and `:317` (a JS loop over every edge). The edges of the seeds could come from `idx_edges_src`/`idx_edges_dst`.
  - `src/mcp/server.ts` `handleSymbolTool` filters `getAllSymbols` in JS instead of using `idx_symbols_name` or FTS.

#### A2-09: The dashboard API materialises the whole index on page load and blocks the event loop
- **Severity:** Medium.
- **Evidence** (10k files, `node scripts/audit-load.mjs`):
  - `/api/graph` returns 47 MB in 2.3 s. The dashboard fetches it on every load (`src/web/static/app.js:16`).
  - A search issued while `/api/graph` is running takes 2.2 s.
  - `/api/stats` takes 1.33 s.
  - `atlas serve` RSS high-water mark is 818 MB.
- **Cause:**
  - `src/web/server.ts:84-91`: `/api/stats` counts with `getAllFiles(db).length`, `getAllSymbols(db).length` and so on instead of `counts(db)`.
  - `src/web/server.ts:92-94` builds the whole graph synchronously (`buildGraphJson`, `src/core/graph/export.ts:29-53`).
  - Search is synchronous SQLite work, so concurrent requests serialise (A2-02).

#### A2-10: Embedding text building is quadratic within a file
- **Severity:** Medium. Only very large files are affected.
- **Evidence:** `node scripts/audit-scaling.mjs bigfile $W 1000 3000 9000` (one TS file of N functions):

  | Functions | Parse | Embed |
  | --- | --- | --- |
  | 1,000 | 141 ms | 208 ms |
  | 3,000 | 497 ms | 1,366 ms |
  | 9,000 | 1,449 ms | 13,040 ms |

  The 9k-function file is 0.9 MB, under the 1 MiB walk limit.
- **Cause:** `src/core/vector/textForSymbol.ts:26-35`. `sliceLines` runs `src.split('\n')` on the whole file for every symbol, called from `src/core/vector/embedAll.ts:407-411`. The split lines should be cached per file.

### Low

#### A2-11: Statements are re-prepared per row, and `/api/stats` does unbounded scans
- **Severity:** Low. This covers the small items above that are not budget-relevant on their own.
- **Details:**
  - Per-row `db.prepare` happens in `insertSymbol`, `insertImport`, `upsertEmbedding` and `upsertFile` (`src/core/db/repo.ts`, `src/core/vector/store.ts`).
  - `readFileFromRoot` does a `SELECT path` per call (`src/core/vector/textForSymbol.ts:66-75`).
  - `ARCH_TOP` uses an automatic covering index over all edges (19 ms at 1k files). It runs once per docs or drift call, so it is not significant.

#### A2-12: The perf harness and the SG6 perf test cannot see graph-dependent costs
- **Severity:** Low. This is a process issue, but it is why A2-01 shipped.
- **Evidence:**
  - `scripts/synthetic-repo.mjs` writes no imports or calls, so `bench.mjs --target synthetic10k` reports `"edges":0`.
  - `test/synth/perf.test.ts` asserts cached synthesis and drift ≤ 1 s on that 0-edge corpus, and passes. The same assertion on `scripts/audit-repo.mjs` with 1k files measures 7.3 s.
  - The resolver budget is also never exercised by `bench.mjs`.
- **Cause:** `scripts/synthetic-repo.mjs`, `test/synth/perf.test.ts:9-25`. Benchmarks should use an edge-bearing corpus such as `audit-repo.mjs`.

## No finding

- Resolver complexity is near-linear (k ≈ 1.12) and well under budget at every size, including real django (0.71 s/1k files).
- No-op re-index is linear and about 8x under budget on realistic files.
- No crash or OOM occurred in-process at 10k files. Peak RSS was 2.5 GB (A2-06).
- `atlas serve` returned no errors under 50 parallel requests; they were only slow (A2-02, A2-09).
- Prompt sizes are bounded at every scale.
- `EXPLAIN QUERY PLAN` for exact-name and FTS search uses `idx_symbols_name`/`idx_symbols_qualified` and FTS5 (0.02 ms and 1.1 ms at 15k symbols).

## Files added

- `scripts/audit-repo.mjs`: realistic-shape generator (`node scripts/audit-repo.mjs <dir> <files>`).
- `scripts/audit-perf.mjs`: measures every budget plus docs, drift, ask and memory on a generated or external repo (`--gen N | --target DIR`, `--work DIR`, `--runs`, `--slow-runs`, `--skip`).
- `scripts/audit-explain.mjs`: `EXPLAIN QUERY PLAN` and timing for the hot queries on an index DB.
- `scripts/audit-scaling.mjs`: forced re-index and big-file probes.
- `scripts/audit-load.mjs`: HTTP (`atlas serve`) and MCP (`atlas mcp`) load test against an indexed repo.
- `test/audit/query-plan.test.ts`: `it.fails` pin for A2-01, under 0.2 s.

All scripts require `npm run build`. Use `W=$(mktemp -d)` for work dirs; nothing is written to `fixtures/` or to `--target` repos, except that `audit-load.mjs` needs `atlas index` (and optionally `atlas docs`) in the target.

## Re-measurement after SG10–SG13 (2026-10-21, thread lead)

This audit ran against `f25ab12`. SG12 later rewrote the module neighbourhood query in `synth/context.ts`. Re-run on the merged base with `node scripts/audit-perf.mjs --gen N --runs 1 --slow-runs 1`:

| Files | Cached docs | Drift |
|---|---|---|
| 1k (1,051) | 0.50 s | 0.95 s |
| 3k (3,151) | 1.52 s | 3.13 s |

Growth is now linear (about 0.48 s per 1k files for cached docs, about 1 s per 1k for drift), so **A2-01 is downgraded from Critical to Medium**: the 1 s/1k-file budget holds for docs and is borderline for drift. The `idx_edges_kind` plan in `test/audit/query-plan.test.ts` is still chosen, so that `it.fails` stays. A2-02 to A2-05 remain High and become SG14–SG16 in PLAN.md.
