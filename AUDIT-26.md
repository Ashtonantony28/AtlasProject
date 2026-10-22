# AUDIT-26: performance under load (round 7)

Auditor: a fresh subagent that wrote none of the audited code. Base: `5c83aad` (SG65 and SG80 merged on top of the AUDIT-22 base `121fffa`), worktree `atlas-audit-26`.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22. Other sessions ran the whole time; the 1-minute load average moved between 2.1 and 7.5. The load is given with each run. Compare builds inside a group, not across groups.

| Build | What it is |
| --- | --- |
| current | `5c83aad` (`npm run build`) |
| `945a2cb` | Parent of SG80 (SG65 merged, index writes still deferred), extracted with `git archive` into the scratchpad |
| `121fffa` | AUDIT-22 base (no SG65), for the open-cost comparison only |

## Workloads

| Name | Source | Files | Symbols | Edges |
| --- | --- | --- | --- | --- |
| realistic 10k | AUDIT-18 `r10k` (`scripts/audit-repo.mjs`) | 10,501 | 152,773 | 230,352 |
| dense 10k | AUDIT-18 `d10k` (`gen-dense.mjs`) | 10,001 | 90,002 | 749,769 |
| realistic 3k (new copy) | `scripts/audit-repo.mjs <a26>/r3k 3000`, indexed in place for the MCP and dashboard runs | 3,151 | 45,839 | 69,072 |
| dup30000 | AUDIT-18 | 3 | 30,005 | 3 |
| got, express | `<scratch>/repos` clones | 96 / 141 | | |

## SG80: the cost of `immediate` on large runs

### Uncontended (`micro.mjs`, 20,000 transactions of one INSERT, load 3.0–3.2, three runs)

| Transaction | µs per call |
| --- | --- |
| `db.transaction(fn)()` (deferred, before SG80) | 16.4–23.6 |
| `tx.immediate()` alone | 18.6–22.4 |
| `immediate(db, fn)` | **32.8–48.0** |
| the two `busy_timeout` pragmas alone | 5.3–8.6 |
| `immediate` nested in a transaction (savepoint, prune's `deleteFile`) | 33.7–42.0 (plain nested: 24.1–26.1) |

`immediate` adds 17–26 µs per write transaction: the two pragmas plus a fresh `db.transaction` wrapper per call. At 10k files that is under 0.3 s, and it is not visible in whole runs:

### Whole runs (`probe.mjs`, interleaved, longest event-loop gap of a 5 ms timer)

| Workload (load) | Run | `945a2cb` total / longest block | current total / longest block | AUDIT-22 |
| --- | --- | --- | --- | --- |
| realistic 10k (2.1–3.7) | fresh | 69.4 s / 4.36 s (resolve) | **66.3 s / 4.57 s** | 76.9 s / 4.73 s |
| | no-op | 1.10 s / 0.74 s (embed setup) | 1.15 s / 0.82 s | 1.04–1.11 s / 0.73–0.80 s |
| | `--force` | 97.6 s / 4.54 s | **96.8 s / 4.14 s** | 104.8 s / 4.24 s |
| dense 10k (3.6–6.9) | fresh | 56.7 s / 8.70 s | **54.2 s / 8.70 s** | 58.5 s / 11.10 s |
| | `--force` | 113.5 s / 9.91 s | **114.2 s / 9.87 s** | 122.5 s / 11.27 s |

- No regression: each pair is within noise, and HWM is unchanged (453–495 MB realistic, 642–673 MB dense; AUDIT-22 453–492 / 687).
- Yields per run are unchanged (1,069 / 1,556 / 7 against 1,122 / 1,568 / 7).
- `got` parse+insert median 5.27 / 5.92 / 6.23 ms (load 3.4–3.6), express 2.10 / 2.28 / 2.64: A18-05 unchanged, budget PASS.
- An uncontended index run takes the write lock exactly once per transaction (run stamp, one per file, resolve, embed batches, finish stamp), with no retries. Prune's per-file `deleteFile` runs as savepoints inside prune's one transaction (pinned).

### Waiting costs no CPU (`waitcpu.mjs`)

A 0.74 s wait used 20 ms of CPU; a wait that gave up at 5,003 ms used 124 ms (about 2.5% of one core). The retry sleeps in SQLite's busy handler, 10 ms at a time. It does not spin (pinned).

## Concurrent writers

### `atlas docs` beside a forced index (`writers.sh`, realistic 3k, CLI, two rounds, load 4.3–6.2)

| Run | Alone | Together |
| --- | --- | --- |
| `atlas index --force` | 28.1 / 31.5 s | 33.4 / 34.0 s (+8–19%) |
| `atlas docs --offline --force` (3,152 doc writes) | 2.7 / 3.6 s | 7.3–9.4 s per run, 4 runs per index |

Every run exited 0 (8 docs runs and 2 index runs). Before SG80, the same pairing failed the index at once with `index write: database is locked` (A23-01). The docs slowdown is per-doc waits behind the index's per-file transactions plus CPU contention. **Throughput is fine.**

### A second writer during a forced dense 10k run (`race2.mjs`, `upsertDoc` every 250 ms, load 6.3)

425 doc writes during the 117.5 s run: p50 wait 0 ms, p99 25 ms. One failed with **`SQLITE_BUSY` after 5,006 ms** at 100.6 s, during the 9.9 s resolve transaction, and the next waited 3,545 ms. The writing process's own event loop stalled **5,008 ms**. That is A22-03, unchanged (AUDIT-22: 5,033 ms and 3,954 ms).

The per-file transaction of dup30000 under `--force` still holds the lock for **7.98 s** (A22-02, AUDIT-22: 8.0 s), so a doc write fails during that file too.

## Event-loop stalls while `immediate` waits

### MCP (`mcpstall.mjs`, `atlas mcp --offline` on realistic 3k, `atlas_index {force}` with `atlas_search` every 100 ms, probe capped at 60 s)

| Other writer (load) | Build | `atlas_index` | Search p50 / p95 / **max** |
| --- | --- | --- | --- |
| none (6.2) | current | ok, 41.1 s | 50 / 83 / **1,505 ms** (the resolve block, A22-01) |
| `atlas docs --offline --force` in a loop (7.0) | current | ok, 45.8 s (5 docs runs, all exit 0) | 45 / 106 / **1,202 ms** (resolve) |
| same (7.1) | `945a2cb` | **fails after 0.9 s**: `index write: database is locked` | 121 / 240 / 240 ms |
| lock held 2 s of every 5 s (6.9) | current | still running at 60 s | 52 / 1,844 / **2,059 ms**: each of the 12 holds |
| same (7.3) | `945a2cb` | fails after 2.2 s | 82 / 130 / 130 ms |
| lock held 5.5 s (7.2) | current | fails after 7.2 s, `index write: … (another process …; retry when it finishes)` | **5,005 ms** |
| lock held 4 s of every 4.2 s (7.5) | current | still running at 60 s | 72 / 3,965 / **3,976 ms**: 12 stalls of 3.9 s, the server answered nothing for 95% of the minute |

**Maximum MCP stall: 5,005 ms**, bounded by the busy timeout. With a real concurrent writer (`atlas docs`) SG80 adds no stall: the index finishes, the docs runs finish, and the longest wait is still the resolve block. A stall happens only when another connection holds the write lock for long, and then it lasts as long as the hold (A26-01).

### Dashboard (`serveprobe2.mjs`, `atlas serve` on realistic 3k, `/api/search` and `/api/stats` every 100 ms)

| Other writers (load) | Probes | Search p50 / p95 / **max** | Stats max | Errors |
| --- | --- | --- | --- | --- |
| `atlas index --force` and an `atlas docs --force` loop, together (4.8) | 181 | 35 / 89 / **133 ms** | 155 ms | 0 |
| three 6 s write-lock holds (5.1) | 100 | 50 / 58 / **72 ms** | 57 ms | 0 |

`serve` is a separate read-only process, and it never calls `immediate`. WAL readers do not wait for the writer. **Maximum dashboard stall: 155 ms, no finding** (AUDIT-22: 272 ms).

## SG65: creating a fresh index in WAL mode (`openbench.mjs`, 40 opens, 16 processes opening one fresh path)

| Build | Fresh open p50 / max | Re-open p50 / max | 16 concurrent fresh opens |
| --- | --- | --- | --- |
| current | 5.87–6.37 / 21–29 ms | 0.75–0.91 / 1.7–2.3 ms | 0 errors, slowest 73–84 ms, no leftover `.tmp`, `-wal` or `-shm` |
| `121fffa` | 5.44–5.61 / 22–35 ms | 0.81–0.82 / 1.3–1.4 ms | 0 errors, slowest 72–155 ms |

`createWalFile` adds about 0.4–0.9 ms once per new index. Re-opens are unchanged (AUDIT-22: 0.72 ms). **No finding.**

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-22 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express) | 2.21 | **2.10 / 2.28 / 2.64** (load 3.4–3.6) | PASS | `node scripts/bench.mjs --target <express>` |
| (same, got; not gated) | 6.11–6.73 | 5.27 / 5.92 / 6.23 | over 5, A18-05 | `bench.mjs --target <got>` |
| no-op re-index ≤ 100 ms / 100 files | realistic 10k 9.9–10.6 | realistic 10k **10.5–10.9** (1,098–1,146 ms) | PASS | `probe.mjs … fresh,noop` |
| `search` p95 ≤ 50 ms at 10k symbols | gated in `test:perf` | not re-run (search code unchanged) | | `npm run test:perf` |

## Findings

Counts: **Critical 0, High 0, Medium 0, Low 1** (new). Still open, re-measured: A22-01, A22-02, A22-03, A22-05, A18-03, A18-05 (see the table below). A22-04 was not re-measured: `makeSourceLoader` and `embedAll`'s setup did not change. SG80 and SG65 cost nothing measurable, and SG80 turns A23-01's immediate failure into a successful run beside `atlas docs`.

### Low

#### A26-01: `immediate` waits for the write lock synchronously, so an index run in the MCP server freezes the server for as long as another connection holds the lock, up to 5 s per write transaction
- **Evidence:**
  - `mcpstall.mjs` (MCP table): a single 5.5 s hold stalled an `atlas_search` for **5,005 ms**, after which `atlas_index` failed. A 2 s hold every 5 s gave a 1.9–2.1 s stall on each hold. A writer holding the lock 4 s of every 4.2 s left the server answering nothing for 95% of the minute (12 stalls of 3.9–4.0 s), and the run made almost no progress.
  - Each write transaction waits independently. A run of N files can stall N times, so the total stall of a run is unbounded under a hostile writer. Only each single stall is bounded, at 5 s.
  - The same wait blocks every other caller: `atlas docs`' `upsertDoc` stalled its process **5,008 ms** in `race2.mjs`.
  - Before SG80, the same holds failed the run at once (A23-01; `945a2cb` failed after 0.9–2.2 s with no stall). SG80 trades that failure for a stall, which is the better outcome for the CLI but not for a server whose only thread also answers searches. DECISIONS.md (SG80) does not mention the event-loop cost.
  - With the concurrent writer Atlas itself produces (`atlas docs`), the stall is not visible (1,202 ms max, the resolve block). Index runs are serialised by the SG32 index lock, so the long holders are a non-Atlas writer, a pending migration, or a lock held from another tool.
  - `test/audit/audit-26.test.ts` A26-01 (`it.fails`): while an index run waits out a 300 ms hold from another connection, a 5 ms timer stops (`expected 306.150073 to be less than 100`).
- **Repro:** `node <a26>/scripts/mcpstall.mjs $PWD <indexed r3k> hold:5500:1000` (and `hold:2000:3000`, `hold:4000:200`, `docs`; `$PWD` replaced by `<a26>/ab-945a2cb` for the A/B) · `npx vitest run test/audit/audit-26.test.ts`
- **Cause:** `immediate` (`src/core/db/database.ts:102-123`) loops `tx.immediate()` with a 10 ms `busy_timeout`. Each try sleeps inside SQLite on the main thread. Its index-run callers (`indexer.ts:267, 381, 454, 461, 518`, `resolver.ts:74`, `embedAll.ts:78`) are all inside the async `runIndex`, which could await instead.
- **Fix:** an `immediateAsync(db, fn)` for the async callers: try `BEGIN IMMEDIATE` with `busy_timeout = 0`, and on `SQLITE_BUSY` `await` a 10 ms timer before retrying, up to the same deadline. Keep the synchronous `immediate` for `upsertDoc` and `deleteFile`, whose callers are CLI-only. That keeps SG80's semantics and lets the server answer between tries.
- **Severity:** Low. Each stall is bounded at 5 s, below the MCP client's 60 s timeout. It needs another connection that holds the write lock for long, which no Atlas command does while an index run holds the index lock. With Atlas's own concurrent writer it adds nothing.

### Open from AUDIT-22 and AUDIT-18 (re-measured)

| ID | AUDIT-22 | Now | Status |
| --- | --- | --- | --- |
| A22-01 resolve is one block | 4.2–4.7 s realistic 10k, 11.1–11.3 s dense 10k; MCP search 4,632 ms | 4.14–4.57 s realistic, 8.70–9.87 s dense (`945a2cb` 4.36–4.54 / 8.70–9.91); MCP 3k search max 1,505 ms. The lock is now taken by `BEGIN IMMEDIATE` instead of `clearEdges`, which was already the first statement, so it is held just as long. | Open. The A22-01 `it.fails` still fails as expected. |
| A22-02 carry quadratic in same-name symbols | dup30000 `--force` 8.0 s block | **7.98 s** block, 9.9 s total (load 3.3). The per-file transaction holds the write lock all that time, so a doc write beside it fails (A22-03). | Open. `it.fails` still fails as expected. |
| A22-03 a second writer fails after 5 s | 1 of 419 failed after 5,033 ms; next waited 3,954 ms | 1 of 425 failed after **5,006 ms**; next waited 3,545 ms; p99 25 ms. Readers are unaffected. SG80 did not change the 5 s timeout, the resolve length or the docs path's lack of the index lock. | Open (Medium) |
| A22-04 embed source cache unbounded | +294 MB for 296 MB of source | not re-measured; code unchanged | Open |
| A22-05 embed setup block | 0.7–1.0 s at 10k | 0.65–0.87 s (`945a2cb` 0.67–0.75) | Open (Low) |
| A18-03 carry re-inserts edges on `--force` | dense 10k `--force` 122.5 s | 113.5–114.2 s at load 3.7–6.9, with a 1.06 s `hub.ts` carry block | Open. A18-03 `it.fails` still fail as expected. |
| A18-05 got median | 6.11–6.73 | 5.27–6.23 | Open |

## No finding

- **SG80 uncontended cost:** +17–26 µs per write transaction, invisible in 10k runs (66.3 / 96.8 / 54.2 / 114.2 s against `945a2cb`'s 69.4 / 97.6 / 56.7 / 113.5 s). Exactly one lock per transaction, and prune takes one (pinned).
- **SG80 under a real second writer:** `atlas index --force` and an `atlas docs` loop both succeed (index +8–19%, docs 2.5–3× slower). A23-01 is fixed in practice.
- **SG80 wait CPU:** 20 ms per 0.74 s wait, 124 ms per 5 s (pinned).
- **Dashboard:** a maximum of 155 ms while two writers run, and 72 ms through three 6 s holds (read-only connection, pinned).
- **SG65:** +0.4–0.9 ms per fresh index; 16 concurrent fresh opens all succeed and leave no temporary files; re-open cost is unchanged.
- **Memory:** HWM is flat at 10k (453–495 / 642–673 MB). Nothing that SG65 or SG80 adds keeps state across calls, beyond better-sqlite3's per-connection transaction controller.

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a26>` is `<scratch>/a26`. The scripts are in `<a26>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first):
- `probe.mjs`, `race.mjs`, `serveprobe.mjs`, `mcpq.mjs`, `gen-*.mjs`: AUDIT-22's, copied.
- `big.sh`: the interleaved 10k table (`probe.mjs` with current and `945a2cb` on `r10k` and `d10k`).
- `micro.mjs <dist> <dir> [n]`: µs per call of deferred, `tx.immediate()`, `immediate`, the pragmas, and nested transactions.
- `waitcpu.mjs <dist> <dir>`: CPU and `fn` runs while `immediate` waits on `holder.mjs` for 1 s and 6 s.
- `holder.mjs <db> <holdMs> <gapMs> [startMs]`: another process that takes `BEGIN IMMEDIATE` for `holdMs` every `holdMs + gapMs`.
- `race2.mjs <atlasRoot> <indexedRepo> [ms]`: `race.mjs` with `dist`'s `upsertDoc` (SG80's path), wait p50/p99/max and its own event-loop gap.
- `mcpstall.mjs <atlasRoot> <indexedRepo> none|docs|hold:H:G`: an MCP `atlas_index {force}` with a search probe every 100 ms, while another process writes. `mcpall.sh` runs the table.
- `serveprobe2.mjs <atlasRoot> <indexedRepo> <port> index+docs|hold:H:N`: `atlas serve` probes while other processes write.
- `writers.sh <atlasRoot> <repo> <rounds>`: index and docs alone, then together.
- `openbench.mjs <dist> <dir> [n] [procs]`: fresh and re-open cost, concurrent fresh opens, and leftovers.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-26.test.ts` | A26-01: an index run waiting on another writer's 300 ms hold stops the event loop (`it.fails`; run once as a plain `it`, it failed with `expected 306.150073 to be less than 100`). Plain tests: an uncontended run takes the lock once per transaction (2 × (files + 3) `busy_timeout` pragmas); pruning 50 files takes it once; a 1 s wait uses under 300 ms of CPU; a read-only connection reads at once through a held write lock. About 2.7 s in all, mostly the two holds. |

## Verification

`npm run typecheck && npm run lint && npm test` pass. Wall clock: typecheck 8.6 s (load 0.8), lint 4.7 s (1.1), `npm test` 69.9 s (1.1; 88 files, 851 passed and 1 todo). `test:perf` was not run.
