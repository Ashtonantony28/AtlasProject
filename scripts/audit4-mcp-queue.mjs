// AUDIT-14: SG29's per-DB index queue under many parallel MCP `atlas_index` calls.
// Requires `npm run build`.
//   node scripts/audit4-mcp-queue.mjs <work> [files=3000] [parallel=20] [forced=4]
// Generates a realistic repo, starts `atlas mcp --offline` on it and indexes it once. Then:
//   noop:   `parallel` concurrent no-op atlas_index calls, with an atlas_search sent every
//           100 ms while they run (does a search starve behind the queue?);
//   forced: `forced` concurrent force:true calls, the same search probe.
// Reports per-call latency (first / median / last), wall time, the search probe latencies,
// server RSS before/after and VmHWM, and the symbol count after each phase (a second
// insert of the same file would raise it). Prints one JSON object.
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeAuditRepo } from './audit-repo.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');
const [work, filesArg, parArg, forcedArg] = process.argv.slice(2);
if (!work) {
  console.error('usage: node scripts/audit4-mcp-queue.mjs <work> [files] [parallel] [forced]');
  process.exit(2);
}
const files = Number(filesArg ?? 3000);
const parallel = Number(parArg ?? 20);
const forced = Number(forcedArg ?? 4);
const repo = join(work, `mcpq${files}`);
rmSync(repo, { recursive: true, force: true });
writeAuditRepo(repo, files);

const status = (pid, key) =>
  Math.round(Number(new RegExp(`${key}:\\s+(\\d+)`).exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024);
const symbols = () => {
  const db = new Database(join(repo, '.atlas', 'index.db'), { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;
  } finally {
    db.close();
  }
};
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const r0 = (n) => Math.round(n);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--offline', '--cwd', repo],
  stderr: 'inherit',
});
const client = new Client({ name: 'audit14-queue', version: '0.0.0' });
await client.connect(transport);
const pid = transport.pid;
const call = (name, args) =>
  client.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 });

const out = { files, parallel, forced, load: readFileSync('/proc/loadavg', 'utf8').split(' ')[0] };
let t = performance.now();
await call('atlas_index', {});
out.firstIndexMs = r0(performance.now() - t);
out.symbolsAfterFirst = symbols();
t = performance.now();
await call('atlas_index', {});
out.serialNoopMs = r0(performance.now() - t);
t = performance.now();
await call('atlas_search', { query: 'invoice total', limit: 10 });
out.idleSearchMs = r0(performance.now() - t);

async function phase(n, force) {
  const rssBefore = status(pid, 'VmRSS');
  const t0 = performance.now();
  const lat = [];
  const errors = [];
  const runs = Array.from({ length: n }, () =>
    call('atlas_index', { force }).then((r) => {
      lat.push(performance.now() - t0);
      if (r.isError) errors.push(r.content?.[0]?.text);
    }),
  );
  const probes = [];
  let done = false;
  const all = Promise.all(runs).then(() => (done = true));
  const probe = (async () => {
    while (!done) {
      const ts = performance.now();
      await call('atlas_search', { query: 'ledger payment', limit: 10 });
      probes.push({ sentAt: r0(ts - t0), ms: r0(performance.now() - ts) });
      await new Promise((res) => setTimeout(res, 100));
    }
  })();
  await all;
  await probe;
  const wall = performance.now() - t0;
  lat.sort((a, b) => a - b);
  return {
    calls: n,
    force,
    wallMs: r0(wall),
    firstMs: r0(lat[0]),
    medianMs: r0(med(lat)),
    lastMs: r0(lat.at(-1)),
    perCallMs: r0(wall / n),
    errors,
    searchProbes: probes.length,
    searchMaxMs: probes.length ? Math.max(...probes.map((p) => p.ms)) : null,
    searchMedianMs: probes.length ? med(probes.map((p) => p.ms)) : null,
    rssBeforeMb: rssBefore,
    rssAfterMb: status(pid, 'VmRSS'),
    hwmMb: status(pid, 'VmHWM'),
    symbols: symbols(),
  };
}

out.noop = await phase(parallel, false);
console.error(`[audit4-mcp-queue] noop ${JSON.stringify(out.noop)}`);
out.forcedPhase = await phase(forced, true);
console.error(`[audit4-mcp-queue] forced ${JSON.stringify(out.forcedPhase)}`);
out.duplicateFree =
  out.noop.symbols === out.symbolsAfterFirst && out.forcedPhase.symbols === out.symbolsAfterFirst;
await client.close().catch(() => {});
console.log(JSON.stringify(out, null, 2));
