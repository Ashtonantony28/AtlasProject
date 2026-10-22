# AUDIT-22: performance under load (round 6)

Auditor: a fresh subagent that wrote none of the audited code. Base: `121fffa` (SG45, SG50, SG55 and AUDIT-18/19 merged), worktree `atlas-audit-22`.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22. Other sessions ran the whole time; the 1-minute load average moved between 1.7 and 7.3. The load is given with each run. Compare builds inside a group, not across groups.

| Build | What it is |
| --- | --- |
| current | `121fffa` (`npm run build`) |
| `b3403d8` | Parent of SG55 (AUDIT-18 base plus SG45), extracted with `git archive` into the scratchpad |
| `pushfix` | current `dist` with `carryEdges`' same-name lists built by `push` and read by index (the A22-02 fix), scratch only |

## Workloads

The repos are the AUDIT-18 ones (`<scratch>/a18/`), so the numbers compare directly.

| Name | Source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| realistic 10k | `scripts/audit-repo.mjs` | 10,501 | 152,773 | 230,352 |
| dense 3k / 10k | AUDIT-18 `gen-dense.mjs` | 3,001 / 10,001 | 27,002 / 90,002 | 224,769 / 749,769 |
| gen8000 | one 837 KB `api.generated.ts` of 8,000 functions | 2 | 8,003 | 2 |
| dupN | one Python file of N `x = i` lines plus an importer | 3 | N + 5 | 3 |
| big600 (new) | `gen-big.mjs`: 600 TS files of 500 KB (4 functions and a block comment each), 296 MB | 600 | 2,400 | 0 |
| g300 (new) | `audit-repo.mjs`, 300 files, for repeated runs | 300 | 4,588 | |
| express, got | `<scratch>/repos` clones | 141 / 96 | | |

## SG55: embedding is linear and yields

| Input (load) | Run | `b3403d8` total / longest block | current total / longest block |
| --- | --- | --- | --- |
| gen8000 (3.4–3.5) | fresh | 11.6 s / **10.2 s** (embed) | **1.9 s / 1.2 s** (parse of the 837 KB file) |
| | `--force` | 10.6 s / 9.2 s | 2.1 s / 1.4 s |
| dup30000 (3.2–4.4) | fresh | 45.6 s / **44.4 s** | **2.9 s / 0.96 s** |
| | `--force` | 54.7 s / 46.3 s | 10.0 s / **8.0 s** (carry, A22-02) |
| realistic 10k (1.8–2.6) | fresh | AUDIT-18: 75.5 s, embed block 14.2 s | 76.9 s, embed batches ≤ 0.97 s (setup, A22-05) |
| | `--force` | AUDIT-18: 105.9 s, embed 12.7 s | 104.8 s, embed ≤ 0.69 s |
| dense 10k (2.4–4.1) | fresh / `--force` | AUDIT-18: embed 7.1 / 7.8 s | embed ≤ 0.38 s |

- The `sliceLines` cache holds: a file's source is split once per run, also when two generated files share a run and after an edit re-embeds one of them (pinned). Symbols are embedded in id order and a file's symbols have consecutive ids, so the one-entry cache never thrashes within a run.
- The 50 ms yields cost nothing measurable: realistic 10k fresh 76.9 s against 75.5 s in AUDIT-18 at similar load.
- After a run, the module-level cache keeps the last file's source and lines: heap after GC 9 MB against 8 MB on `b3403d8` (big600). Not a finding.
- The embed phase still reads every symbol's source through `makeSourceLoader`, which keeps every file it has read until the phase ends (A22-04, predates SG55).

## Search and reads during indexing

### MCP (`mcpq.mjs`, stdio, a search every 100 ms, realistic 10k, load 7.3)

| Phase | AUDIT-18 | Now |
| --- | --- | --- |
| idle search | 149 ms | 155 ms |
| 20 queued no-op calls | last reply 3.5 s; search max 1.03 s | last reply 2.9 s; search max **852 ms** (p95 852) |
| 2 queued forced calls (one shared run) | 163.3 s; search max **14,097 ms**, p95 181 | 179.3 s; search max **4,632 ms** (the resolve block), p95 178 |
| RSS / HWM | 550 → 460 / 549 MB | 533 → 464 / 534 MB |
| duplicate symbols | none | none |

The embed window is gone. The resolve transaction is now the only multi-second stall (A22-01).

### Dashboard (`serveprobe.mjs`, `atlas serve` while another process runs `atlas index --force`, realistic 10k)

565 probes of `/api/search` and `/api/stats`: search p50 68 / p95 146 / max **272 ms** (idle p50 187), stats max 25 ms, no errors. `serve` is a separate read-only process, and WAL readers never wait for the writer. Search is faster mid-run because a forced run drops every vector until the embed phase (A19-03). **No finding.**

### Second writer process (`race.mjs`, dense 10k, `atlas index --force` in another process)

419 write attempts (`BEGIN IMMEDIATE; COMMIT`, as `upsertDoc` takes) every 250 ms during the 120.5 s run: every attempt waited under 50 ms, except one that failed with **`SQLITE_BUSY` after 5,033 ms** at 103.0 s and one that waited 3,954 ms at 108.3 s. Reads on that connection: max 46 ms. See A22-03.

## Event-loop blocks in-process (`probe.mjs`, longest gaps of a 5 ms timer)

| Workload (load) | Run | Resolve block | Embed (now batched) | Next longest | Total | HWM |
| --- | --- | --- | --- | --- | --- | --- |
| realistic 10k (1.8) | fresh | **4.73 s** | 0.97 s (setup) | 0.18 s | 76.9 s | 453 MB |
| realistic 10k (2.6) | `--force` | **4.24 s** | 0.69 s (setup) | 0.14 s | 104.8 s | 488 MB |
| realistic 10k (2.6 / 4.1) | no-op | — | 0.73 / 0.80 s (setup) | 0.15 s | 1.04 / 1.11 s | 492 MB |
| dense 3k (3.3–3.9) | fresh / `--force` / upgrade | **2.47 / 2.55 / 2.47 s** | 0.16 s | 0.36–0.43 s | 16.8 / 31.4 / 31.2 s | 289 MB |
| dense 10k (2.4 / 4.1) | fresh / `--force` | **11.10 / 11.27 s** | 0.38 s | 1.22 s (`hub.ts` carry, `--force`) | 58.5 / 122.5 s | 687 MB |
| dup60000 (4.7) | `--force` | — | — | **28.3 s** (per-file transaction) | 32.7 s | 607 MB |
| dup60000, `pushfix` (2.2) | `--force` | — | — | 4.65 s | 8.4 s | 463 MB |

Memory stays flat at 10k: HWM 453–492 MB (AUDIT-18: 456–549).

## Repeated runs (`growth.mjs`, g300)

| Mode | Rounds | DB / WAL | vec0 chunks | Search p50 | Run time |
| --- | --- | --- | --- | --- | --- |
| `--force` | 0 → 20 | 9.0 → 11.5 MB / 5.4–5.5 MB | 5 → 5 | 7.1 → 5.8 ms | 1.9 → 2.6–3.0 s |
| one-file edit (append a function) | 0 → 200 | 9.0 → 11.0 MB / 5.4 MB | 5 → 5 | 7.1 → 6.0 ms | 112–184 ms |

vec0 reuses its chunks although every forced run gives each symbol a new id. The DB grows by its own new rows (one `runs` row per run, 50 new symbols) and the freelist. **No unbounded growth** (pinned).

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-18 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express) | 2.02 | **2.21** (load 6.1) | PASS | `node scripts/bench.mjs --target <express>` |
| (same, got; not gated) | 5.07–7.05 | **6.11 / 6.73 / 6.60** (load 6.1–6.2) | over 5, cause unchanged (A18-05) | `bench.mjs --target <got>` |
| no-op re-index ≤ 100 ms / 100 files | realistic 10k 11.6 | realistic 10k 9.9–10.6 (1,042–1,111 ms); express 15.0 (21.2 ms / 141 files) | PASS | `probe.mjs … fresh,noop` |
| `search` p95 ≤ 50 ms at 10k symbols | 18.0–21.2 | express 3.4; gated in `test:perf` (not re-run) | PASS | `npm run test:perf` |
| `openDatabase` on a 10k index (SG45, not gated) | | p50 0.72 ms, max 6.8 ms over 50 opens | | inline loop |

## Findings

Counts: **Critical 0, High 0, Medium 4, Low 1** (new or re-rated). Still open from AUDIT-18, re-measured: A18-03 and A18-05 (Medium). Fixed: A18-01 (SG55) and the embed half of A18-02. A18-04's message is fixed; the ~12-call capacity is by design (14 parallel asks at 10k: 12 ran, the 12th with `max_tokens` 8,551, 2 refused with "198775 tokens reserved by calls in progress", 15.5k tokens spent). SG45 and SG34 hold. A14-04, A14-06 and A6-01..A6-05 were not re-measured: their code did not change.

### Medium

#### A22-01 (A18-02, resolve half): the resolve transaction is now the longest block of every resolving run: 4.2–4.7 s at 10k realistic files, 11.1–11.3 s at 10k dense
- **Evidence:**
  - See the block table. With the embed window gone, the longest gap of every fresh, forced, upgrade or edit run is `resolveGraph`. Through MCP, a search during a forced 10k run waited **4,632 ms** (AUDIT-18: 14,097 ms, of which 5.4 s was resolve).
  - Dense 10k: 11.1 s fresh and 11.3 s forced, above AUDIT-18's 9.1 / 10.1 s at higher load. It grows with edges: about 15 µs per edge.
  - The same transaction holds the SQLite write lock for as long as it runs. That is A22-03.
  - `test/audit/audit-22.test.ts` A22-01 (`it.fails`): on a 40-file dense repo, the resolver's read of `refs` and its last `INSERT INTO edges` happen in the same event-loop turn (`expected 862 to be greater than 862`).
- **Repro:** `node <scratch>/a22/scripts/probe.mjs $PWD/dist <dense10k> <db> fresh,force` · `node <scratch>/a22/scripts/mcpq.mjs $PWD <realistic10k> 20 2` · `npx vitest run test/audit/audit-22.test.ts`
- **Cause:** `resolveGraph` (`src/core/graph/resolver.ts:72-73`) runs `clearEdges`, every read, the whole computation and every insert inside one `db.transaction`. SG34 and SG55 yield around it but cannot yield inside it.
- **Fix:** read and compute outside the transaction, yielding every ~50 ms, then clear and write in one short transaction, so readers still never see a partial graph (SG50). The write half (inserting 750k rows) can be timed separately. If it is still seconds, insert into a staging table in yielding batches and swap in one statement.
- **Severity:** Medium, as in AUDIT-18. It is linear and under the 60 s client timeout. It is now the main stall of any MCP session that indexes, and it blocks other processes' writes (A22-03).

#### A22-02 (A18-06, re-rated from Low): `carryEdges` is quadratic in same-name symbols, and since SG55 it is the longest block on such files: 28.3 s for a 60,000-line file, on every edit
- **Evidence:**
  - dup30000 `--force`: 10.0 s with an **8.0 s** block. dup60000 `--force`: 32.7 s with a **28.3 s** block. With `pushfix` the dup60000 block is **4.65 s** (8.4 s total), so about 23.6 s is the carry.
  - Doubling N gives 3.5× the time.
  - AUDIT-18 rated this Low because the same file spent 47 s in embedding. SG55 cut that to under 1 s, so the carry now dominates.
  - It runs on every re-parse of the file that has edges, not only on `--force`: each edit of such a file blocks the event loop for that long inside one per-file transaction.
  - `audit-22.test.ts` A22-02 (`it.fails`): forcing a re-index of a 3,000-line `x = i` file copies **4,501,506** array slots into the carry's map (`expected 4501506 to be less than or equal to 60000`). The bound is 20 × N.
- **Repro:** the dupN repo (AUDIT-18 Workloads), then `node <scratch>/a22/scripts/probe.mjs $PWD/dist <scratch>/a18/dup60000 <db> fresh,force`, and the same run with `<scratch>/a22/pushfix/dist`.
- **Cause:** `src/core/ingest/indexer.ts:210`: `fresh.set(key(s), [...(fresh.get(key(s)) ?? []), s.id])` copies the list on each push, and `:212` drains it with `shift()`.
- **Fix:** push into the existing array and read it by a per-key cursor (the `pushfix` patch), or update symbols in place (A18-03 option 1).
- **Severity:** Medium. The input class is narrow (thousands of same-kind, same-name symbols in one file: repeated assignments, overloads, generated code), but the cost is quadratic, it lands on every edit of such a file, and the fix is two lines.

#### A22-03: another process's write fails with `SQLITE_BUSY` when an index run's resolve transaction holds the lock for more than 5 s
- **Evidence:**
  - `race.mjs` on dense 10k: during a forced CLI index (120.5 s), one write attempt failed with **`SQLITE_BUSY` after 5,033 ms** and the next waited 3,954 ms. The other 417 attempts waited under 50 ms.
  - better-sqlite3's default busy timeout is 5,000 ms, and no `busy_timeout` is set (`src/core/db/database.ts:40-43`). The resolve transaction lasts 11.1–11.3 s at dense 10k and 4.2–4.7 s at realistic 10k, so a realistic repo crosses 5 s at roughly 11k files, or sooner under load.
  - Writers that do not take the SG32 index lock: `atlas docs` (`upsertDoc`, `importPersistedDocs`, `src/core/db/repo.ts:281-300`) and the drift tombstone writes (`repo.ts:342`, `:403`). Run in a second process (a terminal next to an `atlas mcp` session that is indexing, or CI steps sharing an index), they fail with "database is locked" instead of waiting.
  - A pending SG45 migration (`runMigrations`' `BEGIN IMMEDIATE`) hits the same 5 s limit. Opening an up-to-date index takes no write lock (pinned).
  - Readers are unaffected: max 46 ms on the racing connection, and `atlas serve` stays at a 272 ms max.
- **Repro:** `node <scratch>/a22/scripts/race.mjs $PWD <indexed dense10k> 250`
- **Fix:** shorten the transaction (A22-01's fix), set `busy_timeout` above the longest expected write (for example 60 s) in `openDatabase`, or have `docs` take the index lock.
- **Severity:** Medium. It is a hard failure, not only latency, but it needs two processes and a large repo.

#### A22-04: the embed phase keeps every file's source in memory until it ends: +294 MB for 296 MB of source, and an OOM where parsing fits
- **Evidence:**
  - big600 (600 × 500 KB): after the parse loop (`skipEmbeddings`), HWM is **110 MB** with 8 MB of heap. During `embedAllSymbols`, peak heap is **305 MB** and HWM **404 MB**. `b3403d8` gives 423 MB, so this predates SG55.
  - With `--max-old-space-size=200`, the parse loop finishes (HWM 107 MB), and the embed phase dies with `FATAL ERROR: Reached heap limit … JavaScript heap out of memory`.
  - Memory scales with the repo's total source bytes, not with any one file. That is about 43 MB for the realistic 10k repo, and reaches GBs for a large monorepo on a small CI runner.
- **Repro:** `node <scratch>/a22/scripts/gen-big.mjs <dir> 600 500 && node --expose-gc <scratch>/a22/scripts/mem.mjs $PWD/dist <dir> <db> 0`, then the same with `node --max-old-space-size=200`.
- **Cause:** `makeSourceLoader` (`src/core/vector/textForSymbol.ts:54-68`) caches every file it has read in a `Map` that lives for the whole of `embedAllSymbols` (`embedAll.ts:42`).
- **Fix:** targets come in id order with each file's symbols contiguous, so keep only the current file: one cache entry, like SG55's `split`.
- **Severity:** Medium. Memory is unbounded in repo size, and this is the only phase that does it. The parse loop has been flat since SG34.

### Low

#### A22-05 (A18-07, widened): the embed phase's setup blocks for 0.7–1.0 s at 10k files on every run, not only no-op runs
- **Evidence:** realistic 10k: 0.97 s (fresh), 0.69 s (`--force`), 0.73 / 0.80 s (no-op). Since SG55 this is the second-longest gap of every 10k run. Through MCP, 20 queued no-op calls gave a search max of 852 ms.
- **Repro:** `node <scratch>/a22/scripts/probe.mjs $PWD/dist <realistic10k> <db> fresh,noop,force` (the second gap of each phase)
- **Cause:** `embedAllSymbols` loads all 152k symbols, all files and all of `embeddings_meta` and filters them in one turn, before its first yield (`embedAll.ts:40-54`).
- **Fix:** select only the targets (`LEFT JOIN embeddings_meta … WHERE model IS NOT ?`), in pages.
- **Severity:** Low.

### Open from AUDIT-18 (re-measured)

| ID | AUDIT-18 | Now | Status |
| --- | --- | --- | --- |
| A18-03 carry re-inserts edges on `--force` / upgrade | dense 3k `--force` 31.0–32.9 s, upgrade 31.8–35.0; dense 10k `--force` 114.0 s | dense 3k **31.4 / 31.2 s** (load 3.2–3.3); dense 10k `--force` **122.5 s** (load 4.1), including a 1.22 s block carrying `hub.ts`'s 80k edges in one per-file transaction | Open. The A18-03 `it.fails` tests still fail as expected. |
| A18-05 got parse+insert median | 5.07–7.05 | 6.11–6.73 at load 6.1–6.2; express 2.21 | Open (the yields move deferred frees into the per-file window) |
| A18-02 embed half | 12.7–14.2 s at 10k | batches ≤ 0.97 s | Fixed (SG55) |
| A18-01 | 11–47 s | 1.9 / 2.9 s | Fixed (SG55) |
| A18-06 | Low | re-rated as A22-02 | |
| A18-07 | Low | widened as A22-05 | |

## No finding

- **SG55** is linear and yields, with no wall-clock cost. The split cache survives multi-file runs and edits (pinned).
- **SG50 reservations:** 14 parallel asks at 10k: 12 run, the refusal names the reserved tokens, and `loadConfig` costs 43–85 µs.
- **SG45:** `openDatabase` costs 0.72 ms p50 on a 10k index and takes no write lock when nothing is pending (pinned).
- **SG34 coalescing:** 20 no-op MCP calls finish in 3.1 s, with no duplicate symbols. Calls made together share one run (pinned).
- **Repeated runs:** 20 forced runs and 200 edits leave the vec0 chunk count and search latency unchanged (pinned).
- **Dashboard during indexing:** no stalls (separate read-only process, WAL).
- **Large single file:** an 837 KB generated file parses in a 1.2 s block, linear in size (AUDIT-18: 150 / 271 / 568 ms at 5k / 10k / 20k lines).

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`. The scripts are in `<scratch>/a22/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first):
- `probe.mjs`, `mcpq.mjs`, `ask.mjs`, `gen-dense.mjs`, `rounds.sh`: AUDIT-18's, with `mcpq.mjs` pointed at this worktree's `scripts/audit-repo.mjs`.
- `growth.mjs <dist> <repo> <files> edit|force <rounds> [every]`: repeated runs on one index, with DB and WAL size, vec0 chunks and rows, and search p50/max.
- `race.mjs <atlasRoot> <indexedRepo> [ms]`: a second-process writer and reader against `atlas index --force`.
- `serveprobe.mjs <atlasRoot> <indexedRepo> <port>`: `atlas serve` probes during `atlas index --force`.
- `gen-big.mjs <dir> <files> <kb>` and `mem.mjs <dist> <repo> <db> <skipEmbeddings>`: the A22-04 repro (HWM and peak heap around `embedAllSymbols`).

`src/` is unchanged. `pushfix` is a patched copy of `dist` in the scratchpad.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-22.test.ts` | A22-01: resolve runs in one event-loop turn (`it.fails`). A22-02: the carry copies N²/2 slots (`it.fails`). Plain tests: the SG55 split stays bounded across two files and an edit; repeated forced runs keep the vec0 chunks and counts; SG45 open takes no write lock; SG34 calls made together share one run. Counts work and orders events, with one 2.5 s open bound; about 2 s in all. Each `it.fails` was run once as a plain `it` and failed with the message quoted above. |

## Verification

`npm run typecheck && npm run lint && npm test` pass. Wall clock: typecheck 9.7 s (load 6.3), lint 4.6 s (6.0), `npm test` 42.5 s (4.9; 82 files, 787 passed and 1 todo). `test:perf` was not run.
