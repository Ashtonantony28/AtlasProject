# AUDIT-10: performance under load (round 3)

Auditor: a fresh subagent that wrote none of the audited code. Base: `f65410c` (SG18–SG24 merged), branch `claude/atlas-audit-10`.
Machine: 4 vCPU, 16 GiB RAM, Node 22. AUDIT-9 ran mutation tests on the same machine from about 04:30, which raised the load to about 6 for roughly ten minutes. The 1-minute load average is given with each group of runs. Each timing is a median of several runs unless the cell says otherwise.

| Runs | Load average (1 min) |
| --- | --- |
| `bench.mjs`, 5 rounds × 4 targets | 0.44 to 0.88 |
| `bench.mjs` on got, A/B against pre-SG18 (`0680211`) and AUDIT-6 base (`99a767d`) builds, 5 interleaved rounds | 1.07 to 1.29 |
| `audit-perf.mjs --gen 1000 / 3000 / 10000` | 0.78 to 1.21 |
| `audit-perf.mjs --gen 700 --skip docs,drift,ask`, ×3 | 1.11 to 1.17 |
| `audit-perf.mjs --target` express, got, Atlas self | 1.01 |
| `audit3-patho.mjs workspaces` / `gitignore*` | 1.18 / 0.97 |
| `audit3-patho.mjs pyroots` 125 / 250 / 500 (table below) | 2.13 at start, 1.29 at end |
| `audit3-patho.mjs pyroots` 100 / 500 / 1000 (first run) | 0.97 at start, **6.33** at end (AUDIT-9 started) |
| `audit2-reindex.mjs` 1k / 3k / 10k | **6.10 / 6.10 / 5.92→3.19** (AUDIT-9 running) |
| CLI `docs --offline` and `drift` at 10k | 2.39 to 3.08 |
| `audit-load.mjs` and `audit2-load.mjs` at 10k | 1.72 / 1.26 |
| memory probes | 0.93 to 1.25 |
| `npm run test:perf`, ×3 | 1.18 to 1.33 |

The re-index table was measured at load 6, so its absolute times are high. Compare its ratios, not its milliseconds, with AUDIT-6.

## Workloads

| Name | Source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| express | `expressjs/express` @ `0dee2c5` | 141 | 1,992 | 1,613 |
| got | `sindresorhus/got` @ `05b4476` | 96 | 5,756 | 5,229 |
| Atlas self | this worktree | 182–185 | 2,562–2,603 | 5,843–5,924 |
| synthetic10k | `bench.mjs --target synthetic10k` | 202 | 10,206 | 0 |
| realistic 700 / 1k / 3k / 10k | `scripts/audit-repo.mjs` | 736 / 1,051 / 3,151 / 10,501 | 10,536 / 15,051 / 45,151 / 150,501 | n/a / 23,032 / 69,072 / 230,352 |
| Python monorepo (`pyroots N`) | `scripts/audit3-patho.mjs` (new) | 8 per project | 14 per project | 17 per project |
| TS workspace monorepo (`workspaces N`) | `scripts/audit3-patho.mjs` (new) | 6 per package | 12 per package | 40 per package |

SG18 changed the real-repo counts: express went from 2,052/1,554 to 1,992/1,613 symbols/edges, and got from 5,752/5,004 to 5,756/5,229. The realistic generator's counts are identical to AUDIT-6, so **it produces no `references` edges** and does not exercise SG18 (A10-03).

## Budget table (frozen §Interfaces / SG6)

| Budget | Measured | Result | Reproduce |
| --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express, Atlas) | express **1.85** (1.79–2.19, 5 runs); Atlas self **2.90** (2.74–3.08); Atlas self under vitest **2.47** | PASS | `node scripts/bench.mjs --target <express>` · `--target self` · `npm run test:perf` (new `test/perf/index.test.ts`) |
| (same, got, the SG16 target) | **4.71** over 10 runs (4.10–5.07; **1 of 10 over 5**). The AUDIT-6 base build measures 3.90 and pre-SG18 3.76 in the same interleaved rounds. | **PASS, within 6% (A10-02)** | `bench.mjs --target <got>` |
| (same, other targets) | synthetic10k **4.48** (4.35–5.11); realistic 1k / 3k / 10k **2.79 / 2.89 / 3.32** | PASS | `bench.mjs --target synthetic10k` · `audit-perf.mjs --gen N` |
| no-op re-index ≤ 100 ms / 100 files | express **9.3**; self **9.0**; got **27.5**; synthetic10k **32.8**; realistic 1k / 3k / 10k **7.1 / 7.6 / 9.7** (10k: 1,019 ms total) | PASS | `bench.mjs` · `audit-perf.mjs` (`noopMsPer100Files`) |
| `search` p95 ≤ 50 ms at 10k symbols | realistic 10.5k symbols **13.33** (12.98 / 13.33 / 13.87); synthetic10k **15.11** (13.69–18.62); `test:perf` **15.98** (13.99–17.41) | PASS | `audit-perf.mjs --gen 700 --skip docs,drift,ask` (×3) · `npm run test:perf` |
| (known, decided: 150k symbols, exact search) | p95 **151.6** (p50 101.1); exact 107, phrase 139, kind 195, file 127 | known (exact search kept) | `audit-perf.mjs --gen 10000` (`search.all`) |
| resolver ≤ 2 s / 1k files | realistic 1k / 3k / 10k **0.28 / 0.32 / 0.37 s/1k** (3.87 s at 10k); self 0.37; TS workspaces with 2,000 packages 0.16 | PASS on these | `audit-perf.mjs` (`resolverMsPer1kFiles`) · `audit3-patho.mjs workspaces` |
| (same, Python monorepo with a `src/` layout per project) | 1k files **0.82 s/1k**; 2k **1.73**; 4k **3.43**; 8k **7.26** (58 s) | **FAIL from about 2.3k files (A10-01)** | `audit3-patho.mjs pyroots <work> 125 250 500` |
| cached docs ≤ 1 s / 1k files | core `synthesizeDocs` 1k / 3k / 10k **0.33 / 0.30 / 0.32 s/1k**; CLI `atlas docs --offline` at 10.5k (process start plus export of 10,502 `.md` files) 4.68 s = **0.45 s/1k**; `test:perf` 1k 134 ms | PASS | `audit-perf.mjs` (`docs.cachedMs`) · `atlas docs --offline -b 100000000` in the 10k repo |

**One frozen budget fails:** the resolver, on a Python monorepo layout that SG19 added support for (A10-01). Everything else passes, with margins mostly wider than in AUDIT-6. The exception is got parse+insert, which SG18 moved closer to the limit (A10-02). Drift (no frozen budget) is 0.24 s at 1k in `test:perf`, 9.66 s at 10k in-process and 8.0 s through the CLI. AUDIT-6 measured 11.4 s and 10.3 s.

## Still open from AUDIT-6

| ID | AUDIT-6 | Now (10.5k files, 10,502 docs) | Status |
| --- | --- | --- | --- |
| A6-01 scoped graph `totals.edges` materialises the scope | `file=src` 958 / 863 ms; hub `step0` depth 1 / 3 460 / 1,433 ms; MCP 885 / 1,467 | HTTP `file=src` **496 / 465 ms**; hub depth 1 / 3 **105 / 805 ms**; MCP 444 / 783 ms. `file=pkg1/` 24 ms; default page 9 ms | **Open**, about 2× faster. SG22 kept `ownedEdges(db, scope, …)` for the total (`src/core/graph/export.ts:87-88`). The pin in `audit-6.test.ts` still fails as expected. |
| A6-02 one doc reads every doc | 382 / 410 / 384 ms | `/api/doc/file/:id` **299 ms**, `/api/doc/architecture` **286 ms**, MCP `atlas_docs {target}` **279 ms** for a 1.3 KB answer | **Open** (`server.ts:77-78`, `persist.ts:202-203`). The pin still fails as expected. |
| A6-03 each drift page re-runs drift | 6.18 / 6.26 s; a search behind it 6.25 s | MCP `atlas_drift` page 0 **5.48 s**, deep page **4.54 s**; a search sent behind it waits **4.69 s** | **Open** (`src/mcp/server.ts:201-202`) |
| A6-04 unbounded doc lists | MCP 1.84 MB / 476 ms; HTTP 1.66 MB / 413 ms | MCP **1.84 MB / 306 ms**; HTTP **1.66 MB / 306 ms** | **Open** (`mcp/server.ts:215`, `web/server.ts:113-125`) |
| A6-05 `/api/stats` walks `.atlas/docs` | 260 ms | **107 ms** | **Open** (`server.ts:92` → `countDocs`) |
| A6-06 search gate flakes under the suite | 2 of 6 full runs failed | Budgets run serially in `npm run test:perf`: 3 of 3 passes, p95 14–17 ms | **Fixed** (SG23) |

Re-check of the older items that AUDIT-6 left open:

| ID | AUDIT-6 | Now | Status |
| --- | --- | --- | --- |
| A2-06 index RSS not released (known, tree-sitter 0.21 pin) | 3.5 MB per parse of got `options.ts`; about 50 MB per 300-file re-index cycle; MCP about 12 MB per forced `atlas_index` | **3.76 MB** per parse (200 parses); **49.3 MB** per cycle (326 → 821 MB over 10 cycles, heap flat); MCP 351 → 429 MB over 5 forced calls (**12 MB**/call); 10k index RSS 2,140 MB, peak 2,875 MB | Unchanged, as decided. No OOM. |
| A2-07 every incremental re-index rebuilds the graph | edit1 0.96 / 1.90 / 5.63 s at 1k / 3k / 10k | edit1 **0.46 / 1.27 / 4.92 s** at load 6 (`audit-perf` at load 1: **0.40 / 1.14 / 5.47 s**); resolver 3.96 s and embedAll no-op 0.57 s of every 10k run | Unchanged in shape. A10-01 makes it much worse on Python monorepos. |
| A2-08 Q&A and `atlas_symbol` load the whole index | retrieve 1.85 s; ask p50 1.37 s; symbol p50 711 ms | retrieve **1.13 s**; MCP ask p50 **1.02 s**; symbol p50 **509 ms** | Unchanged (faster machine state) |
| A2-10 quadratic embed text in big files | 159 / 1,080 / 11,592 ms at 1k / 3k / 9k functions | **150 / 880 / 9,872 ms** (parse 91 / 255 / 892 ms) | Unchanged |
| A2-12 harness cannot see graph costs | `bench.mjs` and `test/perf/synth.test.ts` use the 0-edge generator | Same. The realistic generator now also misses `references` and multi-root layouts (A10-03) | Unchanged |

## Incremental and mass re-index (`scripts/audit2-reindex.mjs`, load 6)

Times in ms. "Branch switch" means 30% of files edited, 5% deleted and one package directory renamed.

| Files | noop | edit1 | edit10 | edit100 | add1 | delete1 | branch switch (indexed / removed) | switch back | fresh-index share | resolver | RSS high-water |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,051 | 95 | 462 | 474 | 1,184 | 445 | 427 | 2,673 (327 / 67) | 2,962 | 1,667 | 319 | 659 MB |
| 3,151 | 255 | 1,269 | 1,361 | 2,151 | 1,294 | 1,349 | 9,058 (957 / 172) | 8,871 | 5,048 | 1,055 | 1,388 MB |
| 10,501 | 824 | 4,921 | 4,965 | 5,297 | 4,458 | 4,529 | 31,077 (3,162 / 539) | 34,334 | 16,804 | 3,961 | 3,921 MB |

The branch switch still costs 1.6–1.85× a fresh index of the changed files, and it grows linearly. Nothing here is super-linear on the realistic generator. Each one-file change still costs the full resolver plus the embedAll scan (A2-07).

## Load at 10k files (`scripts/audit-load.mjs`, `scripts/audit2-load.mjs`)

The target was the realistic 10k repo after `atlas index` and `atlas docs --offline -b 100000000`, giving 10,502 docs in the index and in `.atlas/docs`.

| Request | HTTP ms (size) | MCP ms (size) |
| --- | --- | --- |
| search (serial p50 / p95) | 104 / 129 | 102 / 116 |
| 50 parallel HTTP searches | wall 5.19 s, p50 2.65 s, p95 4.99 s, 0 errors | — |
| graph, default page | 8–9 (241 KB) | 14 (0.28 MB) |
| graph `file=src` page 1 / 2 | 496 / 465 | 444 |
| graph `symbol=step0` depth 1 / 3 | 105 / 805 | 783 (depth 3) |
| graph unscoped `offset` 0 / 50k / 149k (in-process) | 7.6 / 13.3 / 28.4 | — |
| doc list | 306 (1.66 MB) | 306 (1.84 MB) |
| one doc | 286–299 | 279 |
| `/api/stats` | 107 | — |
| `atlas_symbol` hub / `atlas_ask` p50 | — | 509–523 / 1,023 |
| `atlas_drift` page 0 / deep page | — | 5,476 / 4,539 (0.24 KB) |
| 20 searches queued with broad graph pages and doc fetches | wall 5.05 s; search p50 3.95 s, p95 4.92 s, 0 errors | — |
| server RSS / high-water | 403 / 434 MB | 684 / 684 MB |

No request errored and no client disconnected. Every response stays bounded except the doc lists (A6-04). Concurrency still only queues: SQLite calls are synchronous, so a request that does work over the whole index or the whole docs directory delays everything behind it.

## Pathological inputs

| Probe | Result |
| --- | --- |
| Deep nesting, TS: 10,000 nested functions / arrows / parens / arrays / calls / member chains; a 10,000-term binary expression | No crash or stack overflow. 44–173 ms each, linear (1,000 → 10,000 is 2–8×) |
| Deep nesting, Python: 1,000 nested `def` (512 KB) | 31 ms with 1 diagnostic. A 10,000-level file is 50 MB and above `maxBytes`. |
| Huge file: 1 file of 9,000 functions (A2-10) | parse 0.89 s, embed 9.9 s (quadratic embed, unchanged) |
| SG18 value-heavy file: route table of N objects referencing 200 functions | 1k / 4k / 16k rows: **66 / 233 / 847 ms**, against 29 / 90 / 358 ms before SG18. Linear but **2.4× the parse cost**; the references collapse to 200 rows (part of A10-02). |
| TS workspaces: N packages, a tsconfig per package extending one base with N `paths` aliases | 100 / 300 / 1,000 / 2,000 packages: resolver **0.11 / 0.09 / 0.12 / 0.16 s/1k** (A10-05) |
| Python monorepo: N projects with `pyproject.toml` and `src/` | **quadratic** (A10-01) |
| Nested `.gitignore` in every one of D chained directories, 5 files each | D = 25 / 50 / 100 / 200 / 400: walk **15 / 48 / 305 / 1,673 / 10,848 ms** (A10-04) |
| One `.gitignore` in each of 100 / 500 / 2,000 sibling packages of 20 files | 28 / 115 / 523 ms, against 38 / 117 / 413 ms with no `.gitignore` (linear) |

## Findings

Counts: **Critical 1, High 1, Medium 0 new (4 open from AUDIT-6), Low 3 new (1 open from AUDIT-6).**

### Critical

#### A10-01: Python import resolution is O(imports × project roots), so the resolver budget fails on Python monorepos from about 2.3k files
- **Evidence:**
  - `audit3-patho.mjs pyroots` builds N projects, each with `pyproject.toml`, `src/pkgN/` (5 modules) and `tests/`.
  - Resolver alone, at load 1.3–2.1: 1k files **0.82 s**, 2k **3.45 s** (1.73 s/1k), 4k **13.7 s** (3.43 s/1k). Doubling the files quadruples the time.
  - In the first run (load rising to 6) 8k files took **58.1 s** (7.26 s/1k). The full index of those 8k files took 63 s, of which 58 s was the resolver.
  - Every `atlas index` runs the resolver, including a one-file edit (A2-07). On such a repo, each incremental re-index therefore costs the same 14 s at 4k files.
  - The same file count in the realistic generator (one `src/` root) resolves at 0.28–0.37 s/1k.
  - `test/audit/audit-10.test.ts` (A10-01): with 60 projects, resolving `import os` once does **183** path lookups (3 candidates × 61 roots). The pin asserts fewer than 60.
- **Repro:** `node scripts/audit3-patho.mjs pyroots $W 125 250 500`. The pin is `npx vitest run test/audit/audit-10.test.ts`.
- **Cause:**
  - `src/core/graph/modules.ts` `pythonRoots()` (`:283-313`) adds `src/` beside every pyproject/setup.cfg/setup.py, plus every `where`/`package_dir` dir, to one global `roots` list.
  - `resolvePython` (`:250-278`) tries `.py`, `.pyi` and `/__init__.py` under **every** root for every absolute import. Each try runs `normalizePosix`, which does a regex split.
  - Imports that are not in the index (stdlib, third-party) always walk the whole list, and those are most imports.
  - A CPU profile at 300 projects puts 4.6 s of a 4.6 s resolver in `normalizePosix` and 2.5 s self time in `resolvePython`. These overlap, because the profile counts the two index passes.
  - Possible fix: index roots by the top-level package they hold. Build a `Map<topLevelName, root[]>` once from `byPath`, the way `discovered` already is, and probe only the roots that contain `rel.split('/')[0]`. Memoising `(root, spec)` would also help.
- **Severity:** Critical because a frozen budget (resolver ≤ 2 s / 1k files, read per 1k as AUDIT-6 did at 10k) fails at a supported scale on a layout SG19 explicitly added. At exactly 1k files it passes (0.82 s). If the budget is read only literally at 1k files, this is High (super-linear).

### High

#### A10-02: got parse+insert is within 6% of the 5 ms/file budget after SG18, with 1 run in 10 over it
- **Evidence:**
  - `bench.mjs --target got`: 4.78, 4.97, 4.20, 4.94, 4.10 (load 0.4–0.7) and 4.61, 4.63, 4.67, 4.74, **5.07** (load 1.1–1.3). The median of the 10 runs is **4.71 ms/file**.
  - Interleaved in the same rounds, the pre-SG18 build (`0680211`) measures **3.76** (3.33–4.50) and the AUDIT-6 base (`99a767d`) **3.90**. SG18 therefore adds about **+25%**.
  - DECISIONS (SG18) recorded about 4.2. AUDIT-6 recorded 4.60 with the SG16-era code under heavier load.
  - Where the time goes (parse only, `parseSource` over got's 96 files): **2.40 against 2.14 ms/file** (+12%). Refs rose **6,439 → 9,523** (+48%) and are inserted row by row in the same transaction, which accounts for the rest.
  - On value-heavy files the parse alone is **2.4×** slower: a 16k-row route table takes 847 ms against 358 ms (table above).
  - No automated gate covers this budget (A10-03), so the regression went in unnoticed.
- **Repro:** `for i in 1 2 3 4 5; do node scripts/bench.mjs --target <got> | grep -o '"msPerFileMedian":[0-9.]*'; done`. For A/B, build `git archive 0680211` beside it and run its `scripts/bench.mjs`.
- **Cause:**
  - `src/core/parse/ts.ts`: SG18's reference extraction visits identifiers and member expressions in arguments, arrays, object values, JSX, returns, declarators and assignments.
  - The native `forEachOfType` cut-off rose from 100 to 500 descendants, so more nodes are materialised.
  - `insertRefs` (`src/core/db/repo.ts:185-194`) runs one statement per ref. Most of the new refs are `references` that the resolver later drops when they do not resolve: 225 edges came from 3,084 new rows.
  - Possible fixes: deduplicate `(src, name, object, kind)` refs per file in the parser (the route-table probe collapses 48k candidate refs to 200); skip value refs whose root name is not a top-level function, class or import binding (already partly done); or batch the inserts with a multi-row `VALUES` statement.
- **Severity:** High by the stated bar: a budget within 10% of failing on a common path (got is the SG16 target).

### Medium (open from AUDIT-6, re-measured above)

A6-01, A6-02, A6-03 and A6-04 are unchanged in shape and 1.3–2× faster in absolute terms. See "Still open from AUDIT-6". There are no new medium findings.

### Low

#### A10-03: `npm run test:perf` gated only 3 of the 5 frozen budgets, and the generators miss SG18/SG19 shapes
- **Evidence:**
  - SG23 moved the wall-clock budgets into `test/perf/`, but only search p95, cached synthesis and drift were there. Parse+insert, no-op re-index and resolver ran only by hand in `bench.mjs`/`audit-perf.mjs`, which is how A10-02 went unnoticed.
  - `scripts/audit-repo.mjs` produces the same symbol and edge counts as before SG18 (no `references` edges) and has a single Python root, so the A10-01 shape never appears.
- **Change made in this audit:** `test/perf/index.test.ts` adds the three missing budgets, measured on Atlas itself (a frozen bench target that is always in tree): parse+insert **2.47 ms/file**, no-op **8.6 ms/100 files**, resolver **373 ms/1k files**. They run serially under `test:perf` with a warm-up pass.
- **Remaining:** got is not in tree, so the budget most at risk is still not gated. Possible fix: vendor a got-sized fixture, or add `pyroots` / `workspaces` shapes and SG18 value refs to `audit-repo.mjs`.

#### A10-04: The walk is cubic in the depth of nested `.gitignore` files
- **Evidence:** with a `.gitignore` and 5 files at every level of a D-deep chain, D = 25 / 50 / 100 / 200 / 400 costs 0.12 / 0.19 / 0.61 / 1.67 / 5.42 ms per file. A profile at D = 200 puts 1.33 s of 2.0 s in `ignore`'s `_t` (its parent-path check).
- **Cause:** `src/core/ingest/walker.ts:60-68` tests each path against every ancestor's rules, which is O(D). The `ignore` package then re-checks every parent segment of the relative path for each rule set, which is O(D) again.
- **Severity:** Low. Real trees with a `.gitignore` at every level are about 10 deep, where this costs under 0.1 ms per file. Wide trees are linear (2,000 packages with their own `.gitignore`: 523 ms for 40k files).

#### A10-05: tsconfig `paths` lookup is linear in the number of aliases per import
- **Evidence:** in a TS workspace with one alias per package, the resolver costs 0.11 s/1k files at 100 packages and 0.16 s/1k at 2,000. That is mildly super-linear and far inside budget.
- **Cause:** `viaTsconfig` (`modules.ts:76-104`) scans all of `scope.paths` for every bare specifier, and `scopeFor` makes a `toScope` copy of the alias list for each tsconfig directory.
- **Severity:** Low. Possible fix: an exact-match `Map` for the alias keys without `*`.

#### A6-05 (open)
`/api/stats` now takes 107 ms at 10.5k docs (260 ms in AUDIT-6). See above.

## No finding

- **SG20 walker:** linear in files on wide trees. The `.gitignore` read and the `pyvenv.cfg` check are one `existsSync` per directory.
- **SG22 graph paging:** the unscoped page uses `idx_edges_src` range scans plus a temp B-tree over one page's edges, and is bounded by `LIMIT edgeLimit+1`. Deep `offset` is linear in the offset (7.6 → 28.4 ms at offset 149k, from the `OFFSET` skip over symbols). The null-`src` branch would scan every null-`src` edge, but the resolver emits none (0 at 10k).
- **SG19 on ordinary repos:** the resolver is faster than in AUDIT-6 (0.37 against 0.49 s/1k at 10k). Each directory is listed once.
- **SG18 deep nesting:** no recursion blow-up up to 10,000 levels.
- **Memory:** unchanged from A2-06 (known). No OOM at 10k. Each 10k `audit-perf` run peaked at 2.9 GB and the 10k re-index probe at 3.9 GB.
- **Concurrency:** 50 parallel HTTP searches and the mixed bursts gave no errors and no disconnects.

## Files added

| File | What it does |
| --- | --- |
| `scripts/audit3-patho.mjs` | Pathological layouts: `workspaces N` (TS packages with tsconfig `paths`), `pyroots N` (Python projects with `src/` layouts), `gitignore D` (deep `.gitignore` chain), `gitignore-wide N`. Prints index, resolver and walk times. |
| `test/audit/audit-10.test.ts` | `it.fails` pin for A10-01 (path lookups to resolve one Python import with 60 project roots). About 20 ms. |
| `test/perf/index.test.ts` | Serial budget checks on Atlas itself for parse+insert, no-op re-index and resolver (A10-03). About 5 s, `npm run test:perf` only. |

All scripts require `npm run build`. Use a fresh work dir (`W=$(mktemp -d)`).
