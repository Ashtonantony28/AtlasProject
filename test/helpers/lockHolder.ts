// Another connection holding an index's write lock, in a worker thread so that it can take the lock
// from a synchronous callback (an index run's `onFile`) and release it while this thread is blocked
// in SQLite's busy wait.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.path);
const state = new Int32Array(workerData.state);
const set = (v) => (Atomics.store(state, 0, v), Atomics.notify(state, 0));
parentPort.on('message', (ms) => {
  db.exec('BEGIN IMMEDIATE');
  set(1);
  setTimeout(() => (db.exec('COMMIT'), set(2)), ms);
});
parentPort.postMessage('ready');
`;

const FREE = 0;
const HELD = 1;

export interface LockHolder {
  /** Takes the write lock for `ms`; returns once it is held. Blocks this thread until then. */
  hold(ms: number): void;
  /** Resolves once the last hold has been released. */
  released(): Promise<void>;
  close(): Promise<void>;
}

export async function lockHolder(dbPath: string): Promise<LockHolder> {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { driver: require.resolve('better-sqlite3'), path: dbPath, state: state.buffer },
  });
  await new Promise<void>((ok, fail) => {
    worker.once('message', () => ok());
    worker.once('error', fail);
  });
  const released = async (): Promise<void> => {
    while (Atomics.load(state, 0) === HELD) await new Promise((r) => setTimeout(r, 10));
  };
  return {
    hold(ms) {
      Atomics.store(state, 0, FREE);
      worker.postMessage(ms);
      if (Atomics.wait(state, 0, FREE, 5_000) === 'timed-out') throw new Error('lock not taken');
    },
    released,
    async close() {
      await released();
      await worker.terminate();
    },
  };
}
