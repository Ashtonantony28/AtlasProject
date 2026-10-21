// Minimal HTTP server backing the dashboard. Reads from the index DB,
// exposes a small JSON API + static assets. No external HTTP framework.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  type DB,
  getAllDocs,
  getAllEdges,
  getAllFiles,
  getAllSymbols,
  getDoc,
} from '../core/db/index.js';
import { createEmbedder, search } from '../core/vector/index.js';
import { loadConfig } from '../core/config.js';
import type { SymbolKind } from '../core/db/index.js';
import { buildGraphJson } from '../core/graph/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Static asset root — resolved relative to this file, so it works from src/
// (tsx) and dist/ (built).
function findStaticRoot(): string {
  // Built path: dist/web/static
  const builtCandidate = resolve(__dirname, 'static');
  if (existsSync(builtCandidate)) return builtCandidate;
  // Source path: src/web/static
  const srcCandidate = resolve(__dirname, '..', '..', 'src', 'web', 'static');
  if (existsSync(srcCandidate)) return srcCandidate;
  // Fallback: relative to package root.
  return resolve(__dirname, '..', '..', 'src', 'web', 'static');
}

export interface ServeOptions {
  port?: number;
  host?: string;
}

export interface ServeHandle {
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function startServer(db: DB, root: string, opts: ServeOptions = {}): Promise<ServeHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4321;
  const staticRoot = findStaticRoot();
  const embedder = createEmbedder(loadConfig(root));

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const path = url.pathname;

      // API
      if (path === '/api/health') {
        jsonResponse(res, 200, { ok: true, root });
        return;
      }
      if (path === '/api/stats') {
        const files = getAllFiles(db).length;
        const symbols = getAllSymbols(db).length;
        const edges = getAllEdges(db).length;
        const docs = getAllDocs(db).length;
        jsonResponse(res, 200, { files, symbols, edges, docs });
        return;
      }
      if (path === '/api/graph') {
        jsonResponse(res, 200, buildGraphJson(db));
        return;
      }
      if (path === '/api/files') {
        jsonResponse(res, 200, getAllFiles(db));
        return;
      }
      if (path === '/api/docs') {
        jsonResponse(res, 200, getAllDocs(db));
        return;
      }
      if (path.startsWith('/api/doc/file/')) {
        const idStr = path.slice('/api/doc/file/'.length);
        const id = Number.parseInt(idStr, 10);
        if (!Number.isFinite(id)) {
          jsonResponse(res, 400, { error: 'bad id' });
          return;
        }
        const doc = getDoc(db, 'file', id);
        if (!doc) {
          jsonResponse(res, 404, { error: 'not found' });
          return;
        }
        jsonResponse(res, 200, doc);
        return;
      }
      if (path === '/api/doc/architecture') {
        const doc = getDoc(db, 'architecture', 0);
        if (!doc) {
          jsonResponse(res, 404, { error: 'not found' });
          return;
        }
        jsonResponse(res, 200, doc);
        return;
      }
      if (path === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
        const kindParam = url.searchParams.get('kind');
        const fileParam = url.searchParams.get('file');
        if (!q.trim()) {
          jsonResponse(res, 200, []);
          return;
        }
        const hits = await search(db, embedder, q, {
          limit,
          ...(kindParam ? { kind: kindParam.split(',') as SymbolKind[] } : {}),
          ...(fileParam ? { file: fileParam } : {}),
        });
        jsonResponse(
          res,
          200,
          hits.map((h) => ({
            id: h.symbol.id,
            name: h.symbol.qualified_name ?? h.symbol.name,
            kind: h.symbol.kind,
            file: h.filePath,
            line: h.symbol.start_line,
            score: h.totalScore,
          })),
        );
        return;
      }

      // Static assets (and SPA fallback to index.html)
      let relPath = path === '/' ? '/index.html' : path;
      // Don't allow escaping the static root.
      relPath = normalize(relPath).replace(/^[\\/]+/, '');
      const filePath = join(staticRoot, relPath);
      if (!filePath.startsWith(staticRoot)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        const body = readFileSync(filePath);
        res.writeHead(200, { 'content-type': mime });
        res.end(body);
        return;
      }
      // SPA fallback
      const indexFile = join(staticRoot, 'index.html');
      if (existsSync(indexFile)) {
        const body = readFileSync(indexFile);
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: msg });
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, res);
  });

  return {
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise<void>((res, rej) => {
        server.close((err) => (err ? rej(err) : res()));
      }),
  };
}
