import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'node:timers/promises';

export const INDEX_LOCK_WAIT_MS = 10 * 60_000;
const POLL_MS = 100;

/**
 * Holds `<dbPath>.lock` with an exclusive SQLite (OS file) lock so one index run at a time,
 * across processes, writes `dbPath`; the OS drops it if the process dies. Polls without
 * blocking the event loop and throws, before anything is written, after `waitMs`.
 */
export async function acquireIndexLock(
  dbPath: string,
  waitMs = INDEX_LOCK_WAIT_MS,
): Promise<() => void> {
  const lock = new Database(`${dbPath}.lock`, { timeout: 0 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      lock.exec('BEGIN EXCLUSIVE');
      return () => lock.close();
    } catch (err) {
      const busy = (err as { code?: string }).code === 'SQLITE_BUSY';
      if (busy && Date.now() < deadline) {
        await sleep(POLL_MS);
        continue;
      }
      lock.close();
      if (!busy) throw err;
      throw new Error(
        `another atlas index run is writing ${dbPath}; gave up after ${Math.round(waitMs / 1000)}s`,
      );
    }
  }
}
