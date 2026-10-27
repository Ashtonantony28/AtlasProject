# AUDIT-30: performance under load (round 8)

Auditor: a fresh subagent that wrote none of the audited code. Base: `6923d13` (SG90 `40b5534` on top of the AUDIT-26 base `5c83aad`, plus the AUDIT-26/27 test commits), worktree `atlas-audit-30`. The only `src/` change since AUDIT-26 is `src/core/db/database.ts` (SG90: `switchToWal` and the stale-WAL check in `openDatabase`).
Machine: 4 vCPU, 16 GiB RAM, Node 22.22, ext4 at 84% full. Other sessions ran during the first half, and the 1-minute load average moved between 3.9 and 21. The container restarted mid-audit. The second half (dup30000, `race2`, `mem`, `bench`, the gates) ran on a fresh boot at load 1.1–5.0. The load is given with each run. Compare builds inside a group, not across groups.

| Build | What it is |
| --- | --- |
| current | `6923d13` (`npm run build`) |
| `5c83aad` | Parent of SG90 (AUDIT-26 base), extracted with `git archive` into the scratchpad |

## Workloads

The AUDIT-18/22/26 repos are reused, so the numbers compare directly: realistic 10k (`a18/r10k`: 10,501 files, 152,773 symbols, 230,352 edges), dense 10k (`a18/d10k`: 10,001 / 90,002 / 749,769), realistic 3k (a copy of AUDIT-26's `r3k`, indexed in place: 3,151 files), dup30000, big600 (600 × 500 KB), and the express and got clones.

New for SG90: **stale-WAL templates** (`mkstale.mjs`). A child opens an index, turns autocheckpoint off, writes rows until the WAL reaches the target size, then SIGKILLs itself. `index.db` is then deleted, which leaves `index.db-wal` and `-shm` as a killed run leaves them. Sizes are 4,532,032 bytes, 70,373,752 bytes (67 MB) and 268,488,072 bytes (256 MB).

## SG90: opening beside a stale WAL

### Sequential first opens (`stalebench.mjs`, 30 opens each, 16-process race × 8 rounds, load 5.2–9.6)

| Build | Stale WAL | First open p50 / max | 16 concurrent opens: errors, slowest p50 / max | Comes up fresh |
| --- | --- | --- | --- | --- |
| current | none (SG65 linked file) | 29.7 / 46.6 ms | 0 of 128; 99 / 167 ms | yes |
| current | 4.3 MB + shm | 31.3 / 44.2 ms | 0 of 128; 103 / 144 ms | yes, 0 non-fresh |
| current | 67 MB + shm | 123.7 / 161 ms | 0 of 128; 188 / 387 ms | yes, 0 non-fresh |
| `5c83aad` | none | 29.9 / 53.9 ms | 0; 157 / 264 ms | yes |
| `5c83aad` | 4.3 MB + shm | 28.9 / 37.6 ms | 0; 134 / 163 ms | **no: 30 of 30 sequential and 128 of 128 raced opens replay the WAL (A25-01)** |
| `5c83aad` | 67 MB + shm | 120.2 / 148.3 ms | 0; 646 / 842 ms | no (same) |

- The discard costs as much as deleting the file, and it does not read the WAL. At load 7.9–8.6, with 10 opens per row, first-open p50 was 30 ms with no WAL, 74–76 ms with the 67 MB WAL and 134–163 ms with the 256 MB WAL, with or without `-shm`. A plain `unlinkSync` of the same files took 36–43 ms (67 MB) and 133–408 ms (256 MB) on this disk. That is a one-time cost per deleted index, and it is the same as `rm`. **No finding.**
- Fresh-open cost has not changed between builds. AUDIT-26's own `openbench.mjs` gave current 32.2–32.5 ms p50 and `5c83aad` 32.2 ms. Re-opens were 1.07–1.14 ms against 1.22 ms. Every run in the 16-process race succeeded, with nothing left over. AUDIT-26 measured 5.9 ms on the same script. Both builds moved by the same amount, so the change comes from the machine (disk full, high load), not from SG90.

### Concurrent first opens (`stalebench.mjs`, processes released at one instant by a busy-wait barrier, load 8.9–21)

| Stale WAL | Processes × rounds | Errors | Opens that retried the switch | Slowest open p50 / max | Child CPU p50 / max |
| --- | --- | --- | --- | --- | --- |
| 4.3 MB + shm | 32 × 15 | 0 | 13 of 480 (one retry each) | 149 / 504 ms | 7 / 14 ms |
| 4.3 MB, no shm | 32 × 15 | 0 | 1 of 480 | 215 / 482 ms | 7 / 12 ms |
| 4.3 MB + shm | 8 × 40 | 0 | 2 of 320 | 74 / 369 ms | 7 / 12 ms |
| none (linked file) | 32 × 15 | 0 | n/a (SG65 path) | 213 / 451 ms | 9 / 31 ms |

With natural start skew, the retry is rare (at most one extra try per open) and cheap. When the openers are lined up behind a lock, the race fails some of them (A30-01).

### Waiting in `switchToWal` (`waitload.mjs switch`: another process holds `BEGIN IMMEDIATE` on the 0-byte file, load 13–17)

| Hold | Openers | Waited | CPU per opener | `journal_mode` tries | Result |
| --- | --- | --- | --- | --- | --- |
| 1 s | 1 | 997 ms | 30 ms | 90 | ok |
| 1 s | 8 | 730–857 ms | 18–26 ms | 68–77 | 7 ok, **1 `journal mode: database is locked`** (A30-01) |
| 6 s | 1 | 5,009 ms | 102 ms | 486 | fails at the 5 s deadline, as designed |
| 6 s | 8 | 5,005–5,028 ms | 80–97 ms | 486–488 | all fail at the deadline |

The retry loop sleeps (`Atomics.wait`, 10 ms) and uses about 2% of one core while it waits: 102 ms of CPU over 5 s, or 486 tries, roughly one every 10.3 ms. It blocks the event loop the way `immediate` does. Only `openDatabase` calls it, though, and a running server never does: `atlas mcp` opens once at startup and `atlas serve` opens read-only. **No finding** for the CPU. The failure in row 2 is A30-01.

## SG80 `immediate()` under load

### Waiting (`waitload.mjs imm`, load 13–15)

| Hold | Waiters | Waited | CPU per waiter | Result |
| --- | --- | --- | --- | --- |
| 1 s | 1 | 895 ms | 15 ms | ok |
| 1 s | 8 | 62–848 ms | 1–11 ms | 8 ok, serialised after the release |
| 6 s | 1 | 5,003 ms | 91 ms | SQLITE_BUSY at the deadline |
| 6 s | 8 | 5,003–5,009 ms | 49–69 ms | all SQLITE_BUSY at the deadline |

AUDIT-26 measured 20 ms per 0.74 s and 124 ms per 5 s. Eight waiters on one lock each cost about the same as one, so the cost is **unchanged**.

### Saturated writers (`waitload.mjs storm`, each process runs back-to-back 20 ms write transactions for 10 s, load 6.4–6.9)

| Writers | Transactions per writer | Max wait for the lock | SQLITE_BUSY | CPU while waiting |
| --- | --- | --- | --- | --- |
| 2 | 266 / 270 | 921–923 ms | 0 | 110–111 ms |
| 4 | 102–166 | 776–1,258 ms | 0 | 118–141 ms |
| 8 | 47–86 | 1,180–2,407 ms | 0 | 128–142 ms |

Polling every 10 ms is not FIFO. A writer that commits and starts again at once often takes the lock back ahead of a poller: with 2 writers a single wait reached 923 ms, and with 8 writers throughput per writer ranged 47–86. No writer reached the 5 s deadline. Atlas has no back-to-back writers: index runs are serialised by the SG32 lock and yield between files, and `atlas docs` writes one doc per transaction. **No finding.** This is recorded as a limit: about 8 saturating writers is where waits reach half the deadline.

## Whole runs (`big.sh` → `probe.mjs`, interleaved, longest event-loop gap of a 5 ms timer)

| Workload (load) | Run | `5c83aad` total / longest block | current total / longest block | AUDIT-26 current |
| --- | --- | --- | --- | --- |
| realistic 10k (4.1–6.3) | fresh | 65.4 s / 4.41 s (resolve) | **66.4 s / 4.14 s** | 66.3 s / 4.57 s |
| | no-op | 1.06 s / 0.73 s (embed setup) | **0.98 s / 0.69 s** | 1.15 s / 0.82 s |
| | `--force` | 95.7 s / 4.56 s | **90.3 s / 4.19 s** | 96.8 s / 4.14 s |
| dense 10k (4.5–5.3) | fresh | 52.0 s / 8.05 s | **52.7 s / 8.68 s** | 54.2 s / 8.70 s |
| | `--force` | 102.5 s / 9.11 s | **104.5 s / 8.81 s** | 114.2 s / 9.87 s |

Each pair is within noise, and HWM is unchanged (realistic 453–505 MB, dense 642–689 MB; AUDIT-26: 453–495 / 642–673). **No regression.** The resolve block is still the longest gap in every resolving run (A22-01).

## MCP responsiveness (`mcpstall.mjs`, `atlas mcp --offline` on realistic 3k, `atlas_index {force}` with `atlas_search` every 100 ms, load 6.6–7.2)

| Other writer | `atlas_index` | Search p50 / p95 / **max** | AUDIT-26 |
| --- | --- | --- | --- |
| none | ok, 39.6 s | 47 / 88 / **1,391 ms** (resolve) | 50 / 83 / 1,505 |
| `atlas docs --offline --force` loop | ok, 52.8 s (6 docs runs, all exit 0, 7.0–9.0 s each) | 55 / 124 / **1,162 ms** (resolve) | 45 / 106 / 1,202 |
| lock held 2 s every 5 s | still running at 60 s | 51 / 1,917 / **2,056 ms**, 12 stalls of 1.3–2.1 s | 52 / 1,844 / 2,059 |
| lock held 5.5 s | fails at 7.3 s: `index write: … (another process …; retry when it finishes)` | **5,034 ms** | 5,005 |
| lock held 4 s every 4.2 s | still running at 60 s | 74 / 3,972 / **4,032 ms**, 12 stalls of 3.9–4.0 s | 72 / 3,965 / 3,976 |

A26-01 and A27-03 are **unchanged**. Index plus `docs`, the realistic pairing, still adds no stall.

## Dashboard beside writers (`serveprobe2.mjs`, `atlas serve` on realistic 3k)

| Other writers (load) | Probes | Search p50 / p95 / **max** | Stats max | Errors |
| --- | --- | --- | --- | --- |
| `atlas index --force` and an `atlas docs --force` loop (5.8) | 213 | 30 / 79 / **273 ms** | 275 ms | 0 (index and docs exit 0) |
| three 6 s write-lock holds (6.6) | 98 | 53 / 63 / **68 ms** | 64 ms | 0 |

The dashboard stays read-only and the WAL readers never wait. **No finding** (AUDIT-26: 133 / 155 ms; AUDIT-22: 272 ms).

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-26 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express) | 2.10–2.64 | **2.07 / 2.23 / 2.32** (load 1–2, after restart) | PASS | `node scripts/bench.mjs --target <express>` |
| (same, got; not gated) | 5.27–6.23 | 5.30 / 5.46 / 6.12 | over 5, A18-05 | `bench.mjs --target <got>` |
| no-op re-index ≤ 100 ms / 100 files | realistic 10k 10.5–10.9 | realistic 10k **9.3** (980 ms); express 13–21 (18–30 ms / 141 files) | PASS | `probe.mjs … fresh,noop` |
| `search` p95 ≤ 50 ms at 10k symbols | not re-run | **18.78 ms** at 10,206 symbols (load 4.7) | PASS | `npm run test:perf` |
| `test:perf` (all 9 budgets) | not run | parse+insert 3.21 ms/file, no-op 10.6 ms/100, resolver 455 ms/1k, Python monorepo 81 ms/1k, walks 159–189 µs/file, cached synth 177 ms, drift 421 ms | PASS | `npm run test:perf` |

## Findings

Counts: **Critical 0, High 0, Medium 0, Low 1** (new). Still open and re-measured with no change: A22-01, A22-02, A22-03, A22-04, A22-05 and A26-01 (Low), A27-03 (Medium in AUDIT-27; same cause as A26-01), A18-03 and A18-05. SG90 costs nothing measurable. It fixes A25-01's replay, the discard is O(unlink), and the retry is rare and cheap, except for the race in A30-01.

### Low

#### A30-01: `switchToWal` checks the file size after the failed try, so a process that loses the race to switch an empty index to WAL fails with `journal mode: database is locked` instead of retrying
- **Evidence:**
  - `waitload.mjs switch 500 16`, 20 rounds (load 8.4–9.5): 16 processes wait on another process's hold of a 0-byte file, and all retry on the same 10 ms ticks. **2 of 320 opens failed** with `SQLITE_BUSY` after 43 and 184 ms (4 and 13 tries), and `statSync(index.db).size` was **4096** at the failure. With 8 processes and a 1 s hold, 1 of 8 failed (load 16.6) and 0 of 200 in 25 later rounds (load 8.9).
  - The winner's switch of an empty file writes page 1 at once (pinned: 0 → 4,096 bytes). The loser's try fails at once with SQLITE_BUSY, because SQLite refuses the read-to-write upgrade without a busy wait. `switchToWal` then stats the file, sees 4,096 bytes and treats the error as a foreign rollback-mode file (`!empty` → throw). Its next try would have succeeded, because the file is now in WAL mode.
  - Openers released together with natural skew rarely hit the window: 0 of 1,280 concurrent opens failed in `stalebench.mjs` (32 × 15 twice, 8 × 40), with 16 retries in all. SG90's own 6 × 60 race test passes. The window is between the loser's failed try and its `statSync`, and the winner's write has to land inside it.
  - `test/audit/audit-30.test.ts` A30-01 (`it.fails`): the race is injected. On the opener's first try, another connection switches the empty file and the try reports SQLITE_BUSY. `openDatabase` then throws `journal mode: database is locked (another process is writing the index; retry when it finishes)` instead of opening in WAL mode.
- **Repro:** `for i in $(seq 20); do node <a30>/scripts/waitload.mjs $PWD/dist <a30>/out/wl switch 500 16; done` (count `"ok":0` lines) · `npx vitest run test/audit/audit-30.test.ts`
- **Cause:** `src/core/db/database.ts:102-116` (line 111): `const empty = statSync(dbPath…)?.size === 0` is evaluated after `db.pragma('journal_mode = WAL')` has failed, not before it.
- **Fix:** stat the file before the try and retry if it was empty then, or if the header now says WAL (bytes 18–19 = 2). A non-empty rollback-mode file held by another program still fails at once, as DECISIONS.md (SG90) intends.
- **Severity:** Low. It needs a stale WAL beside a deleted index (the SG90 path) and openers lined up closely. The error names its cause and says that a retry works, and a retry does work.

### Open from AUDIT-26, AUDIT-22 and AUDIT-18 (re-measured)

| ID | AUDIT-26 | Now | Status |
| --- | --- | --- | --- |
| A22-01 resolve is one block | 4.14–4.57 s realistic, 8.70–9.87 s dense; MCP 3k max 1,505 ms | **4.14–4.19 s** realistic, **8.68–8.81 s** dense (`5c83aad` 4.41–4.56 / 8.05–9.11); MCP 3k max 1,162–1,391 ms | Open, unchanged. The A22-01 `it.fails` still fails as expected. |
| A22-02 carry quadratic in same-name symbols | dup30000 `--force` block 7.98 s | **9.29 s** block, 11.2 s total (load 1.9, after restart); fresh 5.6 s / 2.0 s | Open, unchanged within noise |
| A22-03 a second writer fails after 5 s | 1 of 425 failed after 5,006 ms; next waited 3,545 ms | Run 1 (cold page cache right after the restart, load 4.4): **2 of 386 failed** (5,004 ms at 5.1 s, 5,010 ms at 98.6 s, during resolve); p99 2,303 ms. Run 2 (load 5.0): 1 of 353 failed after **5,007 ms** (resolve); next waited 3,862 ms; p99 14 ms. The writer's own event loop stalled 5,008–5,011 ms. | Open (Medium), unchanged. The extra early failure came with a cold cache. |
| A22-04 embed source cache unbounded | not re-measured | big600: after the parse HWM is 113 MB with 8 MB heap; embed peak heap **303 MB**, HWM **407 MB** (AUDIT-22: 305 / 404). `--max-old-space-size=200`: **`FATAL ERROR: … JavaScript heap out of memory`** in the embed phase | Open, unchanged |
| A22-05 embed setup block | 0.65–0.87 s | 0.69 s (no-op), 0.83 s (fresh), 0.66 s (`--force`); `5c83aad` 0.61–0.80 s | Open (Low) |
| A26-01 `immediate` stalls the MCP event loop | 5,005 ms max under a 5.5 s hold | **5,034 ms**; 12 stalls of 1.3–2.1 s (2 s holds) and of 3.9–4.0 s (4 s holds) | Open (Low). The A26-01 `it.fails` still fails as expected. |
| A27-03 MCP search waits behind `atlas_index`'s lock wait | 4,719 ms under an 8 s hold | 5,034 ms under a 5.5 s hold (same mechanism as A26-01) | Open (Medium in AUDIT-27). Its `it.fails` still fails as expected. |
| A18-03 carry re-inserts edges on `--force` | dense 10k `--force` 113.5–114.2 s | 102.5–104.5 s (load 4.6–4.8), with a 1.12–1.17 s `hub.ts` carry block | Open |
| A18-05 got median | 5.27–6.23 | 5.30–6.12 | Open |

## No finding

- **SG90 open cost:** with no stale WAL, the open is the same as `5c83aad` (32 ms p50 on both today). Beside a stale WAL it costs one `unlink` of the WAL (about 0.6 ms per MB on this disk) and is never replayed. The open switches exactly once when nobody races it (pinned).
- **SG90 retry CPU:** 10 ms sleeps, about 2% of a core, about 1 try per 10 ms, and it gives up at 5 s (pinned: ≤ waited / 10 ms + 2 tries).
- **SG80 under load:** a wait costs about 15 ms of CPU per second whether 1 or 8 processes wait. 8 saturating writers reach no deadline (max wait 2.4 s), and `atlas docs` beside a forced index succeeds every time (pinned: 1 s wait < 300 ms CPU).
- **10k runs, budgets, search p95, dashboard:** unchanged or better, and every gate passes.

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a30>` is `<scratch>/a30`. The scripts are in `<a30>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first):
- `probe.mjs`, `race2.mjs`, `mcpstall.mjs`, `serveprobe2.mjs`, `holder.mjs`, `mem.mjs`, `openbench.mjs`: AUDIT-26's, copied. `big.sh`, `mcpall.sh` and `serveall.sh` are pointed at this worktree and `ab-5c83aad`. `rest.sh` runs dup30000, `race2`, `mem` and `bench`.
- `mkstale.mjs <dist> <dir> <mb>`: a stale-WAL template (writer SIGKILLed with about `mb` MB in its WAL, index deleted).
- `stalebench.mjs <dist> <dir> <tpl|none> [n] [procs] [rounds] [shm]`: sequential first opens beside a template, and `procs` processes opening one such path at one instant. Reports errors, `journal_mode` tries per process, child CPU, and whether the index came up fresh.
- `waitload.mjs <dist> <dir> switch|imm|storm <holdMs> <K>`: K processes waiting in `switchToWal` (a hold on a 0-byte file) or in `immediate` (a hold on a WAL index), or K saturating writers.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-30.test.ts` | A30-01: an opener whose switch fails because a racer switched the empty file first throws instead of retrying (`it.fails`, with the race injected; run once as a plain `it`, it failed with `journal mode: database is locked (another process is writing the index; retry when it finishes)`). Plain tests: a first open beside an 8 MB stale WAL switches once, comes up fresh and drops the WAL; waiting 1 s to switch an empty file makes at most waited / 10 ms + 2 tries with under 400 ms of CPU; a 1 s `immediate` wait uses under 300 ms of CPU; switching an empty file writes page 1 at once (the A30-01 precondition). About 3 s in all, mostly the two 1 s holds. |

## Verification

`npm run typecheck && npm run lint && npm test` and `npm run test:perf` pass. Wall clock: typecheck 11.8 s (load 2.2), lint 7.6 s (3.1), `npm test` 98.1 s (3.6; 92 files, 890 passed and 1 todo), `test:perf` 15.7 s (4.7; 5 files, 9 passed, search p95 18.78 ms at 10,206 symbols).
