// AUDIT-6: RSS of a long-lived `atlas mcp` server across repeated `atlas_index` calls.
// Requires `npm run build`.
//   node scripts/audit2-mcp-index.mjs <work> [files=1000] [calls=6]
// Generates a realistic repo, starts `atlas mcp` on it, then calls `atlas_index`
// with force:true `calls` times (each re-parses every file, as after a branch switch),
// reading the server's VmRSS after each call. Prints JSON with the RSS series.
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeAuditRepo } from './audit-repo.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');
const [work, filesArg, callsArg] = process.argv.slice(2);
if (!work) {
  console.error('usage: node scripts/audit2-mcp-index.mjs <work> [files] [calls]');
  process.exit(2);
}
const files = Number(filesArg ?? 1000);
const calls = Number(callsArg ?? 6);
const repo = join(work, `mcpidx${files}`);
rmSync(repo, { recursive: true, force: true });
writeAuditRepo(repo, files);
const rss = (pid) =>
  Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--offline', '--cwd', repo],
  stderr: 'inherit',
});
const client = new Client({ name: 'audit6-idx', version: '0.0.0' });
await client.connect(transport);
const pid = transport.pid;
const out = { files, calls: [] };
for (let i = 0; i < calls; i++) {
  const t = performance.now();
  const r = await client.callTool(
    { name: 'atlas_index', arguments: { force: i > 0 } },
    undefined,
    { timeout: 1800000 },
  );
  out.calls.push({ force: i > 0, ms: Math.round(performance.now() - t), rssMb: rss(pid), error: r.isError === true });
  console.error(`[audit2-mcp-index] call ${i} rss ${out.calls.at(-1).rssMb} MB`);
}
const xs = out.calls.slice(1).map((c) => c.rssMb);
out.rssMbPerForcedCall = xs.length > 1 ? Math.round((xs.at(-1) - xs[0]) / (xs.length - 1)) : null;
await client.close().catch(() => {});
console.log(JSON.stringify(out, null, 2));
