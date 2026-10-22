# AUDIT-25: soundness (round 7, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `cf6b638` (SG65 and SG80 merged) on
`claude/atlas-audit-25`. Date: 2026-10-22.

Question: can Atlas silently lose, duplicate or misreport index data, or show something stale as current? Scope:
the changes since AUDIT-21 and the findings that are still open:
- SG65: `createWalFile` (a fresh index is a pre-made WAL-mode file, hard-linked into place), `nameBusy`, and the
  step labels in `indexer.ts`;
- SG80: `immediate(db, fn)` (`BEGIN IMMEDIATE` retried every ~10 ms for up to 5 s, `busy_timeout` lowered to 10 ms
  while it polls, and a savepoint inside an outer transaction). Its callers: the start and finish stamps, the
  per-file write, the retry blanking, the prune, `resolveGraph`, the embedding batches, `upsertDoc`, `deleteFile`, and
  `nameBusy(…, 'docs write')` in the docs command;
- open findings: A21-01, A21-02, A17-01, A17-04, A17-05 and A13-04..A13-06.

Method:
- **Lock-hold injection on real repos.** I used copies of express, flask and got from the read-only clones in the
  scratchpad. For each repo I:
  - indexed it;
  - edited the tree: an appended function in 8–10 files, one file deleted and one renamed;
  - re-indexed while a worker thread (`test/helpers/lockHolder.ts`) held the write lock for 5.6 s, starting just
    before the k-th `immediate`. I chose k to hit the start stamp, a per-file write, the prune, the resolve, each
    embedding batch and the finish stamp;
  - ran the index again with no hold, and compared files, symbols, edges (`path::kind:qname@line`), the embedded
    symbol set, the vector count and the integrity check with a fresh index of the edited tree.
- **A concurrent writer.** On a 1,058-file trpc copy, a second process ran `atlas index --force` 3 times. During each
  run it called `upsertDoc` (through `immediate`) and `clearDocTombstones` (a plain autocommit write) every 20 ms. I
  compared the result with a fresh index.
- **Kill and delete.** I SIGKILLed `atlas index` (the built CLI) on got, at 0.4–2.0 s into a first or a forced run,
  then deleted `.atlas/index.db` and ran `atlas index` again. I ran the same sequence on the pre-SG65 tree
  (`c9758a0`, built from `git archive`).
- **Drift after a failed run** on express, flask, got and trpc:
  - index the repo and write docs with the offline client;
  - add 8–15 cross-module calls;
  - make the resolve fail with `SQLITE_BUSY`;
  - compare `runDrift` against its answer after the next run.
- **In-process attacks** (`test/audit/audit-25.test.ts`). A proxy `db` makes the k-th `immediate` fail at once with
  `SQLITE_BUSY`, which is the state a 5 s timeout leaves. I failed each write of an edit run in turn and checked
  every one against the uninterrupted run. I also tested a doc write that races a prune, and a WAL left beside a
  deleted index.

Repros are in `test/audit/audit-25.test.ts`. Each `it.fails` asserts the correct behaviour. I ran each one once as a
plain `it`, and each failed on the assertion that names its defect (messages below). Plain `it` blocks pin what was
attacked and held.

**Summary: 0 critical, 1 high, 1 medium, 1 low.**
- What holds:
  - SG80's `immediate` never runs `fn` twice and always restores `busy_timeout`.
  - Every injected failure names its step, writes nothing of that step and converges to a fresh index on the next
    run (express, flask, got, and every write of the in-test edit run).
  - A writer beside a forced trpc run is waited out with 0 errors, and the result equals a fresh index.
- The high is a regression from SG65 (A25-01). `createWalFile` links a non-empty WAL-mode file into place, so a
  `-wal` left by a killed or crashed run is replayed into it when the user deletes `index.db` to start over. Two
  outcomes:
  - **Malformed:** every command fails with `database disk image is malformed`, permanently. This happened in 6/6
    kills of a forced or second run on got, and SQLite does not repair it.
  - **Resurrected:** the deleted index's rows come back silently.

  Before SG65, SQLite discarded that WAL because the new file was empty (pinned).
- The medium: drift does not notice that the last index run did not finish (A25-02). After a run fails at its resolve
  (SG80's `graph resolve: database is locked`) or is killed, drift reads the carried graph. It reports a doc whose
  callers changed as fresh: 6 of 14 stale docs missed on express, 8 of 16 on flask, 8 of 21 on got and 11 of 22 on
  trpc.
- The low: a doc `atlas docs` writes for a file that an index run pruned while the LLM call was in flight becomes an
  orphan row. It stays in `counts().docs` for good (A25-03).
- A21-01, A21-02, A17-01, A17-04, A17-05 and A13-04..A13-06 are still open. Their `it.fails` still fail at `cf6b638`
  when run as plain `it`.

PLAN rows: SG90 (A25-01).

## Re-verified (changes since AUDIT-21)

| Change | Attack | Result |
| --- | --- | --- |
| SG80 `immediate`: `fn` runs once | a lock held across the BEGIN (1 s, 6.5 s); `fn` that throws `SQLITE_BUSY` itself; a COMMIT error (code reading: `began` is set, so no retry, and better-sqlite3 rolls back) | `fn` runs once, or not at all when the BEGIN never succeeds. A busy error from inside `fn` is rethrown and not retried. The existing `test/db/locking.test.ts` cases pass, and the step injection (below) never duplicated a row. |
| SG80 `busy_timeout` | `fn` throws; a 5 s timeout; nested calls | `finally` restores 5000 on every path. A nested call takes the savepoint path and never touches the pragma. The only statements run at 10 ms are those of `fn`, which already holds the write lock. In WAL mode the commit's auto-checkpoint is PASSIVE and does not wait, so a 10 ms timeout cannot fail it. |
| SG80 savepoint | `deleteFile` inside the prune transaction; a failure at the prune | The tombstone and the file delete are one unit with the prune. A failed prune leaves no tombstone, and the next run writes exactly one: `['gone.ts']` at every failure point (pinned). |
| SG80 index writes | `SQLITE_BUSY` at every `immediate` of an edit run: in-test, the run has the start stamp, 3 files, the prune, the resolve, 1 embedding batch and the finish stamp. On real repos, a 5.6 s real hold at k ∈ {1, 2, prune, resolve, each embedding batch, finish}: express 8 points of 16, flask 6 of 22, got 6 of 15 | Every failure has the right label: `run stamp`, `index write`, `graph resolve`, `embeddings write` or `run stamp`. The next run equals the uninterrupted run and a fresh index on files, symbols, edges, embeddings, vector count and tombstones. Its reason is `files changed` when the failure was before the resolve and `previous run interrupted` from the resolve on (pinned). A failure at the start stamp leaves no `runs` row, so the A21 note "unstamped first run" is closed. |
| SG80 beside a writer | trpc (1,058 files) `--force` × 3, with a second process calling `upsertDoc` (`immediate`) and `clearDocTombstones` (a plain write) every 20 ms; in-test, a 150 ms hold after every parsed file | 0 errors. Writer waits peaked at 379 ms (`upsertDoc`, during the resolve) and 9 ms (`clearDocTombstones`). The run took 6.8–7.1 s and its result equals a fresh index, with integrity `ok` (pinned in-test). |
| SG80 doc writes | `atlas docs` beside an index run (in-test interleavings, by code reading of `synthesizeDocs`) | Drift is never wrong in the "fresh" direction: a doc is stored with the hash of the prompt it was generated from, so a doc built from mid-run state is stale against the final state. A pruned target is the exception (A25-03). |
| SG65 `createWalFile` race | 6 processes × 60 fresh opens at the same instants (`test/db/locking.test.ts`); code reading | `linkSync` never replaces an existing file, and `EEXIST` falls back to opening it. No open lost data or failed. The tmp file is removed in `finally`. |
| SG65/SG80 labels | every injected failure; `docs` | `nameBusy` names each error once and only when the code is `SQLITE_BUSY*`. `docs write` covers `importPersistedDocs` and `synthesizeDocs`. |

## Critical

None found.

## High

### A25-01 Deleting `index.db` after a killed run brings back the old WAL: the new index is malformed or holds the deleted rows (SG65 regression)

- **Evidence:**
  - **Where the WAL comes from.** A killed or crashed process leaves `index.db-wal` behind. That can be a SIGKILLed
    run (the SG33 scenario), an OOM (A22-04) or a crash. The usual reset is to delete `.atlas/index.db` and index
    again.
  - **What SG65 changed.** `createWalFile` links in a one-page file whose header already says WAL. When the new file
    opens, SQLite finds the old `-wal` with valid checksums and replays its frames into it. Before SG65 the new file
    was 0 bytes, and SQLite deletes the WAL of an empty database (`pagerOpenWalIfPresent`).
  - **got, with the built CLI.** I SIGKILLed `atlas index --force` (or `atlas index` after an edit) at 0.5, 1.0,
    1.6 and 2.0 s, deleted `index.db`, then ran `atlas index`.
    - This build: `atlas: database disk image is malformed` 4/4 times. Every later command fails the same way, until
      the user also deletes `index.db-wal`.
    - Pre-SG65 tree (`c9758a0`): 3/3 runs gave an index identical to a fresh one (96 files, 1,090 symbols, 3,138
      edges, integrity `ok`).
    - When the first index of got was killed at 0.8 and 1.2 s: malformed 2/2.
  - **A WAL that holds every page.** This is the case when the first index was killed before a checkpoint. The
    deleted index comes back silently: in-test, all 500 rows. On got (kill at 0.4 s), the next run reported
    `wrote 976 symbols` instead of 994, because it skipped files the resurrected rows already held. It still ended
    equal to a fresh index, because the resurrected run was stamped and unfinished, so it was re-resolved.
  - **No remedy in the message.** The error does not mention the WAL, and the README gives no reset procedure, so
    users will hit this again on the next reset.
- **Tests:**
  - `A25-01 … does not come up corrupt` fails with `SqliteError: database disk image is malformed` (thrown by the
    open).
  - `A25-01 … starts empty` fails with `expected 500 to be +0`.
  - The plain `it` `SQLite itself drops a leftover WAL beside a 0-byte database file` pins the pre-SG65 behaviour
    that the fix can rely on.
- **Repro:**
  1. `atlas index` on got.
  2. `atlas index --force &`, then `sleep 1; kill -9 $!`.
  3. `rm .atlas/index.db`.
  4. `atlas index`.
- **Cause and fix:** `src/core/db/database.ts:40-43` and `:78-93`. When `${dbPath}-wal` exists, do not pre-create
  the file. Fall back to the plain open: SQLite then deletes the stale WAL of a 0-byte database itself, under its own
  locks. Unlinking the WAL from Atlas instead would race a concurrent creator that has already started writing it.
  Optionally, name the WAL in a `SQLITE_CORRUPT` error at open.

## Medium

### A25-02 Drift trusts the graph of an index run that never finished, so a doc whose callers changed is reported fresh

- **Evidence:**
  - **What drift compares.** A module doc's hash covers its incoming and outgoing calls. Drift recomputes the hash
    from the current graph and does not look at `runs`.
  - **Where the window opens.** An index run that fails at or after its resolve leaves the carried graph in place.
    The cause can be SG80's `graph resolve: database is locked …` (another writer held the lock past 5 s, e.g. A22-03
    in reverse), a kill or a crash. The carried graph has the re-parsed files' old edges and none of their new ones.
  - **What drift then says.** The re-parsed files themselves are stale (their content hash changed). The files they
    now call are reported fresh. That stays true until the next index run re-resolves (`previous run interrupted`).
  - **Real repos**, with offline docs, 8–15 added cross-module calls and the resolve made to fail:

    | Repo | Stale docs drift reports | Stale docs after the next run | Missed |
    | --- | --- | --- | --- |
    | express | 8 | 14 | 6, e.g. `lib/express.js` |
    | flask | 8 | 16 | 8, e.g. `src/flask/cli.py`, `src/flask/sansio/scaffold.py` |
    | got | 13 | 21 | 8 |
    | trpc | 11 | 22 | 11 |

  - **Who sees it.** `atlas drift`, `atlas_drift` (an agent that calls it after `atlas_index` returned `isError`) and
    the dashboard. CI is not affected: `atlas index` exits 1 first.
- **Test:** `A25-02 drift after an index run that failed at its resolve …` fails with
  `expected [ 'b.ts' ] to deeply equal [ 'a.ts', 'b.ts' ]`. The plain `it` beside it shows that `a.ts` is stale once
  a run finishes.
- **Repro:**
  1. `a.ts` holds `export function f()`, and `b.ts` holds `export function g()`.
  2. Index, then run `atlas docs --offline`.
  3. Make `b.ts` call `f`.
  4. Hold the write lock across the resolve: `atlas index` exits 1 with `graph resolve: database is locked …`.
  5. `atlas drift` lists `b.ts` only.
- **Cause and fix:** `src/core/drift/run.ts` and `detect.ts` ignore whether the last run finished, and A13-03's fix
  (SG33) covered only the next index run. When the newest run is unfinished, drift should either:
  - report every doc as possibly stale (`unindexed`-style), or
  - refuse with "the last index run did not finish; run `atlas index`" (CLI exit 2, MCP `isError`).

## Low

### A25-03 A doc written for a file that an index run pruned during the LLM call is an orphan row, counted forever

- **Evidence:**
  - **The interleaving.** `synthesizeDocs` reads the file list, then awaits the LLM for each file. An `atlas index`
    in another process can prune file X in between: X's doc becomes a tombstone and the `files` row is deleted.
  - **The orphan.** `upsertDoc` then inserts a new `file` doc for X's id, which no longer exists. It never matches a
    file, `clearDocTombstones` does not remove it, and no later run deletes it.
  - **What is wrong.** `counts().docs` counts one doc more than `docsFromDb` returns. `counts` is exported from
    `@atlas/core`, and its value is written into every run's `stats_json.totals`. The dashboard and drift count
    docs through `docsFromDb`/`listDocs`, so they are not affected.
  - **Why it is more likely now.** SG80 makes this path routine: the doc write now waits for the index run instead
    of failing.
  - **Drift.** Not affected: the orphan maps to no path.
- **Test:** `A25-03 …` fails with `expected 1 to be +0`.
- **Fix:** in `upsertDoc`, inside its `immediate`, skip a `file` target whose `files` row is gone and return `0`.
  Alternatively, delete docs whose `file` target is missing in `clearDocTombstones`.

## Notes (no test)

- **`SQLITE_BUSY_RECOVERY` is not retried.**
  - `immediate` retries only the exact code `SQLITE_BUSY`, and polls at a 10 ms busy timeout. A `BEGIN IMMEDIATE`
    that meets another connection's WAL recovery for longer than 10 ms fails at once with `SQLITE_BUSY_RECOVERY`,
    named by `nameBusy`.
  - This needs a crash and a second process at the same moment, and each process runs recovery during its own open
    first, so I did not reproduce it.
  - Fix: match `startsWith('SQLITE_BUSY')`, except `SQLITE_BUSY_SNAPSHOT`.
- **A kill can leave a tmp file.** A kill between `new Database(tmp)` and `rmSync` leaves
  `index.db.<pid>.<ms>.tmp` in `.atlas/`. The window is a few milliseconds and the walker skips `.atlas/`.
- **No hard links.** On a filesystem without hard links (`EPERM`), `createWalFile` falls back silently, and the
  SG65 race (two processes switching a fresh file to WAL) comes back there.
- **Broad labels.**
  - `run stamp` also covers the reads and the walk before the start stamp.
  - `index write` also covers the retry blanking and the prune.
  - `docs write` also covers reads.

  Only `SQLITE_BUSY*` errors are relabelled, and reads in WAL mode do not get one outside recovery, so no error is
  mislabelled in practice.
- **Docs beside a long resolve (A22-03).** `atlas docs` beside a resolve longer than 5 s still fails, because its
  `upsertDoc` waits at most 5 s. The generated doc is lost after its tokens were spent, and `exportDocs` is skipped
  for that run. The DB and `.atlas/docs` converge on the next `atlas docs`.
- **The event loop blocks while `immediate` waits.** The wait is synchronous, up to 5 s per write. In `atlas mcp`,
  an `atlas_index` that waits behind another process's write blocks every other request for that time. Before SG80
  it failed at once.
- **Still open.** A21-01, A21-02, A17-01, A17-04, A17-05, A13-04, A13-05 and A13-06 (plus the lows A13-07..A13-12).
  I ran the audit-13, audit-17 and audit-21 files with `it.fails` → `it`: all 9 of these tests still fail.
