// Load test for `atlas serve` and `atlas mcp` (AUDIT-2). Requires `npm run build`
// and an indexed target (`atlas index <target>`; MCP docs/drift need `atlas docs`).
//   node scripts/audit-load.mjs <target> [--port 4399] [--parallel 50]
// Prints one JSON object: HTTP latency under N parallel searches, payload sizes,
// and MCP per-tool latency over repeated calls plus the server's RSS.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');
const args = process.argv.slice(2);
const target = resolve(args[0] ?? '.');
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const port = Number(opt('port', '4399'));
const parallel = Number(opt('parallel', '50'));
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
};
const rssMb = (pid) => {
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(st)?.[1] ?? 0);
    return { rss: Math.round(kb('VmRSS') / 1024), hwm: Math.round(kb('VmHWM') / 1024) };
  } catch {
    return null;
  }
};
const out = {};
const words = ['invoice', 'customer address', 'event stream', 'worker queue', 'discount price'];

// --- HTTP ---------------------------------------------------------------
const srv = spawn(process.execPath, [cli, 'serve', '--cwd', target, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  srv.stdout.on('data', (d) => String(d).includes('serving') && res());
  srv.once('exit', (c) => rej(new Error(`serve exited ${c}`)));
});
const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  const t = performance.now();
  const r = await fetch(base + path);
  const body = await r.text();
  return { ms: performance.now() - t, status: r.status, bytes: body.length };
};
try {
  const q = (i) => `/api/search?q=${encodeURIComponent(words[i % words.length])}&limit=10`;
  for (let i = 0; i < 5; i++) await get(q(i));
  const serial = [];
  for (let i = 0; i < parallel; i++) serial.push((await get(q(i))).ms);
  const t0 = performance.now();
  const par = await Promise.all(Array.from({ length: parallel }, (_, i) => get(q(i))));
  const wall = performance.now() - t0;
  out.httpSearch = {
    serialP50: r2(pct(serial, 50)),
    serialP95: r2(pct(serial, 95)),
    parallel,
    parallelWallMs: r2(wall),
    parallelP50: r2(pct(par.map((p) => p.ms), 50)),
    parallelP95: r2(pct(par.map((p) => p.ms), 95)),
    errors: par.filter((p) => p.status !== 200).length,
  };
  const stats = [];
  for (let i = 0; i < 3; i++) stats.push((await get('/api/stats')).ms);
  out.httpStatsMs = r2(pct(stats, 50));
  const graphs = [];
  let gbytes = 0;
  for (let i = 0; i < 3; i++) {
    const g = await get('/api/graph');
    graphs.push(g.ms);
    gbytes = g.bytes;
  }
  out.httpGraph = { ms: r2(pct(graphs, 50)), mb: r2(gbytes / 2 ** 20) };
  // A search issued while /api/graph is in flight waits for it (single thread).
  const g = get('/api/graph');
  await new Promise((r) => setTimeout(r, 5));
  const blocked = await get(q(0));
  await g;
  out.httpSearchDuringGraphMs = r2(blocked.ms);
  out.httpFiles = await get('/api/files').then((r) => ({ ms: r2(r.ms), mb: r2(r.bytes / 2 ** 20) }));
  out.serveRss = rssMb(srv.pid);
} finally {
  srv.kill('SIGTERM');
}

// --- MCP ----------------------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--offline', '--cwd', target],
  stderr: 'inherit',
});
const client = new Client({ name: 'audit', version: '0.0.0' });
await client.connect(transport);
const pid = transport.pid;
const call = async (name, a) => {
  const t = performance.now();
  const r = await client.callTool({ name, arguments: a });
  return { ms: performance.now() - t, bytes: JSON.stringify(r).length, err: r.isError === true };
};
const tools = {
  atlas_search: (i) => ({ query: words[i % words.length] }),
  atlas_symbol: (i) => ({ name: `handleOrder${i * 24}x0` }),
  atlas_docs: () => ({ target: 'architecture' }),
  atlas_ask: (i) => ({ question: `how does ${words[i % words.length]} work` }),
};
const reps = { atlas_search: 100, atlas_symbol: 30, atlas_docs: 10, atlas_ask: 10 };
out.mcp = {};
for (const [name, mk] of Object.entries(tools)) {
  const ms = [];
  let errs = 0;
  for (let i = 0; i < reps[name]; i++) {
    const r = await call(name, mk(i));
    ms.push(r.ms);
    if (r.err) errs++;
  }
  out.mcp[name] = { n: ms.length, p50: r2(pct(ms, 50)), p95: r2(pct(ms, 95)), errors: errs };
  console.error(`[audit-load] ${name} done`);
}
out.mcpRss = pid ? rssMb(pid) : null;
// Last: on a large index the graph payload can kill the server (A2-05).
for (const [name, a] of [['atlas_drift', { skipArchitecture: true }], ['atlas_graph', {}]]) {
  try {
    const r = await call(name, a);
    out.mcp[name] = { ms: r2(r.ms), mb: r2(r.bytes / 2 ** 20), error: r.err };
  } catch (err) {
    out.mcp[name] = { failed: String(err.message ?? err), serverRssBefore: out.mcpRss };
  }
}
await client.close().catch(() => {});
console.log(JSON.stringify(out, null, 2));
