# AUDIT-40: performance under load (round 10)

Auditor: a fresh subagent that wrote none of the audited code. Base: `8bd4405` (AUDIT-37 on top of SG150 `9a7b422`, #80), worktree `atlas-audit-40`. The only `src/` change since AUDIT-35 is SG150 in `src/core/db/database.ts` (`git diff 64105ff 8bd4405 -- src`): `integrityOk` now runs `integrityResult` a second time when the first check fails, after `readAll` reads every byte of the file and of its WAL; `setAside` names the WAL with `fileState` (one `stat`); `reportAside` stats the index and its `-wal` when a set-aside file exists.
Machine: 4 vCPU, Node 22.22, ext4 at 79–82% full. Another auditor ran a coverage audit in a sibling worktree the whole time: the 1-minute load average was **6.8–13.1** (given with each run), against 0.1–6.3 in AUDIT-35. Absolute times are therefore about 30% above AUDIT-35's (a full check on dense 10k is 2.1–2.2 s here against 1.6 s); compare builds inside a group, which were interleaved run by run. The page cache was warm unless a run says "cold".

| Build | What it is |
| --- | --- |
| current | `8bd4405` (`npm run build`) |
| `64105ff` | First parent of the SG150 merge `9a7b422` on the base branch (the AUDIT-36 test commit), extracted with `git archive` into the scratchpad and built. Its `src/` differs from current only in `database.ts`. |

## Workloads

| Name | Source | Files | Symbols | Edges | `index.db` |
| --- | --- | --- | --- | --- | --- |
| 10k symbols | `scripts/audit-repo.mjs <a40>/r700 700` | 736 | 10,693 | 16,083 | 23 MB |
| realistic 10k | the AUDIT-18 `r10k` sources, copied and indexed with current | 10,501 | 152,773 | 230,352 | 326 MB |
| dense 10k | `gen-dense.mjs <a40>/d10k 10000` (AUDIT-18's shape, regenerated: TS only, 9 functions per file, each calling 6 imported functions and `hub.log`). Denser than AUDIT-18's: 100,003 symbols and 879,419 edges against 90,002 / 749,769 | 10,001 | 100,003 | 879,419 | 305 MB |

Images (all from these indexes, with real killed writers: `mkwal.mjs` commits docstring updates with autocheckpoint off, then SIGKILLs itself, and its `-wal`/`-shm` are kept):

| Image | What it is | Check result |
| --- | --- | --- |
| **own** | the index with its own killed writer's WAL (27 MB realistic, 12 MB dense; **332 MB** / 325 MB "large") | passes: kept (unchanged by SG150) |
| **rebuilt** | `VACUUM INTO` copy of the index (a rebuilt or another index) beside the killed writer's WAL | fails at schema load (`SQLITE_CORRUPT` thrown); set aside |
| **restored backup** | the index file, beside a WAL written by a killed writer on a later version of it (`mkstale.mjs`: the later version changed 20 rows of `refs.file_id` and was checkpointed) | fails late, as a row: `row 229994 missing from index idx_refs_file`; set aside |
| ... **no `-shm`** | either foreign image without its `-shm` (not copied, or deleted) | fails, cannot be set aside: refused with `nameCorrupt`'s message on every open |

`openone.mjs` runs one `openDatabase` in a fresh process and records its wall time, CPU, each `integrity_check` (time and result), the bytes read with `readSync`, and the `stat` calls (fs wrapped with `syncBuiltinESMExports`). The image is rebuilt before every open.

## SG150 on the open path

### What runs when (from the code and the counters)

| Open | `64105ff` | current |
| --- | --- | --- |
| no WAL, or a WAL of 32 bytes or less | `walOwner`, `reportAside`'s `readdir`, `leftoverWal` | same: **no new call** (4 `stat`s either way) |
| a live writer holds the WAL | + `holders` (`/proc/locks`) | same |
| leftover WAL that passes the check | one `integrity_check` | same: **one check, 0 bytes read by `readAll`** (pinned) |
| leftover WAL that fails the check | one check, then set aside or refused | **two checks + `readAll` of the index and the WAL** (A40-01), then set aside or refused |
| a set-aside file exists beside the index | `readdir` + a stderr line per file | + 2 `stat`s (`fileState`, `-wal` size) |

### One opener (`bench.mjs`: sequential opens, builds interleaved, each in a fresh process)

| Index (load) | Image | Mode | current p50 (min–max) | `64105ff` p50 (min–max) | Checks (current) | `readAll` (current) |
| --- | --- | --- | --- | --- | --- | --- |
| 10k symbols (7.0–7.4) | no WAL | rw | 7.6 ms (6.7–8.8) | 9.8 ms (6.1–25.9) | 0 / 0 | 0 |
| | own 5.7 MB | rw | 115 ms (93–146) | 103 ms (92–134) | 1 / 1 (67–115 ms) | 0 |
| | rebuilt | rw / ro | **52 / 45 ms** | 40 / 26 ms | 2 / 1 (2 ms each) | 27 MB, 6–9 ms |
| | restored backup | rw | **123 ms** (110–139) | 72 ms (52–103) | 2 / 1 (30 ms each) | 27 MB, 7 ms |
| realistic 10k (6.8–7.9) | own 27 MB | rw / ro | 1,085 / 1,055 ms | 1,089 / 1,039 ms | 1 / 1 | 0 |
| | own **332 MB** | rw | 1,482 ms (1,354–1,546) | 1,446 ms (1,438–1,521) | 1 / 1 | 0 |
| realistic 10k (7.9–9.5) | rebuilt, 27 MB WAL | rw / ro | **158 / 151 ms** | 109 / 44 ms | 2 / 1 (11–31 ms each) | 333 MB, 70–85 ms |
| | rebuilt, **332 MB WAL** | rw | **520 ms** (459–670) | 192 ms (182–277) | 2 / 1 (133–159 ms each: WAL recovery) | 624 MB, 147 ms |
| | rebuilt, **332 MB WAL** | ro | **482 ms** (469–484) | 177 ms (152–230) | 2 / 1 | 624 MB, 152 ms |
| realistic 10k (10.2–10.7) | restored backup | ro | **777 ms** (714–821) | 381 ms (342–384) | 2 / 1 (302–369 ms each) | 336 MB, 76 ms |
| | restored backup | rw | **739 ms** (730–879) | 418 ms (347–528) | 2 / 1 | 336 MB, 69 ms |
| dense 10k (8.7–9.7) | own 12 MB | ro / rw | 2,207 / 2,151 ms | 2,125 / 2,241 ms | 1 / 1 | 0 |
| dense 10k (9.3–9.8) | rebuilt, 12 MB WAL | rw | 255 ms (202–282) | 231 ms (181–265) | 2 / 1 (6–8 ms each) | 296 MB, 64 ms |
| | rebuilt, **325 MB WAL** | rw / ro | **480 / 467 ms** | 230 / 169 ms | 2 / 1 (118–162 ms each) | 594 MB, 134–165 ms |
| dense 10k (9.9–10.6) | restored backup | ro / rw | **1,275 / 1,167 ms** | 603 / 573 ms | 2 / 1 (465–663 ms each) | 303 MB, 64–86 ms |

- A WAL that passes the check costs what it cost before, on every index and WAL size (own images: within 4% either way, interleaved). SG150 adds nothing to the common paths.
- A WAL that fails the check now costs **two checks plus a read of the index and the WAL**: +0.3 s on realistic 10k beside a 332 MB WAL (2.7×), +0.4 s (2×) on a restored backup at realistic 10k, +0.6 s (2.1×) on dense 10k. The failing checks measured here stop at the first error (`integrity_check(1)`): 2 ms (thrown at schema load) to 0.66 s (a late row). A failure found at the end of the check would cost up to a full check (1.0–2.2 s here), and SG150 doubles that.
- `readAll` reads at 4–5 GB/s from a warm cache (147 ms for 624 MB). **Cold** (`posix_fadvise(DONTNEED)` on the image before the open, `drop.py`): 166 ms for 333 MB and 173 ms for 624 MB here, because this VM's host still caches the file. The first read of a freshly written 326 MB index after dropping it took **1,859 ms** (175 MB/s). After a crash and a reboot (when leftover WALs exist) the page cache is cold, and a rebuilt-index check, which itself reads only the WAL and a few pages, then reads the whole index from disk: about 2 s more at realistic 10k on a disk of that speed.
- Rebuilt + 332 MB WAL, cold (load 9.5–9.6, 3 runs): rw **767 ms** (673–809) against 457 ms (380–585).
- The decision runs once per foreign WAL: the WAL is set aside, and the next open checks nothing (pinned in the test).

### `atlas serve` and `atlas mcp` starts (`startup.mjs`: spawn to "serving" line / to the `initialize` reply; realistic 10k; load 9.4–10.7)

| Start | Image | current p50 (min–max) | `64105ff` p50 (min–max) |
| --- | --- | --- | --- |
| `atlas serve` | no WAL | 415 ms (395–417) | 403 ms (350–413) |
| `atlas serve` | rebuilt, 332 MB WAL | **769 ms** (708–838) | 511 ms (482–639) |
| `atlas mcp` | no WAL | 333 ms (317–391) | 313 ms (313–380) |
| `atlas mcp` | rebuilt, 332 MB WAL | **854 ms** (787–957) | 658 ms (471–735) |

### Concurrent openers (`concopen.mjs`: N processes released at one instant; each image rebuilt per round)

| Index (load) | Image | Openers | current p50 / max | `64105ff` p50 / max | Checks (current / `64105ff`) | Read in all | Failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| realistic 10k (7.9–8.4) | rebuilt, 332 MB WAL | 8 ro, close | 767–850 / **1,067–1,154 ms** | 258–455 / 562–759 ms | 2 / 1 | 624 MB | 0 |
| realistic 10k (7.5) | rebuilt, 332 MB WAL | 8 rw, close | 565–847 / **673–1,055 ms** | 358–373 / 563–678 ms | 2 / 1 | 624 MB | 0 |
| realistic 10k (7.6–7.7) | restored backup | 16 ro, close | 1,021–1,286 / **1,419–1,890 ms** | 786–1,092 / 1,203–1,216 ms | 2 / 1 | 336 MB | 0 |
| dense 10k (12.2) | rebuilt, 325 MB WAL | 16 ro, close | 661 / 1,047 ms | 583 / 986 ms | 2 / 1 | 594 MB | 0 |
| dense 10k (13.0) | restored backup | 16 rw, close | 1,792 / **2,199 ms** | 1,192 / 1,795 ms | 2 / 1 | 303 MB | 0 |
| realistic 10k (9.1–9.2) | restored backup, **no `-shm`** | 16 ro | 7,200 / **12,937 ms** | 3,832 / 6,677 ms | **32 / 16** | **5.4 GB** | 16 / 16 (refused, as intended) |
| realistic 10k (10.3–11.2) | rebuilt, 332 MB WAL, **no `-shm`** | 16 ro | 3,788 / **6,580 ms** | 1,752 / 3,148 ms | **32 / 16** | **10.0 GB** | 16 / 16 (refused) |
| dense 10k (10.8–11.9) | restored backup, **no `-shm`** | 16 ro | 11,540 / **20,685 ms** | 5,691 / 10,572 ms | **32 / 16** | **4.9 GB** | 16 / 16 (refused) |

- When the WAL can be set aside, the first opener decides under `.open.lock` and the others then find no leftover WAL: one decision in all, and SG150 adds its cost once (+0.4–0.7 s on the slowest opener).
- When it cannot (no `-shm`, a checkpoint started, a holder), every opener is refused, each after its own full decision, one at a time under the lock: N × (two checks + `readAll`) (A40-02). The pre-SG150 build repeated one check per opener; SG150 doubles it and adds a full read of the index and WAL per opener.
- `OPEN_LOCK_MS` is 60 s. A waiting opener now gives up (`open: database is locked`) behind about half the decision work it did before: one decision of an index of about 4–9 GB at the per-MB costs here (2 × 3.2–7.2 ms/MB of check plus 0.24 ms/MB of reads), or about 50 queued refusals of a dense 10k index (16 took 20.7 s). This is recorded as a limit, not a finding.

### `fileState` and `reportAside` (`aside.mjs`: 1,000 in-process read-only opens of the clean 10k-symbols index; load 10.2; 3 interleaved rounds)

| Set-aside files beside the index | current p50 | `64105ff` p50 |
| --- | --- | --- |
| 0 | 0.14–0.16 ms | 0.15–0.19 ms |
| 1 | 0.19–0.27 ms | 0.16–0.19 ms |
| 100 | 0.47 ms (one stderr line per file per open) | 0.45 ms |

`reportAside` returns before its new `stat`s when there is no set-aside file, so ordinary opens pay nothing. With one, the two `stat`s cost 30–110 µs per open; `setAside`'s `fileState` is one `stat` per set-aside. **No finding.**

### `holders()` beside a live writer (A35-03 re-check; 10k symbols, a writer holding a 4 KB WAL; 6 interleaved opens each; load 10.9)

current 11.7–29.6 ms, `64105ff` 20.0–31.9 ms (no WAL: 6–10 ms). Unchanged, still open.

## Whole runs (`probe.mjs` preload: total, longest gap of a 5 ms timer, peak heap, VmHWM)

| Workload (load) | Run | `64105ff` total / longest block | current total / longest block | HWM `64105ff` / current |
| --- | --- | --- | --- | --- |
| realistic 10k (8.3–9.6) | no-op ×2 | 1.93 / 1.92 s; **1.03–1.05 s** (embed setup) | 1.98 / 2.21 s; **1.16–1.26 s** | 227–241 / 230–248 MB |
| dense 10k (8.9–11.4) | `--force` | 144.4 s / **15.48 s** (resolve) | 147.2 s / **14.84 s** | 833 / 837 MB |

Each pair is within noise (index runs do not call the changed code). The dense resolve block is longer than AUDIT-35's 9.6–9.7 s because this dense repo has 17% more edges and the machine was twice as loaded; it moved with both builds.

## Budget table (frozen §Interfaces / SG6)

| Budget | AUDIT-35 | Now | Result | Reproduce |
| --- | --- | --- | --- | --- |
| parse+insert ≤ 5 ms/file median (express) | 2.16–2.45 | `64105ff` 4.08 / 3.64, current **3.35 / 2.94** (interleaved, load 9.7) | PASS | `node scripts/bench.mjs --target <express>` |
| (same, got; not gated) | 4.95–7.22 | `64105ff` 6.65 / 9.71, current 8.35 / 8.85 (interleaved, load 10.1–10.9) | over 5, A18-05, unchanged relative to `64105ff` (load) | `bench.mjs --target <got>` |
| no-op re-index ≤ 100 ms / 100 files | realistic 10k 13.0 | realistic 10k **18.8–21.1** (1,979–2,211 ms; `64105ff` 1,924–1,928 ms); express 21.6–22.4 ms / 141 files | PASS | `probe.mjs` preload on `atlas index <r10k>` |
| `search` p95 ≤ 50 ms at 10k symbols | 20.72 ms | **30.54 / 21.27 ms** at 10,206 symbols (two runs, load 8.8–10.4) | PASS | `npm run test:perf` |
| `test:perf` (all 9 budgets) | all PASS | parse+insert 4.07–4.94 ms/file, no-op 22.6 ms/100, resolver 720 ms/1k, Python monorepo 100 ms/1k, walks 219–231 µs/file, cached synth 203 ms, drift 400 ms | PASS | `npm run test:perf` |

## Findings

Counts: **Critical 0, High 0, Medium 0, Low 2** (new). No SG rows. SG150 adds nothing to an ordinary open, to an open beside a live writer, or to an open beside a WAL that passes the check (own images within noise up to a 332 MB WAL). Still open and re-checked with no change: A35-01, A35-02 and A35-03; A22-01, A22-02, A22-04, A22-05, A26-01, A27-03, A18-03 and A18-05. A22-03 was not re-timed (its code is unchanged since AUDIT-35).

### Low

#### A40-01: since SG150, a leftover WAL that fails the integrity check is checked twice and the index and WAL are read in full before it is set aside: +0.3–0.7 s per decision at 10k (about 2×), and about 2 s more on a cold cache

- **Evidence:**
  - Realistic 10k, rebuilt index beside a 332 MB WAL: writable open **520 ms** against 192 ms, read-only 482 against 177 ms (5 interleaved opens each, load 9.2–9.5); cold 767 against 457 ms. Restored backup: 777 against 381 ms (ro), 739 against 418 ms (rw). Dense 10k restored backup: **1,275 against 603 ms**; rebuilt beside 325 MB: 480 against 230 ms.
  - `atlas serve` start beside the rebuilt image: **769 against 511 ms**; `atlas mcp` to its `initialize` reply: **854 against 658 ms**.
  - Concurrent openers: one decision for all of them, so the slowest of 8–16 waits 0.06–0.7 s longer (max 1,154 against 759 ms; 2,199 against 1,795 ms on dense).
  - The counters: 2 `integrity_check`s instead of 1, and `readAll` reads 296–624 MB (all of the index and its WAL) in 64–165 ms from a warm cache. A first read from disk ran at 175 MB/s here (1.86 s for 326 MB), and the check that fails at schema load does not warm the index for it.
  - It is paid once per foreign WAL, because the WAL is then set aside.
  - `test/audit/audit-40.test.ts` A40-01 (`it.fails`): a restored-backup image whose check reports `row N missing from index idx_files_language` (a structural result with no I/O error code) must be decided with one check. Today it takes 2 (pinned by the precondition test, which also pins the full read and the set-aside). Against `64105ff` the same test passes (1 check).
- **Repro:** `node <a40>/scripts/mkstale.mjs <r10k>/.atlas/index.db <tmp> <a40>/r10k-L5 5` (with `A1SQL`/`W_SQL` from Method notes), then `node <a40>/scripts/bench.mjs <r10k>/.atlas/index.db <a40>/r10k-L5.wal <a40>/r10k-L5.shm ro 4 0 cur=$PWD/dist pre=<a40>/ab-64105ff/dist` · rebuilt: `VACUUM INTO` + `mkwal.mjs … 300` and the same `bench.mjs` · `node <a40>/scripts/startup.mjs serve|mcp <B.db> <wal> <shm> 4 cur=… pre=…` · `npx vitest run test/audit/audit-40.test.ts`
- **Cause:** `src/core/db/database.ts:258-268` (`integrityOk`): any first result other than `ok` triggers `readAll(file)`, `readAll(file-wal)` and a second `integrityResult`, whatever the result says. An I/O error that SQLite reports as a row already carries `error code=<SQLITE_IOERR*>` and is refused by the code test (`:264-267`), so the second pass decides only between a thrown `SQLITE_CORRUPT`/`SQLITE_NOTADB` (which can hide an `EIO` while the schema loads) and a structural row with no code.
- **Fix (options):** Confirm only what can hide an I/O error. Re-run (and `readAll`) only when the first result is a thrown `SQLITE_CORRUPT`/`SQLITE_NOTADB`. That case stops at schema load, so its own cost is 2–15 ms plus WAL recovery. Accept a structural row with no error code at once. Or bound `readAll` to the pages the check could not read: for a thrown error at schema load, that is page 1 and the schema pages plus the WAL, not the whole index.
- **Severity:** Low. It costs once per foreign WAL (after a replaced or restored index beside a killed writer's WAL), about 2× a decision that was already O(index). No data is at risk, and it buys SG150's protection against a transient `EIO`.

#### A40-02: an open refused after a failed check (the WAL cannot be set aside) repeats the whole decision on every open, now with two checks and a full read each: 16 concurrent opens take 12.9 s at realistic 10k (was 6.7 s) and 20.7 s on dense 10k (was 10.6 s), and read 4.9–10 GB

- **Evidence:**
  - Sequential refused opens (no `-shm`, read-only like `atlas serve`): realistic 10k restored backup **799 against 423 ms** each; rebuilt beside 332 MB **431 against 168 ms**; dense **1,183 against 629 ms**. Every one is refused with `index … is unreadable (database disk image is malformed) …`, as SG135 intends.
  - 16 concurrent refused opens (an MCP client retrying, a dashboard restarted in a loop, several CLI commands): each runs its own decision in turn under `.open.lock`. The slowest is refused after **12,937 ms** (`64105ff` 6,677 ms; restored backup, realistic 10k), **6,580 ms** (3,148; rebuilt + 332 MB WAL), and **20,685 ms** (10,572; dense restored backup). That is 32 checks against 16, and **5.4 / 10.0 / 4.9 GB** read in all.
  - The repetition itself predates SG150 (`64105ff` repeats one check per refused open, as A35-01 does for a WAL that passes). SG150 doubles it and adds a full read of the index and WAL per open. It also brings the 60 s `OPEN_LOCK_MS` within reach: about 50 queued refusals of a dense 10k index, after which waiting openers fail with `open: database is locked` instead of the corruption message (A37-03's wording).
  - `test/audit/audit-40.test.ts` A40-02 (`it.fails`): three refused opens of a restored-backup image without `-shm` must run at most two integrity checks in all. Today they run 6 and read the index and WAL three times (pinned by the precondition test, which also pins that the WAL is kept and nothing is set aside).
- **Repro:** `node <a40>/scripts/concopen.mjs <r10k>/.atlas/index.db <a40>/r10k-L5.wal - ro 16 close 1 cur=$PWD/dist pre=<a40>/ab-64105ff/dist` (the `-` drops the `-shm`) · `node <a40>/scripts/bench.mjs <r10k>/.atlas/index.db <a40>/r10k-L5.wal - ro 3 0 cur=… pre=…` · `npx vitest run test/audit/audit-40.test.ts`
- **Cause:** `src/core/db/database.ts:131-140` (`decideWal`): the refusal (`throw corrupt(…)` when the WAL cannot be set aside) is decided after `integrityOk`, and nothing is remembered. The next opener finds the same leftover WAL (`leftoverWal`, `:151-159`) and starts again. `integrityOk` (`:258-268`, A40-01) makes each repetition twice as expensive and adds the full read.
- **Fix (options):** Remember the verdict keyed by the WAL's identity: its header salts and size, plus the index's size and mtime (`fileState` already builds the index's part). Keep it beside `.open.lock`, so a later opener with the same WAL and file refuses (or keeps) at once, as A35-01 also needs for a WAL that passed. Or decide the cheap preconditions of the set-aside (`holders`, `-shm` present, `neverCheckpointed`) before the confirmation pass of A40-01, which the refusal does not need when the first check already failed structurally.
- **Severity:** Low. It is an error path: the open is refused either way, and the user must act. But a supervisor or MCP client that retries pays O(index) per attempt, and concurrent retries queue for N × the decision.

### Open from AUDIT-35, AUDIT-30, AUDIT-26, AUDIT-22 and AUDIT-18 (re-checked against `64105ff`)

The `it.fails` tests for A18-03 (×2), A22-01, A22-02, A26-01, A27-03 (in `audit-27`), A35-01 (×2) and A35-02 still fail as expected on current: `npx vitest run test/audit/audit-18.test.ts test/audit/audit-22.test.ts test/audit/audit-26.test.ts test/audit/audit-27.test.ts test/audit/audit-35.test.ts`, 5 files and 34 tests pass, 41 s at load 11.4.

| ID | AUDIT-35 | Now | Status |
| --- | --- | --- | --- |
| A35-01 read-only opens repeat a passing check | 1.1 s per `atlas serve` start at realistic 10k | read-only opens of an own image: **1,055 ms** (`64105ff` 1,039 ms), one check each, the WAL kept; `it.fails` ×2 stand | Open (Low), unchanged |
| A35-02 signals wait for the current block | dense resolve 10.4 s; lock wait 2.4 s | `it.fails` stands (the child waited 3.05 s in all); the dense `--force` resolve block is **14.8 s** (`64105ff` 15.5 s), so Ctrl-C there waits up to that | Open (Medium), unchanged |
| A35-03 `holders()` per open beside a live writer | 19.8 ms against 4.6 | 11.7–29.6 ms against 20.0–31.9 ms on `64105ff` (both read `/proc/locks`; no WAL 6–10 ms) | Open (Low), unchanged |
| A22-01 resolve is one block | 4.71–4.80 s realistic, 9.57–9.69 s dense | dense `--force` **14.84 s** (`64105ff` 15.48 s; denser repo, load 9–11) | Open, unchanged |
| A22-02 carry quadratic in same-name symbols | 8.83 s block | `it.fails` stands (not re-timed) | Open, unchanged |
| A22-03 a second writer fails after 5 s | 1 of 418 failed at 5,007 ms | not re-timed; no code change on its path | Open (Medium) |
| A22-04 embed source cache unbounded | OOM at `--max-old-space-size=200` | realistic 10k fresh with `--max-old-space-size=200`: **`FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory`** after 73 s on both builds; dense `--force` peak heap 649–650 MB | Open, unchanged |
| A22-05 embed setup block | 0.96 s (no-op) | **1.16–1.26 s** (`64105ff` 1.03–1.05 s; load 8.3–9.6) | Open (Low), unchanged within load noise |
| A26-01 `immediate` stalls the MCP event loop | 4,972 ms max under a 5.5 s hold | `it.fails` stands | Open (Low), unchanged |
| A27-03 MCP search waits behind `atlas_index`'s lock wait | 4,972 ms | `it.fails` stands | Open (Medium in AUDIT-27), unchanged |
| A18-03 carry re-inserts edges on `--force` | dense `--force` 99.1–101.1 s | `it.fails` ×2 stand; dense `--force` 147.2 s (`64105ff` 144.4 s; denser repo, load 9–11) | Open |
| A18-05 got median | 4.95–7.22 | 6.65–9.71 on both builds (interleaved, load 10–11) | Open |

## No finding

- **Ordinary opens and opens beside a passing WAL:** SG150 adds no call. 10k symbols, no WAL: 7.6 against 9.8 ms. Own images up to a 332 MB WAL: within 4% of `64105ff`, with one check and 0 bytes read by `readAll` (pinned).
- **`fileState` / `reportAside`:** 0 µs without a set-aside file, 30–110 µs per open with one.
- **`readAll`'s memory:** one 1 MB buffer per call. The `atlas mcp`/`serve` processes' RSS did not change.
- **Concurrent openers beside a WAL that can be set aside:** one decision in all, 0 of 88 opens failed. SG150 adds its cost once.
- **10k runs, budgets:** unchanged from `64105ff` within noise. Every `test:perf` budget passes at load 8.8–10.4.
- Outside this audit's scope, noted for the soundness auditors and already in DECISIONS (SG130's residual) and AUDIT-34: a restored backup beside a later WAL passes the check whenever the WAL's pages happen to form valid trees on it. Here a later run that edited only `edges`, `imports` or `docs` rows (and a WAL that rewrote `symbols`) was kept as a mix with exit 0. Only edits to an indexed column in a table the WAL also rewrote failed.

## Method notes

`<scratch>` is `/tmp/claude-0/-home-claude/4e251245-6891-5f9e-85b7-3056e1cd87b8/scratchpad`, and `<a40>` is `<scratch>/a40`. The scripts are in `<a40>/scripts/` and are not checked in, because they load `dist` builds by path (`npm run build` first). The raw output of every group is in `<a40>/log.txt`. The large indexes and images were deleted after the runs (`<a40>` holds 92 MB: both builds' scripts, the repos and the log).
- `gen-dense.mjs <dir> <n>`: the dense repo. `audit-repo.mjs` (checked in) makes the realistic ones.
- `mkwal.mjs <db> <out> <mb>`: a killed writer's WAL of about `mb` MB on `<db>` (`<db>` itself is not written; checked by `sha1sum`), with `PAD` and `W_SQL` options. `mkstale.mjs <db> <tmp> <out> <mb>`: the restored-backup WAL; the run uses `A1SQL="PRAGMA foreign_keys=OFF; UPDATE refs SET file_id = file_id + 1 WHERE id > (SELECT max(id) - 20 FROM refs);"` and `W_SQL="UPDATE refs SET line = line + 1 WHERE id > (SELECT max(id) - 400 FROM refs);"`. Rebuilt images: `VACUUM INTO` on a read-only connection.
- `openone.mjs <dist> <db> <ro|rw> <close|kill|hold:ms>`: one instrumented open. `bench.mjs <db> <wal|-> <shm|-> <ro|rw> <n> <cold> <label=dist>…`: sequential, interleaved. `drop.py`: `posix_fadvise(DONTNEED)`.
- `concopen.mjs <db> <wal> <shm> <ro|rw> <n> <end> <reps> <label=dist>…`: concurrent opens.
- `startup.mjs <serve|mcp> <db> <wal> <shm> <n> <label=dist>…`: start to ready, then SIGTERM.
- `aside.mjs <dist> <db> <k> <opens>`: `reportAside` with `k` set-aside files.
- `probe.mjs`: `--import` preload for the whole runs (`PROBE_OUT`).
- Every process these scripts start exits or is killed by them. `pgrep` found none left after the runs.

`src/` is unchanged.

## Files added

| File | What it does |
| --- | --- |
| `test/audit/audit-40.test.ts` | A40-01 (`it.fails`): a restored-backup image whose check reports a structural row is decided with one integrity check (2 today). A40-02 (`it.fails`): three refused opens of the same image without `-shm` run at most two checks (6 today). Plain tests: the preconditions (the foreign image is set aside once after two checks and a read of at least the index and WAL size, and the next open checks nothing; each refusal runs two checks and a full read, keeps the WAL, and sets nothing aside), and a WAL that passes costs one check and reads less than a tenth of the index (held from before SG150). It counts `integrity_check` calls and `readSync` bytes, and times nothing. About 0.4 s. |

## Verification

`npm run typecheck && npm run lint && npx vitest run test/audit/audit-40.test.ts && npm run test:perf` passes: typecheck 15.1 s, lint 8.1 s (load 7.2), `audit-40` 1.0 s (5 tests), `test:perf` 20.8 s (load 8.8; 5 files, 9 passed, search p95 30.54 ms at 10,206 symbols). The final combined run took 50.3 s in all (rc 0, load 9.1–9.8; search p95 22.66 ms).
