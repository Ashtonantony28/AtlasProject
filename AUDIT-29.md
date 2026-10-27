# AUDIT-29: soundness (round 8, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `e55d031` (SG90 merged) on
`claude/atlas-audit-29`. Date: 2026-10-22.

Question: can Atlas silently lose, duplicate or misreport index data, or show something stale as current? Scope:
the changes since AUDIT-25 and the findings that are still open:
- SG90 in `src/core/db/database.ts`:
  - when `<db>-wal` exists beside a missing index, `openDatabase` skips `createWalFile`, so SQLite creates a 0-byte
    file and drops the stale WAL itself;
  - `switchToWal` retries `SQLITE_BUSY` and `SQLITE_IOERR_DELETE_NOENT` every 10 ms for up to 5 s, but only while
    the file is 0 bytes;
  - SG90's interplay with SG65 (`createWalFile`'s hard link) and SG80 (`immediate`);
- open findings: A25-02, A25-03, A21-01, A21-02, A17-01, A17-04, A17-05 and A13-04..A13-06.

Method:
- **Kill, delete and reopen on real repos.** I used copies of express, flask and got from the read-only clones in
  the scratchpad and the built CLI (`dist/`). For each repo I:
  - SIGKILLed `atlas index` (a first run) and `atlas index --force` (after a full index), at 0.4, 0.8, 1.2, 1.6 and
    2.0 s;
  - deleted `.atlas/index.db` only, leaving `-wal`, `-shm`, `index.db.lock` and its `-journal`;
  - ran `atlas index` again, and compared files, symbols, edges (`path::kind:qname@line`), the embedded symbol set,
    the vector count, the tombstones and the integrity check with a fresh index of the same tree.
- **A live process holding the index.** `atlas serve` (read-only) and `atlas mcp` (read-write) keep the index open
  for their whole life. I deleted `index.db` under them and opened it again, in separate processes:
  - on express with the CLI;
  - in a harness (500-file index; 50 files written since the holder opened, or none; the holder closed or
    SIGKILLed afterwards);
  - against SG90, SG65 (`cf6b638`) and pre-SG65 (`c9758a0`) trees, built from `git archive`.
- **Racing creators beside a stale WAL.** N processes open the same fresh index at the same instants. A stale WAL
  (full-page or partial, with or without `-shm`) sits beside each of the 60–100 indexes. Writers each write one row;
  readers open read-only. I ran 6 writers × 60, 6 + 4 readers × 60, 12 × 100, 6 + 6 readers × 100, 12 × 100 with no
  stale WAL, and, under 8 CPU burners on 4 cores, 12 × 100 and 8 + 4 readers × 100. I checked writer errors, lost
  writes (rows per index against successful writers), journal mode and integrity.
- **Paths.** I tested a symlinked `index.db` (absolute and relative target) whose target was deleted beside a stale
  WAL, a symlinked `.atlas/` directory, a relative path, a dangling link with no WAL, and a `-shm` left alone.
- **The retry.** I checked:
  - a 0-byte file nobody is creating;
  - a 0-byte file whose lock another connection holds past the busy timeout;
  - a 0-byte index left by a kill before the switch, beside a stale WAL, opened read-only first;
  - a non-database file.

Repros are in `test/audit/audit-29.test.ts`. Each `it.fails` asserts the correct behaviour. I ran each one once as a
plain `it`, and each failed on the assertion that names its defect (messages below). Plain `it` blocks pin what was
attacked and held.

**Summary: 0 critical, 0 high, 1 medium, 1 low.**
- What holds:
  - SG90 fixes A25-01 on real repos. All 30 kill → `rm index.db` → `atlas index` runs (express, flask, got; first and
    forced runs; 5 kill points each) gave an index identical to a fresh one, with integrity `ok`. In-test, a WAL
    left by a really SIGKILLed writer is dropped.
  - The 0-byte race loses nothing. Over 4,520 racing writer opens beside stale WALs (and 1,200 without), including
    under CPU load, there were 0 writer errors and 0 lost writes, and every index came up in WAL mode with integrity
    `ok`.
  - The retry masks nothing. A 0-byte file nobody is creating opens at once. A lock held past the busy timeout fails
    after 5 s, as `journal mode: database is locked (…)`. A non-empty file in rollback mode held by another program
    still fails at once (`test/db/locking.test.ts`).
  - Symlinked and relative paths come up fresh.
  - SG90 does not touch `immediate`. Migrations still take `BEGIN IMMEDIATE` under the 5 s busy handler.
- The medium (A29-01) is not a regression. SG90 restores the pre-SG65 behaviour there, and SG65 was worse. If
  `index.db` is deleted while `atlas serve` or `atlas mcp` has it open, and anything was written since that process
  opened, then:
  - every command fails with a bare `atlas: disk I/O error` until that process exits;
  - the running process keeps answering from the deleted index as if it were current.
- The low (A29-02): a failed `openDatabase` never closes its connection.
- A25-02, A25-03, A21-01, A21-02, A17-01, A17-04, A17-05 and A13-04..A13-06 are still open. Their `it.fails` still
  fail at `e55d031` when run as plain `it`.

PLAN rows: none (no critical or high).

## Re-verified (changes since AUDIT-25)

| Change | Attack | Result |
| --- | --- | --- |
| SG90 skip `createWalFile` beside a `-wal` (A25-01) | SIGKILL `atlas index` / `--force` at 0.4–2.0 s on express, flask, got (30 runs), `rm .atlas/index.db`, `atlas index`; in-test, a really SIGKILLed writer | 30/30 equal a fresh index on files, symbols, edges, embeddings, vectors and tombstones (express 141/778/1,274/637, flask 83/1,148/2,220/1,065, got 96/1,090/3,138/994), integrity `ok`. Before SG90 (AUDIT-25), got was malformed 6/6. The killed run's `index.db.lock-journal` is rolled back harmlessly. |
| SG90 `switchToWal` race | 4,520 racing writer opens and 1,240 reader opens beside stale WALs (incl. 2× CPU oversubscription); code reading of the stale WAL's only deleter (a connection on the 0-byte file, which already exists, so a later `createWalFile` link gets `EEXIST`) | 0 writer errors, 0 lost writes, all WAL, integrity `ok`. A stale WAL can never be replayed into a linked file: it is gone only once a 0-byte file exists. Readers that open in the creation window get `no such table: files` (Notes). |
| SG90 retry bound | a 0-byte file nobody is creating; a 0-byte file whose lock is held for 6.5 s; a non-database file | Opens in < 1 s. Fails after 4.9–6.4 s with `journal mode: database is locked (…)`. `SQLITE_NOTADB` is thrown at once, not retried (pinned). |
| SG90 read-only beside a stale WAL | a 0-byte index (killed before the switch) and a full-page stale WAL, opened read-only first | The reader drops the WAL itself and sees no tables. It never sees the deleted 300 rows, and the next writer gets a fresh index (pinned). With no index at all, read commands refuse (`no index at …`) and create nothing. |
| SG90 `-shm` only | `-shm` left alone; `-shm` beside a live holder (`rm index.db index.db-wal`) | Alone: `createWalFile` links the file and SQLite resets the shm (SG90 test). Beside a live holder: same as A29-01. |
| SG90 paths | symlinked `index.db` (absolute, relative) with the target deleted beside a stale WAL; `.atlas/` as a dir symlink; relative path; dangling link with no WAL | All fresh and healthy, and the link stays a link (pinned). Note: Atlas looks for `-wal` beside the link while SQLite uses the target's, so this holds only because `linkSync` onto a dangling link fails with `EEXIST`. |
| SG90 × SG80 | code reading | `switchToWal` runs at the connection's 5 s timeout and polls 10 ms itself. `immediate` is not on the open path, and its `busy_timeout` restore is unchanged (AUDIT-25 pins). |

## Critical

None found.

## High

None found.

## Medium

### A29-01 Deleting `index.db` while `atlas serve` or `atlas mcp` has it open: every command fails with `disk I/O error` until that process exits, and that process keeps serving the deleted index

- **Evidence:**
  - **Why the holder matters.** `atlas serve` (read-only) and `atlas mcp` (read-write) keep one connection open for
    their whole life. A connection on a deleted file keeps it alive, and its `-wal` and `-shm` stay at their paths.
  - **What the next open does.** The next `openDatabase` takes SG90's 0-byte path:
    1. SQLite deletes the holder's WAL by path.
    2. It writes page 1 of the new file.
    3. It maps the same `-shm`, which the holder keeps locked. The shm header still points at frames of the deleted
       WAL.
    4. The read fails with `SQLITE_IOERR_SHORT_READ`.
  - **express, built CLI.** I started `atlas serve`, edited `lib/application.js`, ran `atlas index` and then
    `rm .atlas/index.db`.
    - `atlas index`, `atlas drift` and `atlas search` each print `atlas: disk I/O error` and exit 1.
    - `/api/stats` keeps answering `{"files":141,"symbols":779,"edges":1274}` from the deleted index.
    - After `serve` stops, `atlas index` gives a fresh 141/779/1,274 index.
  - **Harness, 500 files with 50 written while the holder was open** (holder read-only or read-write, closed or
    SIGKILLed): `SQLITE_IOERR_SHORT_READ` on every open while the holder lives, in all 6 combinations.
    - The holder still reads 550 files.
    - A read-write holder (`atlas_index`) keeps writing to the deleted file. Those writes are lost when it exits.
    - Once it exits, the index comes up fresh (pinned).
  - **When nothing was written since the holder opened.** The reset gives a fresh index (pinned). The holder then
    fails every read with `database disk image is malformed` until it is restarted. Until the new index checkpoints,
    it can read the new index's pages through the shared shm.
  - **Not a regression.** Pre-SG65 (`c9758a0`) behaves exactly like SG90. SG65 (`cf6b638`) replayed the holder's
    WAL instead, and the new index stayed `database disk image is malformed` even after the holder exited.
  - **No remedy anywhere.** The message gives no cause, `nameBusy` only names `SQLITE_BUSY*`, and the README has no
    reset procedure. The usual next step (`rm` again) repeats the error, and only stopping the server or
    `rm -rf .atlas` works.
- **Tests:**
  - `A29-01 after rm index.db the next open gives a fresh index or names the process …` (serve and mcp variants)
    fails with `expected 'disk I/O error' to match /atlas (serve|mcp)|another process/`.
  - Plain `it` blocks pin the recovery after the holder exits and the empty-WAL case.
- **Repro:**
  1. `atlas index` on express.
  2. `atlas serve &`.
  3. Edit a file, then `atlas index`.
  4. `rm .atlas/index.db`.
  5. `atlas index` prints `atlas: disk I/O error` (exit 1). Every later command fails the same way until `serve`
     exits.
- **Fix:** any of the following.
  - **Make the holders follow the file.** `atlas serve` and `atlas mcp` compare `stat(dbPath).ino` with the inode
    they opened, before each request or on an `fs.watch` of `.atlas/`. When it differs they close and reopen, or
    exit with "the index was deleted; restart".
  - **Name the cause at open.** Map `SQLITE_IOERR_SHORT_READ`/`SQLITE_CORRUPT` there to "another Atlas process
    (`atlas serve`/`atlas mcp`) still has a deleted index open; stop it, or delete `.atlas/index.db*`".
  - **Document the reset.** Stop `serve`/`mcp`, then `rm .atlas/index.db*`.

## Low

### A29-02 A failed `openDatabase` never closes its connection

- **Evidence:**
  - **Where it leaks.** `openDatabase` creates the `Database` handle and then runs the journal-mode switch, the
    pragmas and the migrations. When any of them throws, the handle is not closed. That happens with A29-01's
    `disk I/O error`, a busy timeout, a non-database file, or `SQLITE_BUSY` on migrations.
  - **What it holds.** The handle keeps its file descriptor, its POSIX locks and its `-shm` mapping until garbage
    collection.
  - **Who is affected.** The CLI exits, so this is harmless there. It matters to callers of `openDatabase` from
    `@atlas/core` in a long-lived process that retries, and to test processes.
- **Test:** `A29-02 openDatabase closes the connection when the journal-mode switch or migrations throw` (Linux, by
  counting `/proc/self/fd`) fails with `expected 1 to be +0`.
- **Fix:** in `openDatabase`, `db.close()` in the `catch` before rethrowing (and around `loadVecExtension`).

## Notes (no test)

- **A reader in the creation window sees `no such table: files`.**
  - A read-only open in the few ms between file creation and the migrations' commit sees a WAL-mode file with no
    tables. In my races, 18 of 1,240 reader opens hit this.
  - `requireIndexed` does not map it to `index is empty`, so `atlas serve` started at that moment answers API calls
    with SQL errors.
  - This predates SG90: SG65's linked file has no tables either.
- **The `empty` guard reads the file after the error.** In theory, a racer whose `SQLITE_BUSY` came from another
  process's switch could stat the file after that process committed page 1, and fail instead of retrying. The other
  process is asleep in its busy handler (at least 1 ms) when the error returns, and 0 of 5,720 racing writer opens hit it,
  including under CPU load.
- **Symlinks hold by accident.** The `-wal` check is lexical (beside the link) while SQLite's WAL is beside the
  target. A future change that replaces `linkSync` with a rename, or that resolves the link before creating, would
  replay a stale WAL beside the target. `realpathSync` on the parent directory (or on the link) before both checks
  would make the check match SQLite's.
- **A kill can leave a tmp file.** As in AUDIT-25, a kill inside `createWalFile` leaves `index.db.<pid>.<ms>.tmp`.
- **A backup restored beside a stale WAL.** A user who copies a backup to `index.db` beside a killed run's `-wal`
  gets the foreign frames replayed (SQLite cannot tell the WAL belongs to another file). No Atlas path does this.
- **Still open.** A25-02, A25-03, A21-01 (2 tests), A21-02, A17-01, A17-04, A17-05, A13-04, A13-05 and A13-06 (plus
  the lows A13-07..A13-12). I ran the audit-13, audit-17, audit-21 and audit-25 files with `it.fails` → `it`: all 17
  of these tests still fail.
