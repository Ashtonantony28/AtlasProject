# AUDIT-35: performance under load (round 9)

Auditor: a fresh subagent that wrote none of the audited code. Base: `1a80ba3` (SG130/SG135 on top of SG120 `e2a6fd5`), worktree `atlas-audit-35`. The `src/` changes since AUDIT-30 are SG120/SG130/SG135: `checkLeftoverWal` (with `holders`, `lockOpens`, `integrityOk`, `setAside`) and `closeOnSignal` in `src/core/db/database.ts`, the `answer()`/`nameCorrupt` wrappers in `src/mcp/server.ts`, and `closeOnSignal` in `atlas index`/`docs`/`mcp`.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22, ext4 at 92–98% full. Another session ran its test suite during the middle of the audit. The 1-minute load average moved between 0.1 and 6.3, and the load is given with each run. Compare builds inside a group, not across groups. The page cache was warm for every open (it cannot be dropped in this container).

| Build | What it is |
| --- | --- |
| current | `1a80ba3` (`npm run build`) |
| `68fb2c2` | Parent of SG120 (the AUDIT-31 test commit; same `src/` as AUDIT-30's base), extracted with `git archive` into the scratchpad |

## Workloads

| Name | Source | Files | Symbols | Edges | `index.db` |
| --- | --- | --- | --- | --- | --- |
| 10k symbols | `scripts/audit-repo.mjs <a35>/r700 700` | 736 | 10,693 | 16,083 | 23 MB |
| realistic 3k | AUDIT-30's `r3k`, copied | 3,151 | 45,839 | 69,072 | 113 MB |
| realistic 10k | AUDIT-18 `r10k` | 10,501 | 152,773 | 230,352 | 336 MB |
| dense 10k | AUDIT-18 `d10k` (copied with its index to `<a35>/d10k` for the CLI runs) | 10,001 | 90,002 | 749,769 | 276 MB |

New for SG120/130/135: **killed-writer images** (`mkcrash.mjs`). A copy of a clean index is opened by a writer with autocheckpoint off, which commits rows until its WAL holds about 4.9 MB, and then the writer SIGKILLs itself. `index.db`, its own `-wal` and its `-shm` are left, as a SIGKILL, an OOM kill or a crash leaves them. The WAL belongs to the file, so the check keeps it.

## SG130/SG135: the cost of opening beside a leftover WAL

### One opener (`openwal.mjs`: 5 sequential opens, each in a fresh process that SIGKILLs itself after the open so the WAL stays; load 0.2–0.5)

| Index | No WAL: current / `68fb2c2` | Leftover 4.9 MB WAL: current, writable p50 (min–max) | Read-only | `68fb2c2` | CPU of the open (current) |
| --- | --- | --- | --- | --- | --- |
| 10k symbols | 6.1 / 4.6 ms | **99.8 ms** (94.8–106.1) | 101.7 ms | 6.7 ms | 86 ms |
| realistic 3k | | **348 ms** (331–363) | 341 ms | 6.4 ms | 326 ms |
| realistic 10k | | **1,101 ms** (1,017–1,156) | 1,024 ms | 6.4 ms | 1,087 ms |
| dense 10k | | **1,592 ms** (1,537–1,644) | 1,569 ms | 6.4 ms | 1,561 ms |

- The check is a full `PRAGMA integrity_check` with the WAL replayed, and it is CPU-bound. It costs 3.1–5.8 ms per MB of index (dense is the slowest per MB, because it has 750k edge rows to cross-check against their indexes). The WAL's own size does not matter much.
- With no leftover WAL, the open costs about 1.5 ms more than before (6.1 against 4.6 ms): `walOwner`'s `lstat` and two `stat`s.
- After a crash, a **writable** opener (every CLI command except `serve`, and `atlas mcp`) pays the check once. Its close checkpoints and removes the WAL, so the next open checks nothing (pinned). **Read-only** openers never clear the WAL, so they repeat the check on every open (A35-01). A WAL that a live connection holds is never checked (pinned).
- `OPEN_LOCK_MS` is 60 s. At 3–6 ms/MB, a waiting opener would give up (`open: database is locked`) only behind the check of an index of about 10–18 GB. This is recorded as a limit, not a finding.

### Concurrent openers and `.open.lock` (`concopen.mjs`: realistic 10k image, processes released at one instant, 144 opens in all, load 0.7–2.2)

| Openers | Each one | Open p50 / max | Checks run | `68fb2c2` p50 / max |
| --- | --- | --- | --- | --- |
| 8 read-only | stays open 2 s | 1,457 / 1,756 ms | 1 | 8 / 16 ms |
| 16 read-only | stays open 2 s | 2,071 / 2,780 ms | 1 | 5 / 12 ms |
| 8 writable | closes at once | 2,652 / 3,053 ms | 2 | 9 / 15 ms |
| 16 writable | closes at once | 2,855 / 3,458 ms | 2 | 22 / 33 ms |
| 16 writable | stays open 0.5 s | 2,266 / 3,175 ms | 1 | |
| 8 read-only | closes at once | 5,698 / **9,092 ms** | **8** | |
| 8 read-only | killed at once | 4,781 / 8,273 ms | 7 | |
| 16 read-only | killed at once | 10,587 / **18,612 ms** | **16** | |

- No open failed (0 of 144). The lock makes the openers decide one at a time, as SG135 intends.
- When the first opener is still open, the others see it as a live holder and skip the check. They still queue on `.open.lock` one at a time, and each waits in SQLite's busy handler, which sleeps up to 100 ms between tries. The slowest of 16 openers waited 1.7–2.3 s on top of the 1.1 s check.
- When short-lived read-only openers leave nothing open behind them, each runs the whole check in turn: N openers take N × 1.1 s (A35-01).

### Who repeats the check without any crash (A35-01)

A writer (`atlas index`) that closes while `atlas serve` has the index open is not the last connection, so it does not checkpoint, and its WAL stays (12,392 bytes here). The dashboard's read-only close cannot checkpoint either. Every later `atlas serve` start then runs the full check (`servestart.mjs`, realistic 3k, load 0.3):

| State | `atlas serve` start to listening (4 starts) |
| --- | --- |
| no WAL | 266–333 ms |
| after `atlas index` ran beside an open dashboard, and the dashboard stopped | **579–636 ms**, every start, WAL still 12,392 B |
| after one `atlas search` (a writable open and close) | 266–331 ms, WAL gone |

### `/proc/locks` (`holders`) (`procl.mjs`, `locks.py` holds N extra POSIX locks, 100 per file)

`holders()` runs on every open while a `-wal` of more than 32 bytes exists. That is the case whenever a writer that has written still has the index open, for example `atlas mcp` after an `atlas_index`.

| Extra locks | `/proc/locks` size | Read + parse p50 | `openDatabase` beside a live writer: current / `68fb2c2` |
| --- | --- | --- | --- |
| none (3 locks) | 49 B | 0.02 ms warm. The first read in a fresh process took 0.06–28 ms (10 of 20 over 9 ms) | **19.8 / 4.6 ms** |
| 1,000 | 55 KB | 0.7–1.1 ms | |
| 10,000 | 578 KB | 17–19 ms | **46.5 / 4.7 ms** |
| 30,000 | 1.78 MB | 168–174 ms | **275 (202–751) / 9.2 ms** |

The cost is in the kernel and it is quadratic: a single 8 MB `readSync` takes as long as `readFileSync` (162 against 165 ms at 30k locks). The regex and the `Set` cost 2–4 ms at 30k locks (A35-03).

## SG120: shutdown on SIGINT/SIGTERM (A35-02)

### Idle writer with a large WAL (`sigclose.mjs`: a realistic 10k copy, `openDatabase` + `closeOnSignal`, autocheckpoint off, idle; load 2.2)

| WAL | current: signal to exit | `-wal` after | `68fb2c2` | `-wal` after |
| --- | --- | --- | --- | --- |
| 4.9 MB | 399 ms | none | 8 ms | 4.9 MB kept (next open: the 1.1 s check) |
| 65 MB | 734 ms | none | 11 ms | kept |
| 257 MB | 2,007 ms (SIGINT: 2,766 ms) | none | 7 ms | kept |

The close checkpoints the WAL into `index.db` and fsyncs it. That is the point of SG120, and it is bounded. In real runs the WAL is mostly checkpointed already (below).

### `atlas index --force` on dense 10k, interrupted (`sigrun.mjs` at fixed offsets, `sigres.mjs` at the resolve; load 1.3–3.6)

| SIGINT at | current: signal to exit | `68fb2c2` |
| --- | --- | --- |
| 5, 20, 40, 60, 75, 80, 82, 94, 98, 102 s (outside a long block) | 68–196 ms, no `-wal` left (20–87 MB `-wal` file at the signal) | 16–80 ms at 20/60/94 s, 72 MB `-wal` left |
| 85, 90, 106 s (inside a block) | **3,931**, 1,634, 2,871 ms | |
| 0.3 s after the last file (the resolve block, A22-01) | **10,401 ms** | **29 ms** |

The handler is JavaScript, so it runs only when the event loop is free. In SQLite's busy wait in `immediate` (up to 5 s), and in the resolve block (realistic 10k 4.7–4.8 s, dense 9.6–9.7 s, below), the signal waits. `sig2.mjs`: three SIGINTs 300 ms apart, sent during a 3 s lock wait, ended the process 2,641 and 2,654 ms after the first one. `closeOnSignal` uses `once`, and libuv coalesces the queued signals, so pressing Ctrl-C again does nothing. Only SIGKILL ends the process sooner.

## MCP per-call overhead of `answer()` (`mcpcall.mjs`, in process over `InMemoryTransport`, the sample index, 4,000 calls per tool per build in alternating blocks of 200, three runs, load 4.5–4.8)

| Tool | current p50 / p95 | `68fb2c2` p50 / p95 |
| --- | --- | --- |
| `atlas_symbol` (sync handler, now behind an extra `await`) | 327–331 / 564–616 µs | 317–324 / 540–626 µs |
| `atlas_search` | 939–954 / 1,445–1,493 µs | 933–955 / 1,466–1,581 µs |

That is +3–11 µs (1–3%) at p50 on the cheapest tool, and nothing measurable on search. `nameCorrupt` runs only on a thrown error. **No finding.**

## Whole runs (`big.sh` → `probe.mjs`, interleaved, longest event-loop gap of a 5 ms timer)

| Workload (load) | Run | `68fb2c2` total / longest block | current total / longest block | AUDIT-30 current |
| --- | --- | --- | --- | --- |
| realistic 10k (1.9–4.5) | fresh | 69.5 s / 5.00 s (resolve) | **71.1 s / 4.71 s** | 66.4 s / 4.14 s |
| | no-op | 1.43 s / 1.00 s (embed setup) | **1.37 s / 0.96 s** | 0.98 s / 0.69 s |
| | `--force` | 97.6 s / 4.87 s | **98.6 s / 4.80 s** | 90.3 s / 4.19 s |
| dense 10k (1.1–1.8) | fresh | 51.6 s / 9.15 s | **54.5 s / 9.57 s** | 52.7 s / 8.68 s |
| | `--force` | 99.1 s / 9.73 s | **101.1 s / 9.69 s** | 104.5 s / 8.81 s |

Each pair is within noise, and HWM is unchanged (realistic 457–501 MB, dense 643–690 MB; AUDIT-30: 453–505 / 642–689). **No regression.** Both builds are 0.3–0.6 s slower than in AUDIT-30 in their longest blocks, so the change comes from the machine. Index runs never call the new code (`probe.mjs` opens once, and the run closes cleanly).

## MCP responsiveness (`mcpstall.mjs`, `atlas mcp --offline` on realistic 3k, `atlas_index {force}` with `atlas_search` every 100 ms, load 1.2–1.7)

| Other writer | `atlas_index` | Search p50 / p95 / **max** | AUDIT-30 |
| --- | --- | --- | --- |
| none | ok, 35.8 s | 51 / 81 / **1,344 ms** (resolve) | 47 / 88 / 1,391 |
| `atlas docs --offline --force` loop | ok, 36.3 s (5 docs runs, all exit 0, 5.1–8.5 s each) | 46 / 85 / **1,493 ms** (resolve) | 55 / 124 / 1,162 |
| lock held 2 s every 5 s | still running at 60 s | 50 / 1,880 / **2,039 ms**, 12 stalls of 1.5–2.0 s | 51 / 1,917 / 2,056 |
| lock held 5.5 s | fails at 7.2 s: `index write: database is locked (another process is writing the index; retry when it finishes)` | **4,972 ms** | 5,034 |
| lock held 4 s every 4.2 s | still running at 60 s | 77 / 3,959 / **3,963 ms**, 12 stalls of 3.9–4.0 s | 74 / 3,972 / 4,032 |

A26-01 and A27-03 are **unchanged**.

## Dashboard beside writers (`serveprobe2.mjs`, `atlas serve` on realistic 3k)

| Other writers (load) | Probes | Search p50 / p95 / **max** | Stats max | Errors |
| --- | --- | --- | --- | --- |
| `atlas index --force` and an `atlas docs --force` loop (0.7) | 181 | 34 / 53 / **61 ms** | 87 ms | 0 (index and docs exit 0) |
| three 6 s write-lock holds (1.6) | 100 | 50 / 65 / **86 ms** | 63 ms | 0 |

**No finding** (AUDIT-30: 273 and 68 ms max). The dashboard opened when no WAL was left, so the SG130 check did not run at its start. A35-01 covers the starts that do run it.

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-30 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express) | 2.07–2.32 | **2.16 / 2.42 / 2.45** (load 1–2) | PASS | `node scripts/bench.mjs --target <express>` |
| (same, got; not gated) | 5.30–6.12 | 6.65–6.79, then interleaved current 4.95 / 6.27 / 6.28 against `68fb2c2` 5.12 / 6.96 / 7.22 | over 5, A18-05, unchanged (noise) | `bench.mjs --target <got>` |
| no-op re-index ≤ 100 ms / 100 files | realistic 10k 9.3 | realistic 10k **13.0** (1,368 ms; `68fb2c2` 1,430 ms); express 18–31 ms / 141 files | PASS | `probe.mjs … fresh,noop` |
| `search` p95 ≤ 50 ms at 10k symbols | 18.78 ms | **20.72 ms** at 10,206 symbols (load 4.8) | PASS | `npm run test:perf` |
| `test:perf` (all 9 budgets) | all PASS | parse+insert 3.42 ms/file, no-op 15.2 ms/100, resolver 618 ms/1k, Python monorepo 71 ms/1k, walks 165–178 µs/file, cached synth 166 ms, drift 330 ms | PASS | `npm run test:perf` |

## Findings

Counts: **Critical 0, High 0, Medium 1, Low 2** (new). No SG rows. Still open and re-measured with no change: A22-01, A22-02, A22-03, A22-04, A22-05 and A26-01 (Low), A27-03 (Medium in AUDIT-27), A18-03 and A18-05. SG135's lock holds: 0 of 144 concurrent opens failed. A writable opener pays the integrity check once per leftover WAL, and `answer()` costs nothing measurable.

### Medium

#### A35-02: since SG120, SIGINT and SIGTERM wait for the current synchronous block: Ctrl-C on a dense 10k `atlas index --force` during resolve takes 10.4 s (was 29 ms), and pressing it again does nothing

- **Evidence:**
  - `sigres.mjs`: SIGINT 0.3 s after the last file of `atlas index --force` on dense 10k ended the process after **10,401 ms**. `68fb2c2` took **29 ms**. At random offsets: 68–196 ms outside a block, and 1.6–3.9 s inside one (11 + 3 runs; `68fb2c2` 16–80 ms).
  - `sig2.mjs`: during a 3 s wait for the write lock (`immediate`), three SIGINTs 300 ms apart ended the process 2,641 / 2,654 ms after the first one.
  - Then the close checkpoints the WAL: 0.4 s at 4.9 MB and 2.0 s at 257 MB on realistic 10k (`sigclose.mjs`; `68fb2c2` 7–11 ms, but it left the WAL, so the next open paid the 1.1 s check).
  - The same applies to `atlas mcp` and `atlas docs`, which install the same handler. This is inferred from the blocks they run, not timed separately: a client's SIGTERM during an `atlas_index` resolve waits up to that block (1.3–1.5 s on realistic 3k, the MCP search max above; 4.7–4.8 s on realistic 10k), and `atlas docs` waits up to the 5 s busy timeout while it waits for the lock.
  - `test/audit/audit-35.test.ts` A35-02 (`it.fails`): a child waiting in `immediate` behind a 3 s hold must end within 1.5 s of SIGTERM. Run as a plain `it`, it took 2,394 ms. The idle case passes (held).
- **Repro:** `node <a35>/scripts/sigres.mjs dist/cli/index.js <a35>/d10k 10001 SIGINT 300` (and the same with `<a35>/ab-68fb2c2/dist/cli/index.js`) · `node <a35>/scripts/sig2.mjs $PWD/dist <dir>/t.db` · `npx vitest run test/audit/audit-35.test.ts`
- **Cause:** `src/core/db/database.ts:454-467`: `closeOnSignal` replaces the default action with a JavaScript listener, which runs only between event-loop turns. The longest turns are the resolve transaction (A22-01), SQLite's busy wait in `immediate` (`:385-406`), and the close's checkpoint itself.
- **Fix (options):** make the checkpoint unnecessary on a signal. If the handler finds the event loop busy (for example, a watchdog `Worker` that the main thread sets after each turn), let the default action end the process: SQLite's WAL is crash-safe, and SG130 keeps a killed writer's WAL. Otherwise, close only when the process is idle, and re-raise at once on the second signal (`process.on`, not `once`, with a counter). Shortening A22-01's block also shortens this wait.
- **Severity:** Medium. No data is at risk, and the index stays healthy, but an interactive stop is ignored for up to the longest block (10 s at dense 10k, 5 s in a lock wait). That is a regression from instant, and supervisors that SIGKILL after a short grace period kill a process that is closing.

### Low

#### A35-01: a leftover WAL that passed the integrity check is checked again by every read-only open, and it is left without a crash too, so every `atlas serve` start pays a full O(index) scan

- **Evidence:**
  - `servestart.mjs`: after `atlas index` runs beside an open dashboard and the dashboard stops, every `atlas serve` start on realistic 3k takes **579–636 ms** instead of 266–333 ms (4 of 4 starts). The 12,392-byte WAL never goes away until a writable command runs alone.
  - Per check: 0.10 s (10k symbols), 0.34 s (3k), **1.1 s** (realistic 10k), **1.6 s** (dense 10k), CPU-bound.
  - 8 / 16 concurrent short-lived read-only openers run 8 / 16 checks in turn: the slowest waits **9.1 s / 18.6 s** (`concopen.mjs`).
  - DECISIONS (SG130/SG135) states the cost as "a full integrity check on the first open after a crash, a copy or a move with a WAL". It is per read-only open, and it needs no crash.
  - `test/audit/audit-35.test.ts` A35-01 (`it.fails` ×2): three read-only opens of a killed writer's image, and of an index written while a read-only connection was open, must run `integrity_check` at most once. Today each runs it 3 times (pinned by the precondition test). Writable opens check once and then clear the WAL (held). Opens beside a live writer check nothing (held).
- **Repro:** `node <a35>/scripts/servestart.mjs dist/cli/index.js <repo> 47935 4` after `atlas serve` + `curl /api/stats` + `atlas index <repo>` + SIGINT to serve · `node <a35>/scripts/concopen.mjs $PWD/dist <image>/index.db 16 1 0 kill` (image: `node <a35>/scripts/mkcrash.mjs <clean.db> <image> 4`) · `npx vitest run test/audit/audit-35.test.ts`
- **Cause:** `src/core/db/database.ts:112-131`. The verdict "this WAL fits this file" is not kept. A read-only connection cannot checkpoint the WAL it verified, so the next opener finds the same leftover WAL (`leftoverWal`, `:145-150`, only asks for a WAL over 32 bytes) and checks it again.
- **Fix:** after `integrityOk` passes under the open lock, consume the verified WAL: `PRAGMA wal_checkpoint(TRUNCATE)` on a short writable connection (the dashboard's read-only contract concerns content, and this writes only what the file already holds). Or remember the verdict keyed by the WAL's identity (salts in its header, plus size). Either keeps SG130's guarantees.
- **Severity:** Low. It costs about 1 s per dashboard start at 10k (1.6 s dense), and it goes away after any CLI command. Only read-only openers repeat it, and `atlas serve` is the only one.

#### A35-03: `holders()` reads `/proc/locks` on every open while any WAL exists: +15 ms per CLI command beside a running `atlas mcp` on this VM, and quadratic in the host's lock count (275 ms at 30k locks)

- **Evidence:** `openDatabase` beside a live writer with a WAL takes **19.8 ms** (`68fb2c2`: 4.6 ms) with 3 locks on the host, **46.5 ms** (4.7) with 10k extra POSIX locks, and **275 ms** (9.2) with 30k. Reading `/proc/locks` alone takes 15 ms at 10k and 168 ms at 30k. The first read in a fresh process took 0.06–28 ms even with 3 locks (10 of 20 runs over 9 ms). One large read takes as long as `readFileSync`, so the cost is in the kernel. With no WAL, or with a WAL of 32 bytes or less (an idle `atlas mcp` that has not written), nothing is read.
- **Repro:** `python3 <a35>/scripts/locks.py <dir> 30000 &` then `node <a35>/scripts/openwal.mjs $PWD/dist <db> 5 0 1` with a writer holding `<db>` open after one write (`68fb2c2` for comparison) · `node <a35>/scripts/procl.mjs <db> 10`
- **Cause:** `src/core/db/database.ts:169-182`: `checkLeftoverWal` (`:113-114`) calls `holders` before it knows that the WAL needs a decision. Every open beside a live writer pays one full read of the host's lock table.
- **Fix:** ask the cheap question first. A probe-free test of the `-shm`'s DMS lock (`F_OFD_GETLK`, or a `fcntl` `F_GETLK` through a tiny native helper) costs O(1). Or read `/proc/locks` only after a cheaper sign that the WAL might be stale, for example when the `-shm` header's `mxFrame`/salts do not match the WAL's tail.
- **Severity:** Low. It is +15 ms per open on an ordinary host, and it is significant only on hosts with tens of thousands of POSIX locks.

### Open from AUDIT-30, AUDIT-26, AUDIT-22 and AUDIT-18 (re-measured)

| ID | AUDIT-30 | Now | Status |
| --- | --- | --- | --- |
| A22-01 resolve is one block | 4.14–4.19 s realistic, 8.68–8.81 s dense; MCP 3k max 1,162–1,391 ms | **4.71–4.80 s** realistic, **9.57–9.69 s** dense (`68fb2c2` 4.87–5.00 / 9.15–9.73); MCP 3k max 1,344–1,493 ms | Open, unchanged (both builds moved with the machine). It now also delays SIGINT (A35-02). |
| A22-02 carry quadratic in same-name symbols | dup30000 `--force` block 9.29 s, 11.2 s total | **8.83 s** block, 10.7 s total (load 1.4); fresh 3.2 s / 1.10 s | Open, unchanged |
| A22-03 a second writer fails after 5 s | 1 of 353 failed after 5,007 ms (resolve); writer stalled 5,008–5,011 ms | 1 of 418 failed after **5,007 ms** at 99.3 s (resolve); next waited 4,424 ms; p50 1 ms, p99 14 ms; writer stalled **5,012 ms** (load 1.6) | Open (Medium), unchanged |
| A22-04 embed source cache unbounded | embed peak heap 303 MB, HWM 407 MB; OOM at 200 MB | peak heap **299 MB**, HWM **407 MB**; `--max-old-space-size=200`: **`FATAL ERROR: Reached heap limit … JavaScript heap out of memory`** | Open, unchanged |
| A22-05 embed setup block | 0.66–0.83 s | 0.96 s (no-op; `68fb2c2` 1.00 s) | Open (Low), unchanged relative to `68fb2c2` |
| A26-01 `immediate` stalls the MCP event loop | 5,034 ms max under a 5.5 s hold; stalls of 1.3–2.1 s / 3.9–4.0 s | **4,972 ms**; 12 stalls of 1.5–2.0 s (2 s holds) and 12 of 3.9–4.0 s (4 s holds) | Open (Low), unchanged |
| A27-03 MCP search waits behind `atlas_index`'s lock wait | 5,034 ms under a 5.5 s hold | 4,972 ms (same mechanism) | Open (Medium in AUDIT-27), unchanged |
| A18-03 carry re-inserts edges on `--force` | dense `--force` 102.5–104.5 s, 1.12–1.17 s carry block | 99.1–101.1 s, 1.08–1.13 s carry block | Open |
| A18-05 got median | 5.30–6.12 | 4.95–7.22 on both builds (interleaved) | Open |

## No finding

- **A writable open after a crash:** one integrity check (0.1–1.6 s up to dense 10k), and the close clears the WAL (pinned). 8–16 concurrent writable openers: p50 2.7–2.9 s, max 3.1–3.5 s, no failures. This is the cost DECISIONS SG130 accepts.
- **`.open.lock` contention:** 0 of 144 concurrent opens failed. The lock is taken only when a leftover WAL with no live holder exists, so normal opens never touch it.
- **`answer()`:** +3–11 µs per MCP call.
- **10k runs, MCP, dashboard and budgets:** unchanged from `68fb2c2` within noise.
- Outside this audit's scope, noted for the soundness auditors: `holders()` matches inodes without the device (`fe:00:`), so a lock on the same inode number on another filesystem reads as a live holder and the check is skipped. Also, `index.db.open.lock` stays in `.atlas/` after the first locked open.

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a35>` is `<scratch>/a35`. The scripts are in `<a35>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first):
- From AUDIT-30, copied: `probe.mjs`, `race2.mjs`, `mcpstall.mjs`, `serveprobe2.mjs`, `holder.mjs`, `mem.mjs`. `big.sh`, `mcpall.sh`, `serveall.sh` and `rest.sh` are pointed at this worktree, `ab-68fb2c2` and `<a35>/d10k`.
- `mkcrash.mjs <clean.db> <dir> <mb>`: a killed writer's image (the index with its own WAL of about `mb` MB, and its `-shm`).
- `openwal.mjs <dist> <db> <n> [ro] [kill]`: sequential opens, each in a fresh process.
- `concopen.mjs <dist> <db> <procs> <ro> <holdMs> [close|kill]`: concurrent opens; a child's open CPU over 200 ms counts as a check.
- `servestart.mjs <cli> <repo> <port> <n>`: `atlas serve` start to listening, and stop.
- `locks.py <dir> <n>` and `procl.mjs <db>`: host lock load and the `holders()` cost (the function copied verbatim).
- `sigclose.mjs`, `sigrun.mjs`, `sigres.mjs` and `sig2.mjs`: shutdown latency (idle with a large WAL, at offsets in a forced run, 0.3 s into resolve, and repeated SIGINT during a lock wait).
- `mcpcall.mjs <repo> <n> <distA> <distB>`: MCP per-call latency over `InMemoryTransport`.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-35.test.ts` | A35-01 (`it.fails` ×2): three read-only opens of a killed writer's image, and of an index written while a read-only connection was open (no crash), run `integrity_check` at most once. Each runs it 3 times today. A35-02 (`it.fails`): a child waiting in `immediate` behind a 3 s hold ends within 1.5 s of SIGTERM; it takes about 2.4 s today. Plain tests: the precondition (both images keep a WAL that passes, and are checked once per read-only open today); a writable open checks once and its close clears the WAL; opens beside a live writer check nothing; an idle child ends by SIGTERM within 1.5 s and leaves no `-wal`. About 4 s in all. |

## Verification

`npm run typecheck && npm run lint && npm test` and `npm run test:perf` pass. Wall clock: typecheck 8.7 s (load 1.4), lint 4.5 s (1.4), `npm test` 117.7 s (5.1; 97 files, 949 passed and 1 todo), `test:perf` 17.6 s (4.8; 5 files, 9 passed, search p95 20.72 ms at 10,206 symbols).
