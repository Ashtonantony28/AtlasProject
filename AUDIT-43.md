# AUDIT-43: performance under load (round 11)

Auditor: a fresh subagent that wrote none of the audited code. Base: `6c68a67` (SG190, #86), worktree `atlas-audit-43`. The only `src/` change since AUDIT-40 is SG190 in `src/core/db/database.ts` (`git diff 6732b13 6c68a67 -- src`): a read-only `openDatabase` now runs `PRAGMA schema_version` once, so the connection holds the index from the open on; `reportAside` calls the new `inUse` when a set-aside WAL still matches the index, and `inUse` reads `/proc/locks` (`holders`) or, when that cannot tell, takes `.open.lock` and probes; `readAll` and the `cannot check` message only change wording.
Machine: 4 vCPU, 16 GiB RAM, Node 22.22, ext4 at 79% full. A soundness auditor (and later an `atlas-audit-44` gate run) worked in sibling worktrees: the 1-minute load average was **0.6–9.4** (given with each run). Compare builds inside a group; they were interleaved run by run. The page cache was warm.

| Build | What it is |
| --- | --- |
| current | `6c68a67` (`npm run build`) |
| `6732b13` | First parent of the SG190 merge on the base branch (the AUDIT-38 test commit), extracted with `git archive` into the scratchpad and built. Its `src/` differs from current only in `database.ts`. |

## Workloads

| Name | Source | Files | Symbols | Edges | `index.db` |
| --- | --- | --- | --- | --- | --- |
| 10k symbols | AUDIT-40's `r700` (`scripts/audit-repo.mjs … 700`) | 736 | 10,693 | 16,083 | 23 MB |
| realistic 3k | `scripts/audit-repo.mjs <a43>/r3k 3000` | 3,151 | 45,839 | 69,072 | |
| realistic 10k | AUDIT-40's `r10k` sources, indexed with current (63.8 s) | 10,501 | 152,773 | 230,352 | 326 MB |
| dense 10k | AUDIT-40's `d10k` sources | 10,001 | 100,003 | 879,419 | 305 MB |

Images: **set-aside** is a clean index beside `index.db-wal.foreign-<ms>-<size>-<mtimeNs>` naming the index's current state (what `setAside` leaves until the index is written; the move-back is offered). **stale** names another size. **held** is set-aside plus another process holding the index read-only, as `atlas serve` does. **own** is the index beside a killed writer's 54 MB WAL (`mkwal.mjs`, passes the check). **rebuilt** is a `VACUUM INTO` copy beside that WAL (fails the check at schema load). **no `/proc`** runs the opener with a tmpfs over `/proc` (`unshare -m`), so `holders` returns undefined as on macOS, the BSDs or another pid namespace.

## SG190 on the open path

### What runs when

| Open | `6732b13` | current |
| --- | --- | --- |
| no set-aside WAL, or one the index has outgrown | `walOwner`, `reportAside`'s `readdir`, `leftoverWal` | same, plus a read-only open's `schema_version` (no measurable cost) |
| set-aside WAL that matches the index | + 2 `stat`s | + **one `/proc/locks` read** per open; with no `/proc/locks`, **`.open.lock` taken and a probe** per open (A43-01) |
| read-only connection, opened and never queried | holds no lock | holds the index (as SG190 intends), so a writer closing beside it is not the last connection and leaves its WAL (A43-02) |

### One opener (`asidebench.mjs`: realistic 10k, read-only, 8 sequential opens per build, each in a fresh process; load 0.8)

| Image | current p50 (min–max) | `6732b13` p50 (min–max) | `/proc/locks` reads / ms (current) | Probes / open-lock takes |
| --- | --- | --- | --- | --- |
| none | 5.8 ms (5.2–7.6) | 5.3 ms (5.0–6.6) | 0 | 0 / 0 |
| stale set-aside | 5.9 ms (5.2–8.6) | 5.2 ms (4.9–6.0) | 0 | 0 / 0 |
| **set-aside** | **22.2 ms** (12.4–36.5) | 5.7 ms (4.8–6.3) | 1 / 15.2 ms | 0 / 0 |
| **held** | **17.8 ms** (11.4–25.9) | 5.9 ms (4.8–7.5) | 1 / 11.5 ms | 0 / 0 |
| set-aside, no `/proc` | 7.4 ms (6.6–10.5) | 5.5 ms (4.9–8.1) | (fails) | 1 / 1 |
| held, no `/proc` | 6.5 ms (6.1–7.0) | 5.5 ms (4.9–7.6) | (fails) | 1 / 1 |
| **set-aside, 30,000 host locks** (load 0.7) | **211 ms** (201–230) | 5.4 ms (4.9–5.5) | 1 / 181.5 ms | 0 / 0 |

- The first `/proc/locks` read in a fresh process waits in the kernel: 11–15 ms of wall time, with almost no CPU (7.6 against 6.1 ms of CPU for the whole open). With 30,000 host locks it costs 181 ms of CPU (A35-03's quadratic read).
- Only the "move it back" and "a running Atlas process has open" texts need `inUse`. The stale text ("delete it") needs nothing.

### Many concurrent read-only openers (`concaside.mjs`: realistic 10k, N processes released at one instant, each holds 2–4 s)

| Image (load) | Openers | current p50 / max | `6732b13` p50 / max | `/proc/locks` reads (slowest) | Probes + lock takes (slowest lock wait) | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| none (4.5) | 32, ×2 | 28–34 / 71–124 ms | 35–37 / 74–81 ms | 0 | 0 | 0 |
| none, no `/proc` (4.6) | 32 | 54 / 79 ms | 54 / 82 ms | 0 | 0 | 0 |
| set-aside (0.6–0.8) | 16, ×2 | **40–43 / 47–57 ms** | 15–18 / 26–29 ms | 16 (33–42 ms) | 0 | 0 |
| set-aside (0.7–0.8) | 32, ×2 | **62–74 / 86–91 ms** | 19–25 / 43–65 ms | 32 (70–80 ms) | 0 | 0 |
| set-aside, no `/proc` (0.6–1.8) | 16, ×2 | **45–51 / 148–195 ms** | 11–18 / 24–37 ms | — | 16 + 16 (142–180 ms) | 0 |
| set-aside, no `/proc` (1.5–3.8) | 32, ×5 | **53–351 / 230–2,049 ms** | 25–30 / 41–64 ms | — | 32 + 32 (190–2,042 ms) | 0 |
| set-aside, no `/proc` (3.1–4.1) | 64, ×2 | **113–763 / 400–1,469 ms** | 57–152 / 235–307 ms | — | 64 + 64 (349–1,458 ms) | 0 |
| set-aside, no `/proc`, close at once (7.4–8.6) | 32, ×2 | 105–120 / **185–578 ms** | 22–73 / 77–167 ms | — | 32 + 32 (131–565 ms) | 0 |

- Concurrent `/proc/locks` reads queue in the kernel: the slowest of 32 waited 70–80 ms for its read.
- Without `/proc/locks`, every opener queues on `.open.lock`, whose waiters sleep in SQLite's busy handler (up to 100 ms between tries), so the slowest of 32 waited up to 2.0 s for a probe of 1–3 ms. 29–31 of 32 openers then reported "a running Atlas process has open" because the earlier openers held the index.
- No open failed (0 of 432), and no query after an open waited more than 16 ms.
- Without a set-aside WAL, SG190's `schema_version` read changes nothing measurable.

### `atlas serve` start and per-request latency (`servebench.mjs`: realistic 10k, 6 starts per build, 10 rounds of `/api/stats`, `/api/search`, `/api/files` each; load 2.8–7.4)

| Image | Start current p50 (min–max) | Start `6732b13` | First request current / `6732b13` p50 | stats p50/p95 | search p50/p95 | files p50/p95 (current; `6732b13` within 3 ms, 25 ms) |
| --- | --- | --- | --- | --- | --- | --- |
| none | 290 ms (256–379) | 307 ms (290–361) | 16 / 14 ms | 2.4 / 4.9 | 141 / 173 | 43 / 61 |
| set-aside | 335 ms (284–356) | 286 ms (268–319) | 15 / 13 ms | 2.3 / 5.8 | 140 / 163 | 43 / 58 |
| own 54 MB WAL | 1,339 ms (1,287–1,477) | 1,334 ms (1,258–1,456) | **15 / 35 ms** | 2.2 / 4.2 | 141 / 157 | 39 / 61 |

- The start beside a set-aside WAL is about 50 ms slower (the `/proc/locks` read plus noise); per-request latency does not change, because `atlas serve` opens once.
- Beside its own WAL, the start is unchanged, and the first request is 20 ms faster: the read at the open builds the WAL index that the first query built before.
- Each stop took 16–20 ms on both builds.

### The dashboard beside writers

**An idle dashboard (`idleserve.mjs`).** `atlas serve` is started and never queried. One source file is edited, `atlas index` runs, and then serve is stopped and started again.

| Index (load) | `atlas index` current / `6732b13` | `-wal` left: current / `6732b13` | Next `atlas serve` starts: current / `6732b13` |
| --- | --- | --- | --- |
| 10k symbols (1.8–1.9), ×2 | 751–817 / 807–957 ms | **2.2 MB** / none | **358–460** / 294–335 ms |
| realistic 10k (1.7–3.1), ×2 | 7.3–7.4 / 7.3–7.6 s | **27.9 MB** / none | **1,275–1,452** / 336–418 ms |
| 10k symbols, dashboard queried once (`REQ=1`) (1.8–2.0) | 805 / 852 ms | 2.2 MB / 2.2 MB | 396–438 / 446–502 ms (A35-01 on both) |

While the idle dashboard runs after that index, each writable CLI open (6 per build, 10k symbols, load 4.0–4.3) took **23–26 ms p50** against 8–10 ms, because it reads `/proc/locks` beside the WAL that stayed (A35-03's path).

**Writers beside a queried dashboard (`serveprobe2.mjs`).** This ran on a copy of realistic 10k, with `atlas index --force` and an `atlas docs --offline --force` loop. The results do not change:

| Build (load) | Probes | Search p50 / p95 / max | Stats p50 / max | Errors | Writers |
| --- | --- | --- | --- | --- | --- |
| current (2.7) | 340 | 85 / 164 / 214 ms | 129 / 471 ms | 0 | index exit 0, docs 0 ×3 |
| `6732b13` (3.1) | 321 | 84 / 155 / 196 ms | 140 / 251 ms | 0 | index exit 0; one docs run failed with `docs write: database is locked` (A22-03) |

### MCP responsiveness (`mcpstall.mjs`: `atlas mcp --offline` on realistic 3k, `atlas_index {force}` with `atlas_search` every 100 ms)

| Other writer (load) | current: index / search p50 / p95 / max | `6732b13` |
| --- | --- | --- |
| none (8.5–9.4) | ok, 48.7 s / 60 / 119 / **1,773 ms** (resolve) | ok, 42.2 s / 51 / 105 / 1,586 ms |
| lock held 2 s every 5 s (4.9–7.3) | still running at 60 s / 57 / 1,889 / **2,023 ms**, 12 stalls of 1.9–2.0 s | done at 57.1 s / 44 / 1,801 / 2,095 ms, the same stalls |

`atlas mcp` opens writable, so SG190's read-only change does not reach it. `reportAside` runs once at its start. A26-01 and A27-03 are unchanged.

## Whole runs (`probe.mjs` preload: total, longest gap of a 5 ms timer, VmHWM)

| Workload (load) | Run | `6732b13` total / longest block | current total / longest block | HWM `6732b13` / current |
| --- | --- | --- | --- | --- |
| realistic 10k (1.2–3.3) | fresh | 75.0 s / 4.99 s (resolve) | 75.2 s / 5.11 s | 452 / 470 MB |
| | no-op ×2 | 1.48 / 1.38 s; 1.02–1.07 s (embed setup) | 1.25 / 1.31 s; 0.86–0.93 s | 452–463 / 470–478 MB |
| dense 10k (1.8–8.3) | fresh | 81.0 s / 16.9 s | 73.9 s / 12.9 s | 729 / 736 MB |
| | `--force` | 146.1 s / 16.7 s | 132.3 s / 14.5 s | 821 / 824 MB |

Index runs open writable and do not reach the changed code. Each pair is within noise (the `6732b13` dense `--force` ran at load 8.3).

## Findings

Counts: **Critical 0, High 0, Medium 0, Low 2** (new). No SG rows. SG190 adds nothing to an ordinary open, to many concurrent read-only openers, to `atlas serve`'s per-request latency, to MCP or to index runs. It adds work where a set-aside WAL still matches the index (A43-01). It also makes an idle `atlas serve` hold the index, which brings A35-01's repeated check (and A35-03's `/proc/locks` read) to a dashboard that was never queried (A43-02). Still open and re-checked with no change: A40-01, A40-02, A35-01, A35-02 and A35-03; A22-01, A22-02, A22-03, A22-05, A26-01, A27-03, A18-03 and A18-05. A22-04 was not re-timed (its code is unchanged).

### Low

#### A43-01: since SG190, every open beside a set-aside WAL that still matches the index reads `/proc/locks`, or, where it cannot, takes `.open.lock` and probes: +6–17 ms per open, 211 ms with 30k host locks, up to 2.0 s for the slowest of 32 concurrent openers without `/proc/locks`

- **Evidence:**
  - One read-only open at realistic 10k takes **22.2 ms p50** against 5.7 ms (the move-back offered), and 17.8 against 5.9 ms with a holder. That is one `/proc/locks` read per open, 11–15 ms of wall time in the kernel. With 30,000 host locks it takes **211 ms** against 5.4 ms.
  - With 16 or 32 concurrent openers, the open p50 is 40–74 ms against 15–25 ms, and the reads queue (the slowest read took 80 ms).
  - Without `/proc/locks`, each open takes `.open.lock` and runs a probe. The cost is +1–2 ms alone. Concurrent openers queue on the lock: the slowest of 32 took **0.18–2.05 s** against 0.04–0.06 s (5 rounds), the slowest of 64 took **0.40–1.47 s** against 0.24–0.31 s, and 23–31 of 32 openers then reported a running Atlas process (the other openers).
  - `atlas serve` start: 335 against 286 ms.
  - The cost holds while the set-aside WAL matches the index. That lasts until the index is written. `atlas search`, `graph`, `drift` and `serve` do not write it. A stale set-aside WAL costs nothing (pinned).
  - `test/audit/audit-43.test.ts` A43-01 (`it.fails` ×2): three read-only opens beside a matching set-aside WAL read `/proc/locks` 0 times, and without it take no open lock and run no probe. Today they make 3 reads, and without it 3 lock takes and 3 probes (pinned by the precondition test). Against `6732b13` both pass.
- **Repro:** `node <a43>/scripts/asidebench.mjs <r10k>/.atlas/index.db ro 8 aside cur=$PWD/dist pre=<a43>/ab-6732b13/dist` (add `NOPROC=1`, or start `python3 <a43>/scripts/locks.py <dir> 30000 &` first) · `NOPROC=1 node <a43>/scripts/concaside.mjs <r10k>/.atlas/index.db ro 32 hold:3000 3 aside cur=… pre=…` · `npx vitest run test/audit/audit-43.test.ts`
- **Cause:** `src/core/db/database.ts:386` computes `held` with `inUse` (`:405-414`) on every open whose set-aside WAL matches the index, before any message is written. `inUse` reads `holders()` (`:184-209`, A35-03's full read of the host's lock table), and when that returns undefined it takes `lockOpens` (`:226-242`, a 60 s busy wait) and `probe` (`:212-219`).
- **Fix (options):** Do not ask on every open. The move-back text already says "stop every Atlas process on the project, then move it back", so print it without `inUse`, and check for holders only where the move-back would happen (a future `atlas wal restore`, for example). Or ask `holders()` only, and treat undefined as "may be held" (the cautious text) without the lock and the probe. Or remember the answer keyed by the set-aside file's name in the process.
- **Severity:** Low. It costs once per process start (CLI command, `atlas serve`, `atlas mcp`), only while a set-aside WAL matches the index, and no open failed. It matters on hosts with tens of thousands of POSIX locks, and on platforms without `/proc/locks` when many processes start at once.

#### A43-02: since SG190, an `atlas serve` that was never queried holds the index, so `atlas index` beside it leaves its WAL, and every later `atlas serve` start runs the full integrity check (1.3–1.45 s instead of 0.34–0.42 s at realistic 10k; A35-01 widened)

- **Evidence:**
  - `idleserve.mjs`: with `atlas serve` running and never queried, one file was edited and `atlas index` run, then serve was stopped. Current leaves a **27.9 MB** WAL at realistic 10k (2.2 MB at 10k symbols). `6732b13` leaves none, because the writer was the last connection, checkpointed and removed it.
  - Every later `atlas serve` start then takes **1,275–1,452 ms** against 336–418 ms (2 + 2 starts per build), and 358–460 against 294–335 ms at 10k symbols. The WAL stays until a writable command runs alone (A35-01).
  - While that dashboard runs, each writable CLI open reads `/proc/locks` beside the WAL that stayed: **23–26 ms** p50 against 8–10 ms (A35-03's path; 275 ms at 30k host locks in AUDIT-35).
  - When the dashboard has been queried (`REQ=1`), both builds leave the WAL. So this is A35-01's trigger widened to an idle dashboard (`atlas serve` started in the background, by a script, or before the browser opens), not a new cost.
  - `test/audit/audit-43.test.ts` A43-02 (`it.fails`): after a writer commits and closes beside an idle read-only connection, three read-only opens run at most one integrity check. Today they run 3. The precondition test pins that the WAL stays. Against `6732b13`, the `it.fails` passes (0 checks) and the precondition fails (no WAL).
- **Repro:** `node <a43>/scripts/idleserve.mjs <a43>/r10k 2 2 cur=$PWD/dist pre=<a43>/ab-6732b13/dist` · `npx vitest run test/audit/audit-43.test.ts`
- **Cause:** `src/core/db/database.ts:94-101`: the `schema_version` read leaves the read-only connection holding its shared lock for its whole life (the SG190 intent: `holders` sees it). A writer's close then cannot take the exclusive lock, does not checkpoint, and leaves the WAL. The dashboard's read-only close cannot clear it. A35-01 (`:124-136`) then re-checks it on every read-only open.
- **Fix:** A35-01's fix covers it: consume a WAL that passed the check (a `wal_checkpoint(TRUNCATE)` on a short writable connection under the open lock), or remember the verdict keyed by the WAL's salts and size. Keeping SG190's read is right for soundness, and undoing it is not proposed.
- **Severity:** Low. It is A35-01's cost (about 1 s per dashboard start at 10k, gone after any CLI command run alone), and it now also follows an `atlas index` run beside a dashboard nobody has opened.

### Open from AUDIT-40, AUDIT-35, AUDIT-26/27, AUDIT-22 and AUDIT-18 (re-checked against `6732b13`)

The `it.fails` tests for A18-03 (×2), A22-01, A22-02, A26-01, A27-03, A35-01 (×2), A35-02, A40-01 and A40-02 still fail as expected on current: `npx vitest run test/audit/audit-18.test.ts test/audit/audit-22.test.ts test/audit/audit-26.test.ts test/audit/audit-27.test.ts test/audit/audit-35.test.ts test/audit/audit-40.test.ts`, 6 files and 39 tests pass, 39.4 s at load 1.4–1.5.

| ID | AUDIT-40 | Now | Status |
| --- | --- | --- | --- |
| A40-01 a failing WAL is checked twice plus a full read | rebuilt + 332 MB WAL 0.52 against 0.19 s (vs `64105ff`) | rebuilt realistic 10k + 54 MB WAL: **191 / 186 ms** (current / `6732b13`), 2 checks and 361 MB read on both; `it.fails` stands | Open (Low), unchanged |
| A40-02 refused opens repeat the decision | 16 concurrent 12.9 s (restored, realistic 10k) | rebuilt, no `-shm`: sequential refusals 178 / 213 ms; 8 concurrent max **1,734 / 1,740 ms**, 16 checks and 2.9 GB read on both; `it.fails` stands | Open (Low), unchanged |
| A35-01 read-only opens repeat a passing check | 1,055 ms per read-only open at realistic 10k | `atlas serve` start beside its own 54 MB WAL **1,339 / 1,334 ms** (no WAL 290 / 307 ms); `it.fails` ×2 stand | Open (Low), unchanged; trigger widened by A43-02 |
| A35-02 signals wait for the current block | dense `--force` resolve 14.8 s | `it.fails` stands; dense `--force` longest block **14.5 s** (`6732b13` 16.7 s) | Open (Medium), unchanged |
| A35-03 `holders()` per open beside a live writer | 11.7–29.6 ms | 23–26 against 8–10 ms beside an idle dashboard (A43-02); reached by A43-01 too | Open (Low), unchanged in cost, reached more often |
| A22-01 resolve is one block | dense `--force` 14.84 s | realistic fresh **5.11 s** (`6732b13` 4.99 s); dense fresh 12.9 s (16.9), `--force` 14.5 s (16.7); MCP 3k max 1,773 ms (1,586) | Open, unchanged |
| A22-02 carry quadratic in same-name symbols | `it.fails` stands | `it.fails` stands (not re-timed) | Open, unchanged |
| A22-03 a second writer fails after 5 s | not re-timed | one `atlas docs` run beside `atlas index --force` at realistic 10k failed with `docs write: database is locked` (on `6732b13`; same code on current) | Open (Medium) |
| A22-04 embed source cache unbounded | OOM under a 200 MB heap | not re-timed (code unchanged); HWM realistic fresh 470 MB (452) | Open |
| A22-05 embed setup block | 1.16–1.26 s | no-op longest block **0.86–0.93 s** (`6732b13` 1.02–1.07 s) | Open (Low), unchanged |
| A26-01 `immediate` stalls the MCP event loop | `it.fails` stands | 12 stalls of 1.9–2.0 s under 2 s holds on both builds; `it.fails` stands | Open (Low), unchanged |
| A27-03 MCP search waits behind `atlas_index`'s lock wait | `it.fails` stands | max 2,023 / 2,095 ms (2 s holds); `it.fails` stands | Open (Medium in AUDIT-27), unchanged |
| A18-03 carry re-inserts edges on `--force` | dense `--force` 147.2 s | dense `--force` 132.3 s (`6732b13` 146.1 s at load 8.3); `it.fails` ×2 stand | Open |
| A18-05 got median | 6.65–9.71 | not re-timed (no change on its path); `test:perf` parse+insert gate passes (below) | Open |

## No finding

- **Ordinary opens:** 5.8 against 5.3 ms (no set-aside WAL), and a stale set-aside WAL costs nothing. 32 concurrent read-only openers: p50 28–34 against 35–37 ms, with and without `/proc`, 0 failures.
- **`atlas serve`:** per-request latency is unchanged (stats 2.2–2.4 ms, search 140 ms, files 39–43 ms p50 on both). The start beside its own WAL is unchanged, and the first request is 20 ms faster. Writers beside a queried dashboard: search max 214 against 196 ms, 0 errors.
- **MCP, index runs, budgets:** unchanged within noise (SG190 does not reach writable opens).
- Outside this audit's scope, noted for the soundness auditors: with no `/proc/locks`, `inUse`'s probe reports any concurrent opener as "a running Atlas process" (23–31 of 32), and the probe takes an exclusive lock on the index for 1–3 ms, which the other openers' first reads wait out in SQLite's busy handler (no error seen in 432 opens).

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a43>` is `<scratch>/a43`. The scripts are in `<a43>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first). The raw output is in `<a43>/*.log`.
- From AUDIT-40 and AUDIT-26, copied and repointed: `openone.mjs`, `bench.mjs`, `concopen.mjs`, `mkwal.mjs`, `probe.mjs`, `serveprobe2.mjs`, `mcpstall.mjs` and `holder.mjs`.
- `open2.mjs <dist> <db> <ro|rw> <close|kill|hold:ms>`: one instrumented open. It counts `/proc/locks` reads and their time, probes (`*.probe` links), `BEGIN EXCLUSIVE` on `.open.lock` and its wait, integrity checks, and the set-aside texts.
- `asidebench.mjs <db> <ro|rw> <n> <none|aside|stale|held> <label=dist>…`: sequential opens, interleaved by build. `NOPROC=1` runs each open under `unshare -m` with a tmpfs over `/proc`.
- `concaside.mjs <db> <ro|rw> <n> <close|hold:ms> <reps> <none|aside> <label=dist>…`: concurrent opens.
- `servebench.mjs <db> <none|aside|own> <n> <reqs> <label=dist>…` (`IMG=<prefix>` for own): `atlas serve` start and request latency.
- `idleserve.mjs <repo> <n> <starts> <label=dist>…` (`REQ=1` queries the dashboard once): an edit and `atlas index` beside a running serve, then the `-wal` left and the next starts.
- `locks.py <dir> <n>`: holds n extra POSIX locks.
- Every process these scripts start exits or is killed by them, and `pgrep` found none left after the runs. The 10k indexes and images were deleted afterwards.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-43.test.ts` | A43-01 (`it.fails` ×2): three read-only opens beside a set-aside WAL that matches the index read `/proc/locks` 0 times, and, with `/proc/locks` made unreadable, take no open lock and run no probe. Today they make 3 reads, or 3 lock takes and 3 probes. A43-02 (`it.fails`): after a writer closes beside an idle read-only connection, three read-only opens run at most one integrity check (3 today). Plain tests: the preconditions; a plain open, and an open beside a set-aside WAL the index has outgrown, read nothing; with no other connection, the writer clears its WAL and the next opens check nothing. It counts work and times nothing. About 0.3 s. Against `6732b13`, both `it.fails` pass and the preconditions fail, so the defects are SG190's. |

## Verification

`npm run typecheck && npm run lint && npx vitest run test/audit/audit-43.test.ts && npm run test:perf` passes (rc 0) in 42.6 s in all at load 4.1–6.1: `audit-43` 7 tests pass, and `test:perf` 5 files with 9 tests pass, search p95 22.39 ms at 10,206 symbols (budget 50 ms).
