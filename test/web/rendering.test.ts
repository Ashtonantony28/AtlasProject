// In-browser rendering smoke test. Loads index.html and app.js into JSDOM,
// stubs fetch() with the same JSON shapes the live API returns, and verifies
// the dashboard renders the file list, graph, doc browser, and search.
// This is the "in-browser" half of the Phase 8 DoD.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC = join(__dirname, '..', '..', 'src', 'web', 'static');

interface FixtureFile {
  id: number;
  path: string;
  language: string;
  content_hash: string;
  loc: number;
  indexed_at: string;
}

const FIXTURE_FILES: FixtureFile[] = [
  { id: 1, path: 'src/math.ts', language: 'typescript', content_hash: 'h1', loc: 12, indexed_at: 'now' },
  { id: 2, path: 'src/shapes.ts', language: 'typescript', content_hash: 'h2', loc: 30, indexed_at: 'now' },
];

const FIXTURE_GRAPH = {
  nodes: [
    { id: 100, name: 'add', kind: 'function', file: 'src/math.ts', qualifiedName: 'add', startLine: 4, endLine: 6 },
    { id: 101, name: 'Circle', kind: 'class', file: 'src/shapes.ts', qualifiedName: 'Circle', startLine: 17, endLine: 25 },
    { id: 102, name: 'Square', kind: 'class', file: 'src/shapes.ts', qualifiedName: 'Square', startLine: 27, endLine: 33 },
    { id: 999, name: 'src/math.ts', kind: 'module', file: 'src/math.ts', qualifiedName: null, startLine: 1, endLine: 1 },
  ],
  edges: [
    { src: 101, dst: 100, kind: 'calls', weak: false },
    { src: 102, dst: 100, kind: 'calls', weak: false },
  ],
};

const FIXTURE_STATS = { files: 2, symbols: 4, edges: 2, docs: 3 };

const FIXTURE_ARCH_DOC = {
  id: 5,
  target_kind: 'architecture',
  target_id: 0,
  content: '# Architecture\n\nA tiny fixture covering math and shapes.',
  source_hash: 'arch',
  generated_at: 'now',
};

const FIXTURE_SHAPES_DOC = {
  id: 2,
  target_kind: 'file',
  target_id: 2,
  content: '# src/shapes.ts\n\nDefines `Circle` and `Square` that call `add`.',
  source_hash: 'shapes',
  generated_at: 'now',
};

const FIXTURE_SEARCH_HITS = [
  { id: 101, name: 'Circle', kind: 'class', file: 'src/shapes.ts', line: 17, score: 0.84 },
  { id: 102, name: 'Square', kind: 'class', file: 'src/shapes.ts', line: 27, score: 0.42 },
];

function makeFetch() {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.startsWith('/') ? url : new URL(url).pathname + new URL(url).search;
    let body: unknown = null;
    let status = 200;
    if (path === '/api/stats') body = FIXTURE_STATS;
    else if (path === '/api/files') body = FIXTURE_FILES;
    else if (path === '/api/graph') body = FIXTURE_GRAPH;
    else if (path === '/api/doc/architecture') body = FIXTURE_ARCH_DOC;
    else if (path === '/api/doc/file/2') body = FIXTURE_SHAPES_DOC;
    else if (path === '/api/doc/file/1') {
      status = 404;
      body = { error: 'not found' };
    } else if (path.startsWith('/api/search')) body = FIXTURE_SEARCH_HITS;
    else {
      status = 404;
      body = { error: `unhandled ${path}` };
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** Wait for a condition by polling — JSDOM has no animation frame. */
async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('dashboard renders in-browser (JSDOM)', () => {
  let dom: JSDOM;
  beforeEach(() => {
    const html = readFileSync(join(STATIC, 'index.html'), 'utf8');
    dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    (dom.window as unknown as { fetch: ReturnType<typeof makeFetch> }).fetch = makeFetch();
  });
  afterEach(() => {
    dom.window.close();
  });

  async function runApp(): Promise<void> {
    const js = readFileSync(join(STATIC, 'app.js'), 'utf8');
    // app.js is loaded as a module by the page; for the JSDOM smoke test we
    // strip the top-level `init().catch(...)` and call init() ourselves so
    // we can await it before asserting. We also remove `export` keywords
    // since we're injecting the source as a script.
    const stripped = js.replace(/init\(\)\.catch\([\s\S]*\);?\s*$/, '');
    dom.window.eval(stripped);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (dom.window as any).init();
  }

  it('populates the stats, file list, graph, and architecture doc on load', async () => {
    await runApp();
    const doc = dom.window.document;

    // Stats line.
    expect(doc.querySelector('#stats')!.textContent).toMatch(
      /2 files.*4 symbols.*2 edges.*3 docs/,
    );

    // File list — both fixture files appear.
    const items = [...doc.querySelectorAll('#fileList li')];
    expect(items.length).toBe(2);
    expect(items.map((li) => (li as HTMLElement).dataset['path'])).toEqual([
      'src/math.ts',
      'src/shapes.ts',
    ]);

    // Architecture doc loaded by default.
    expect(doc.querySelector('#docTitle')!.textContent).toBe('architecture');
    expect(doc.querySelector('#docBody')!.textContent).toMatch(/Architecture/);

    // Graph rendered — nodes (skipping the 'module' pseudo-symbol) + edges.
    const svgNodes = doc.querySelectorAll('#graph g.node');
    expect(svgNodes.length).toBe(3); // 4 nodes minus 1 module
    const svgEdges = doc.querySelectorAll('#graph line.edge');
    expect(svgEdges.length).toBe(2);
    // Edge classes carry the kind, so CSS coloring works.
    expect((svgEdges[0] as Element).getAttribute('class')).toMatch(/calls/);

    // Node labels include the qualified symbol name.
    const labels = [...doc.querySelectorAll('#graph g.node text')].map((t) => t.textContent);
    expect(labels).toContain('Circle');
    expect(labels).toContain('Square');
    expect(labels).toContain('add');
  });

  it("clicking a file in the sidebar shows that file's doc", async () => {
    await runApp();
    const doc = dom.window.document;
    const items = [...doc.querySelectorAll('#fileList li')] as HTMLElement[];
    const shapesItem = items.find((li) => li.dataset['path'] === 'src/shapes.ts')!;
    shapesItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    // Wait for the body to actually update (title flips before fetch, body
    // flips after).
    await waitFor(() =>
      (doc.querySelector('#docBody')!.textContent ?? '').includes('Circle'),
    );
    expect(doc.querySelector('#docTitle')!.textContent).toBe('src/shapes.ts');
    const body = doc.querySelector('#docBody')!.textContent ?? '';
    expect(body).toContain('Circle');
    expect(body).toContain('Square');
  });

  it('submitting a search query renders results in the Search tab', async () => {
    await runApp();
    const doc = dom.window.document;
    (doc.querySelector('#q') as HTMLInputElement).value = 'circle area';
    const form = doc.querySelector('#searchForm') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => doc.querySelectorAll('#results li').length > 0);
    const items = [...doc.querySelectorAll('#results li')].map((li) => li.textContent ?? '');
    expect(items.length).toBe(2);
    expect(items[0]).toMatch(/Circle/);
    expect(items[0]).toMatch(/src\/shapes\.ts:17/);
    // Top result has the highest score.
    expect(items[0]).toMatch(/0\.840/);

    // Search tab is now active.
    const searchTab = doc.querySelector('#tab-results') as HTMLElement;
    expect(searchTab.hasAttribute('hidden')).toBe(false);
  });
});
