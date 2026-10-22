// AUDIT-6: load on the bounded (SG15) surfaces of `atlas serve` and `atlas mcp`.
// Requires `npm run build` and a target with `atlas index` + `atlas docs --offline` run in it.
//   node scripts/audit2-load.mjs <target> [--port 4398] [--hub step0]
// Measures, per request: scoped graph queries (broad `file`, hub `symbol` at depth 1..3),
// single-doc lookups, drift paging, and a mixed concurrent burst where cheap searches
// queue behind expensive bounded requests. Reports server RSS and VmHWM. Prints JSON.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openDatabase, closeDatabase } from '../dist/core/db/index.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');
const args = process.argv.slice(2);
const target = resolve(args[0] ?? '.');
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const port = Number(opt('port', '4398'));
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
};
const mem = (pid) => {
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(st)?.[1] ?? 0);
    return { rss: Math.round(kb('VmRSS') / 1024), hwm: Math.round(kb('VmHWM') / 1024) };
  } catch {
    return null;
  }
};

// Pick a hub name (most common symbol name) and a file id from the index.
const db = openDatabase(join(target, '.atlas', 'index.db'), { readonly: true, fileMustExist: true });
const hub =
  opt('hub') ??
  db.prepare("SELECT name FROM symbols WHERE kind != 'module' GROUP BY name ORDER BY COUNT(*) DESC LIMIT 1").pluck().get();
const hubCount = db.prepare('SELECT COUNT(*) FROM symbols WHERE name = ?').pluck().get(hub);
const fileId = db.prepare('SELECT id FROM files ORDER BY id DESC LIMIT 1').pluck().get();
const filePath = db.prepare('SELECT path FROM files WHERE id = ?').pluck().get(fileId);
closeDatabase(db);
const out = { target, load: readFileSync('/proc/loadavg', 'utf8').trim(), hub, hubCount };
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
const timed = async (path, n = 3) => {
  const xs = [];
  let last;
  for (let i = 0; i < n; i++) {
    last = await get(path);
    xs.push(last.ms);
  }
  return { ms: r2(pct(xs, 50)), kb: r2(last.bytes / 1024), status: last.status };
};
try {
  const q = (i) => `/api/search?q=${encodeURIComponent(words[i % words.length])}&limit=10`;
  for (let i = 0; i < 5; i++) await get(q(i));
  out.http = {
    search: await timed(q(0), 10),
    graphDefault: await timed('/api/graph'),
    graphFileBroad: await timed('/api/graph?file=src'),
    graphFileBroadPage2: await timed('/api/graph?file=src&offset=1000'),
    graphFileNarrow: await timed('/api/graph?file=pkg1/'),
    graphHubDepth1: await timed(`/api/graph?symbol=${hub}&depth=1`),
    graphHubDepth3: await timed(`/api/graph?symbol=${hub}&depth=3`),
    docsList: await timed('/api/docs'),
    docArchitecture: await timed('/api/doc/architecture'),
    docFile: await timed(`/api/doc/file/${fileId}`),
    files: await timed('/api/files'),
  };
  // Mixed burst: 20 searches queued behind 4 broad graph queries and 4 doc fetches.
  const t0 = performance.now();
  const heavy = [
    ...Array.from({ length: 4 }, () => get('/api/graph?file=src')),
    ...Array.from({ length: 4 }, () => get(`/api/doc/file/${fileId}`)),
  ];
  const light = Array.from({ length: 20 }, (_, i) => get(q(i)));
  const lightRes = await Promise.all(light);
  await Promise.all(heavy);
  out.http.mixedBurst = {
    wallMs: r2(performance.now() - t0),
    searchP50: r2(pct(lightRes.map((r) => r.ms), 50)),
    searchP95: r2(pct(lightRes.map((r) => r.ms), 95)),
    errors: lightRes.filter((r) => r.status !== 200).length,
  };
  out.http.serveMem = mem(srv.pid);
} finally {
  srv.kill('SIGTERM');
}

// --- MCP ----------------------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--offline', '--cwd', target],
  stderr: 'inherit',
});
const client = new Client({ name: 'audit6', version: '0.0.0' });
await client.connect(transport);
const pid = transport.pid;
const call = async (name, a) => {
  const t = performance.now();
  const r = await client.callTool({ name, arguments: a }, undefined, { timeout: 600000 });
  return { ms: performance.now() - t, bytes: JSON.stringify(r).length, err: r.isError === true, r };
};
const one = async (name, a, n = 3) => {
  const xs = [];
  let last;
  for (let i = 0; i < n; i++) {
    last = await call(name, a);
    xs.push(last.ms);
  }
  return { ms: r2(pct(xs, 50)), kb: r2(last.bytes / 1024), error: last.err };
};
out.mcp = {
  search: await one('atlas_search', { query: 'invoice payment' }, 10),
  symbolHub: await one('atlas_symbol', { name: hub }),
  graphFileBroad: await one('atlas_graph', { file: 'src' }),
  graphHubDepth3: await one('atlas_graph', { symbol: hub, depth: 3 }),
  docsList: await one('atlas_docs', {}),
  docsTarget: await one('atlas_docs', { target: filePath }),
  driftPage0: await one('atlas_drift', { skipArchitecture: true }, 2),
  driftPageDeep: await one('atlas_drift', { skipArchitecture: true, offset: 5000, limit: 1000 }, 2),
};
{
  const d = await call('atlas_drift', { skipArchitecture: true, limit: 1000 });
  const rep = JSON.parse(d.r.content[0].text);
  const pages = Math.ceil(Math.max(rep.totals.stale, rep.totals.undocumented) / 1000);
  out.mcp.driftFullPagingEstimate = {
    totals: rep.totals,
    pagesAt1000: pages,
    estMs: r2(pages * out.mcp.driftPage0.ms),
  };
}
// Head-of-line: a search sent right after a drift call waits for it.
{
  const dr = call('atlas_drift', { skipArchitecture: true });
  await new Promise((r) => setTimeout(r, 5));
  const s = await call('atlas_search', { query: 'invoice' });
  const d = await dr;
  out.mcp.searchBehindDrift = { searchMs: r2(s.ms), driftMs: r2(d.ms) };
}
out.mcp.mem = pid ? mem(pid) : null;
await client.close().catch(() => {});
console.log(JSON.stringify(out, null, 2));
