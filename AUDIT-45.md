# AUDIT-45: Test coverage (round 10)

This audit checks whether the product suite (every test file outside `test/audit/`) catches a regression in the code
changed since AUDIT-38. Scope, all in `src/core/db/database.ts`:
- SG190 (#86): `reportAside`'s `held` gating through `inUse` (`holders`, else a probe under `<db>.open.lock`), the
  "has open … stop every Atlas process" reminder against the "stop every Atlas process …, then move it back" one,
  and the read-only open's `schema_version` read (its error ignored);
- the A41-03 texts: the cause (`<code>: <message>`, not prefixed twice) and the remedy (`free disk space (or fix the
  cause) and retry` only for `SPACE` codes, else `fix the cause and retry`), and `readAll` naming the index or its WAL
  in a short read instead of the deleted `.check` link;
- SG160 (#87), which moved the `audit-38` tests to `test/db/leftoverWal.test.ts`: the open AUDIT-38 findings
  (A38-01 … A38-06, with A32-01 and A32-02) are re-checked against the product suite;
- a few mutants elsewhere in `database.ts` where coverage showed product gaps (`nameBusy`, `nameCorrupt`,
  `closeOnSignal`).

Base: `6ee8710` on `claude/atlas-audit-45` (includes SG190 #86, SG160 #87 and AUDIT-42 #88). Node 22.22, 4 vCPU. The
auditor wrote none of this code. AUDIT-44 (noted in the brief, not in this tree) already observed that SG190's two
reminder messages are pinned only by audit files; this audit measures it.

Method:
- `npx vitest run --coverage --exclude 'test/audit/**'` (the product suite: 65 files, 597 tests), and once more with
  `audit-45.test.ts` added (`--exclude 'test/audit/!(audit-45).test.ts'`).
- 34 hand mutants of `database.ts`, one at a time, each one or two exact string replacements in a scratch copy of the
  tree (its own git repo, `node_modules` symlinked), restored with `git checkout -- src` and checked clean with
  `git status --porcelain -- src` after every mutant (all clean). The worktree's `src/` was never edited. Harness
  (`run.mjs`) and mutant list (`mutants.mjs`) are in the session scratchpad under `audit-45/`, not committed.
- Each mutant ran against the **whole product suite** (JSON reporter, no bail, every failing test recorded). Every
  survivor was run a second time against the whole product suite (18/18 survived again), then against
  `audit-41` + `audit-42` (SG190's audit pins), against `audit-45.test.ts`, and the six still unexplained against all
  of `test/audit/`.
- Two first runs reported a survivor that every rerun kills (I04 on the product suite: 1 survive, then 4/4 killed; G01
  on `audit-41`+`audit-42`: 1 survive, then 3/3 killed). I could not find the cause (no concurrent edit of `src/`
  during either run); they are counted as killed, and every survivor below is confirmed by a second full run.

**Headline:**

| Scope | Lines | Branches | Functions | Threshold |
| --- | --- | --- | --- | --- |
| `src/core`, without `test/audit` | **97.9% (5562/5684)** | 91.2% (2744/3010) | 98.1% (360/367) | 90% / 88% / 96%: pass |
| `src/core`, without `test/audit`, plus `audit-45` | 98.0% (5569/5684) | 91.2% (2743/3007) | 98.1% (360/367) | |
| `db/database.ts`, without `test/audit` | 95.4% (437/458) | 90.9% (190/209) | 35/37 | |
| `db/database.ts`, plus `audit-45` | 96.9% (444/458) | 91.7% (189/206) | 35/37 | |

The 85% lines target is met (97.9%). AUDIT-38 measured 94.4% lines and functions failing (94.8%) without
`test/audit`; SG160 fixed that (`database.ts` 50.2% → 95.4% lines).

**Mutations (34):**
- **Scope (SG190, A41-03 texts, short-read naming; 18 mutants): 5 killed (28%) by the product suite.** 13 survive all
  597 product tests. Of those, 9 are killed by `audit-41`/`audit-42` (G06 only by A42-03's `it.fails`), T02 by
  `audit-37`, T03 and N02 only by `audit-45`, and G05 by nothing (no effect found).
- **With `audit-45.test.ts`: 15 of 18 (83%).** Left: G05 (fails safe, no effect found), G06 (killed by
  `audit-42` A42-03's `it.fails`: the direction of its fix), R02 (killed by `audit-42` "SG190 held").
- **Re-checks of AUDIT-38 (A38-01/03/04/05) (11 mutants): 11 killed by the product suite** (`test/db/leftoverWal`).
- **Carry-overs and gaps elsewhere (5): 0 killed by the product suite** (V01, V02: A32-01/02 still open; X01–X03
  pinned only by `audit-27`/`-28`/`-31`).
- **Total: 16 of 34 killed by the product suite**; 31 with the existing `test/audit` (G06 only through an `it.fails`),
  33 with `audit-45`; G05 is never killed (fails safe).

**Totals:** 0 critical, 1 high, 0 medium, 3 low. One new SG row (SG230).

## Coverage

### Not run by the product suite (in-process, `database.ts`)

| Lines | What it is | With `audit-45` |
| --- | --- | --- |
| 98-100 | the read-only `schema_version` read's `catch` (ignored error) | not run |
| 394 | the "which a running Atlas process has open: stop every Atlas process …" reminder | run |
| 408-413 | `inUse`'s fallback: the probe under `<db>.open.lock` when `holders` cannot tell | run |
| 164-165 | `leftoverWal`'s `catch` | not run |
| 262 | `integrityOk` without hard links | not run |
| 317-318 | `integrityResult`'s rethrow of a non-corruption error | not run |
| 361-362, 384-385 | `fileState`'s and `reportAside`'s `catch` | not run |
| 604-607 | `closeOnSignal`'s handler (run only in child processes by `audit-31`) | not run |

Line coverage of the SG190 reminder is not the problem: line 386 (`held`) runs, but only ever with `inUse` false, so
any change to what `inUse` answers or to the "has open" text passes (below).

## Mutation results

"Product" is the whole suite without `test/audit` (597 tests). "Audit" names the audit file that kills a product
survivor. Killing tests are named for product kills.

### SG190: `inUse` gating and the read-only read (`reportAside`, `inUse`, `openDatabase`)

| ID | Mutation | Product | Audit | audit-45 |
| --- | --- | --- | --- | --- |
| G01 | `held` never true (`&& inUse(path)` → `&& false`) | **SURVIVED** | `audit-41` SG190, A41-01; `audit-42` A42-01 pinned | killed (3 tests) |
| G02 | `held` always true | killed (`leftoverWal` "is set aside, reported, and offered back") | | |
| G03 | `inUse` reads a `/proc/locks` answer as "nobody" | **SURVIVED** | `audit-41` SG190, A41-01; `audit-42` | killed |
| G04 | `inUse`'s probe fallback says "nobody" | **SURVIVED** | `audit-42` A42-01 pinned (probe half) | killed |
| G05 | `inUse` = file **or** `-shm` held | survived | none | survived: fails safe, no effect found |
| G06 | `inUse` probes without `<db>.open.lock` | survived | only `audit-42` A42-03's `it.fails` (direction of its fix) | survived |
| R01 | read-only open does not read `schema_version` | **SURVIVED** | `audit-41` SG190, A41-01; `audit-42` | killed |
| R02 | the read-only read's error is thrown at open | survived | `audit-42` "an error from the read-only open's read is not lost" | survived |

### SG190: the reminder texts (`reportAside`)

| ID | Mutation | Product | Audit | audit-45 |
| --- | --- | --- | --- | --- |
| M01 | held branch says the move-back text (A41-01's reminder) | **SURVIVED** | `audit-41` SG190, A41-01; `audit-42` | killed |
| M02 | move-back text drops "stop every Atlas process on the project, then" | **SURVIVED** | `audit-41` SG190; `audit-42` A42-02 pinned | killed |
| M03 | held and not-held texts swapped | killed (`leftoverWal` "is set aside, reported, and offered back") | | |

### A41-03: cause, remedy and short-read naming (`integrityOk`, `readAll`)

| ID | Mutation | Product | Audit | audit-45 |
| --- | --- | --- | --- | --- |
| T01 | remedy always "free disk space" | **SURVIVED** | `audit-41` SG150, A41-03 | killed |
| T02 | remedy never "free disk space" | **SURVIVED** | `audit-37` SG140 | killed |
| T03 | `SPACE` widened to any `SQLITE_IOERR*` (the pre-A41-03 remedy for `SQLITE_IOERR_READ`) | **SURVIVED** | none | killed |
| T04 | cause not prefixed with its code | killed (`leftoverWal` "when the check cannot run") | | |
| T05 | cause prefixed twice when the message has the code | killed (`leftoverWal` "when index.db cannot be read …") | | |
| N01 | short read of the file names the `.check` link | killed (`leftoverWal` "on a short read between the checks") | | |
| N02 | short read of the WAL names the `.check-wal` link | **SURVIVED** | none | killed |

### AUDIT-38 re-checks (SG160)

| ID | Mutation (AUDIT-38 finding) | Product |
| --- | --- | --- |
| I03 | `readAll` of the file and WAL dropped (A38-01) | killed (`leftoverWal`, 3 tests) |
| I04 | `readAll` of the WAL dropped (A38-01) | killed (`leftoverWal` "when the WAL cannot be read"; see Method) |
| I09 | error code compared without `& 0xff` (A38-01) | killed (`leftoverWal` "row error code of SQLITE_CORRUPT") |
| A01 | a 0-byte read ends the loop (A38-01) | killed (`leftoverWal` "on a short read") |
| N05 | no `-shm` counts as never checkpointed (A38-03) | killed (`leftoverWal` "refused: no -shm") |
| P01 | a probe that cannot run means "nobody" (A38-03) | killed (`leftoverWal` "neither /proc/locks nor a probe") |
| D03 | `after` holders not required (A38-03) | killed (same) |
| K04 | lock file not creatable throws (A38-03) | killed (`leftoverWal` "cannot be created") |
| C03 | open lock released before the index is opened (A38-03) | killed (`leftoverWal` "locks other openers out") |
| W01 | an own WAL does not withdraw the move-back (A38-04, AUDIT-38's T01) | killed (`leftoverWal` "is withdrawn …") |
| H04 | minor's high bits dropped (A38-05) | killed (`leftoverWal` "minor over 255") |

### Carry-overs and elsewhere

| ID | Mutation | Product | Audit |
| --- | --- | --- | --- |
| V01 | SG105 reverted: the size taken in the `catch` (A32-01) | **SURVIVED** | `audit-28` A28-01, `audit-30` A30-01 |
| V02 | a one-page file counts as empty (A32-02) | **SURVIVED** | `audit-32` S04 |
| X01 | `nameBusy` names an error twice | **SURVIVED** | `audit-27`, `audit-28` N01 |
| X02 | `nameCorrupt` names an error twice | **SURVIVED** | `audit-31` SG120 |
| X03 | `closeOnSignal`'s remover a no-op (handlers left installed) | **SURVIVED** | `audit-31` SG120 |

To reproduce one mutant, for example G01:

```
# in src/core/db/database.ts, in reportAside, replace
#   names.some((f) => f.endsWith(`-${state}`)) && inUse(path);
# with
#   names.some((f) => f.endsWith(`-${state}`)) && false;
npx vitest run --exclude 'test/audit/**'                          # 65 files, 597 passed: survives
npx vitest run test/audit/audit-45.test.ts -t A45-01              # 3 failed: expected 'atlas: …' to match /which a running Atlas process has ope…/
git checkout -- src/core/db/database.ts
```

## Findings

### Critical

None.

### High

**A45-01: SG190's guard is pinned only by `test/audit/`. Any change that makes the reminder offer the move-back
while an Atlas process holds the index passes all 597 product tests.** High.
- Class: untested guarantee (G01, G03, G04, R01, M01, M02; `database.ts:386`, `394`, `97`, `408-413`). The A32-01 /
  A38-02 class, now for SG190.
- Evidence:
  - SG190 fixed A41-01 (high): with `atlas serve` or `atlas mcp` holding the index, the reminder said "move it back",
    and following it made the dashboard answer 200 from a mix while the CLI refused the index as malformed, and left
    it failing `integrity_check` after the server stopped. SG190 changed no file outside `test/audit/`
    (`git show --stat 6c68a67`: `database.ts`, `audit-41.test.ts`, `audit-38.test.ts`, docs) and SG160 moved only the `audit-38` tests.
  - In the product suite no connection is ever open while a set-aside WAL is reported, so `inUse` always answers
    false: the "has open" text (line 394) and `inUse`'s probe fallback (408-413) never run. G01 (`held` never true),
    G03 (`/proc/locks` read as "nobody"), G04 (probe says "nobody"), R01 (`atlas serve` holds no lock until its first
    query) and M01 (the held branch prints A41-01's "move it back" text) each bring A41-01 back and pass 597/597,
    twice each. M02 drops the "stop every Atlas process on the project, then" half of the move-back text: survives.
  - Each is killed by `audit-41` (SG190 pinned test and A41-01) and `audit-42` (A42-01's pinned half), which drive a
    real `atlas serve`: under G01 `expected 'atlas: …' not to match /move it back/`. So today a regression turns
    red only in the audit files, which were written to show a defect, not to define the contract (AUDIT-38's
    argument for A38-02). AUDIT-44 made the same observation for the two reminder texts.
- Repro: G01 above (`npx vitest run --exclude 'test/audit/**'`: 597 passed); likewise G03
  (`if (h) return liveWal(h);` → `if (h) return false;`), R01 (`db.pragma('schema_version');` → `void 0;`), M01.
- Test (plain `it`, correct today): `A45-01` in `audit-45.test.ts`, in-process: a writable connection held by the
  test (`atlas mcp`), a read-only one (`atlas serve`, not yet queried), the same holder without `/proc/locks` (probe),
  and the move-back text once the holder is closed. Kills G01, G03, G04, R01, M01, M02 (and M03, G02).
- Fix (SG230): move these tests, or the `audit-41` SG190 test, into `test/db/leftoverWal.test.ts`.

### Medium

None.

### Low

**A45-02: The A41-03 remedy and the WAL's short-read name are unpinned by the product suite; two of them by any
test before `audit-45`.** Low.
- Class: untested boundary (T01, T02, T03, N02; `database.ts:286-289`, `268`).
- Evidence: `leftoverWal`'s refusal tests match `…\(${code}: ${msg}\); it is kept` and stop before the remedy, and
  its short-read test reads only the file. T01 (always "free disk space") is killed by `audit-41`; T02 (never) only by
  `audit-37`'s exact SG140 message; T03 (any `SQLITE_IOERR*` is a space problem, i.e. A41-03's "free disk space" for
  `SQLITE_IOERR_READ`) and N02 (the WAL's short read names `index.db.<pid>.<ms>.check-wal`, a deleted file with a
  different name every run) by nothing but `audit-45`. Wrong advice, no data at risk.
- Repro: T03 (`/^(SQLITE_FULL|SQLITE_IOERR_(SHMSIZE|WRITE|TRUNCATE)|ENOSPC|EDQUOT|EFBIG)$/` →
  `/^(SQLITE_FULL|SQLITE_IOERR|ENOSPC|EDQUOT|EFBIG)/`): 597 product tests pass, and `npx vitest run test/audit
  --exclude test/audit/audit-45.test.ts` passes too.
- Test (plain `it`): `A45-02` (SPACE codes say "free disk space", `SQLITE_IOERR_READ`/`SHORT_READ`/`SQLITE_IOERR` say
  "fix the cause" only; a cause already starting with its code is not prefixed twice) and `A45-03` (short read of
  `index.db` and of `index.db-wal`, never `.check`).

**A45-03: The rest of SG190 that no product test reaches: the read-only read's ignored error, the probe's open lock,
and `inUse`'s "both locks" rule.** Low.
- Class: untested boundary (R02, G06, G05; `database.ts:98-100`, `408`).
- Evidence: R02 (the `schema_version` error thrown at open, so a garbage or non-Atlas index fails at open with an
  unnamed error and the connection leaks, A29-02) is killed only by `audit-42` "SG190 held". G06 (no
  `<db>.open.lock` around `inUse`'s probe) is killed only by `audit-42` A42-03's `it.fails`, i.e. it is A42-03's fix
  direction; dropping the lock is a race with a concurrent check, not shown by any test. G05 (`h.db || h.shm`) only
  says "has open" in more cases: fails safe, no effect found.
- Fix: none needed beyond SG230; moving `audit-42`'s "SG190 held" test with it would pin R02.

**A45-04: Carry-overs.** Low.
- A32-01 open: V01 (SG105 reverted) passes 597 product tests; killed only by `audit-28` A28-01 and `audit-30` A30-01.
- A32-02 open: V02 killed only by `audit-32` S04.
- X01 (`nameBusy` once-guard, A28-03) still pinned only by `audit-27`/`audit-28`; X02 (`nameCorrupt` once-guard) and
  X03 (`closeOnSignal` removing its handlers, SG120/A31-02) only by `audit-31`. `closeOnSignal`'s handler (lines
  604-607) runs only in `audit-31`'s child processes.

## Re-verified

| Finding | Status | Evidence |
| --- | --- | --- |
| A38-01 SG150 guards unpinned | **fixed** (SG160) | I03, I04, I09, A01 killed by `leftoverWal` |
| A38-02 SG120–SG150 audit-only; functions threshold | **fixed** (SG160) | without `test/audit`: functions 98.1% (≥ 96%), `database.ts` 95.4% lines; every re-check mutant killed by the product suite |
| A38-03 fail-closed fallbacks, lock, `-shm` rules | **fixed** (SG160) | P01, D03, K04, C03, N05 killed by `leftoverWal` |
| A38-04 move-back after a WAL-only write | **fixed** (SG160) | W01 killed by `leftoverWal` "is withdrawn …" |
| A38-05 minor-number decoding | **fixed** (SG160) | H04 killed by `leftoverWal` "minor over 255" |
| A38-06 carry-overs | **open** | A32-01 (V01) and A32-02 (V02) survive the product suite (A45-04) |
| A32-01 SG105 pinned by audit only | **open** | V01: 597 passed; `audit-28`, `audit-30` |
| A32-02 one-page boundary | **open** | V02: 597 passed; `audit-32` |

## Verification

On `6ee8710` plus `AUDIT-45.md`, `test/audit/audit-45.test.ts` and the PLAN lines, on 4 vCPU (wall clock):

| Command | Result | Wall clock |
| --- | --- | --- |
| `npx vitest run --coverage --exclude 'test/audit/**'` | 65 files, 597 passed; thresholds pass | 100 s |
| `npx vitest run --coverage --exclude 'test/audit/!(audit-45).test.ts'` | 66 files, 606 passed; thresholds pass | 61 s |
| `npm run typecheck && npm run lint && npx vitest run test/audit/audit-45.test.ts` | pass; 9 tests; `src/` unchanged | 21 s |
