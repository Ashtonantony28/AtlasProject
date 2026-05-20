// Atlas dashboard — vanilla JS, no build step.

const $ = (sel) => document.querySelector(sel);

async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return r.json();
}

async function init() {
  // Stats + files.
  const [stats, files, graph] = await Promise.all([
    fetchJSON('/api/stats'),
    fetchJSON('/api/files'),
    fetchJSON('/api/graph'),
  ]);
  renderStats(stats);
  renderFileList(files);
  renderGraph(graph);

  // Try to load architecture doc by default.
  try {
    const arch = await fetchJSON('/api/doc/architecture');
    $('#docTitle').textContent = 'architecture';
    $('#docBody').textContent = arch.content;
  } catch {
    $('#docBody').textContent = 'No architecture doc yet. Run `atlas docs` to generate.';
  }

  setupTabs();
  setupSearch();
}

function renderStats(stats) {
  $('#stats').textContent = `${stats.files} files · ${stats.symbols} symbols · ${stats.edges} edges · ${stats.docs} docs`;
}

function renderFileList(files) {
  const ul = $('#fileList');
  ul.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.dataset.fileId = f.id;
    li.dataset.path = f.path;
    li.innerHTML = `${escapeHtml(f.path)} <span class="lang">${f.language}</span>`;
    li.addEventListener('click', () => selectFile(li, f));
    ul.appendChild(li);
  }
}

async function selectFile(liEl, file) {
  for (const li of document.querySelectorAll('#fileList li')) li.classList.remove('active');
  liEl.classList.add('active');
  showTab('doc');
  $('#docTitle').textContent = file.path;
  try {
    const doc = await fetchJSON(`/api/doc/file/${file.id}`);
    $('#docBody').textContent = doc.content;
  } catch {
    $('#docBody').textContent = `No doc for ${file.path}. Run \`atlas docs\`.`;
  }
}

function setupTabs() {
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }
}

function showTab(name) {
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const tab of document.querySelectorAll('.tab')) {
    const id = tab.id.replace('tab-', '');
    if (id === name) {
      tab.removeAttribute('hidden');
      tab.classList.add('active');
    } else {
      tab.setAttribute('hidden', '');
      tab.classList.remove('active');
    }
  }
}

function setupSearch() {
  const form = $('#searchForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    const kind = $('#kind').value;
    if (!q) return;
    const params = new URLSearchParams({ q });
    if (kind) params.set('kind', kind);
    const hits = await fetchJSON(`/api/search?${params.toString()}`);
    renderResults(hits);
    showTab('results');
  });
}

function renderResults(hits) {
  const ol = $('#results');
  ol.innerHTML = '';
  if (hits.length === 0) {
    ol.innerHTML = '<li>no matches</li>';
    return;
  }
  for (const h of hits) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="score">${h.score.toFixed(3)}</span>
      <span class="kind">[${h.kind}]</span>
      <span class="name">${escapeHtml(h.name)}</span>
      <div class="meta">${escapeHtml(h.file)}:${h.line}</div>`;
    ol.appendChild(li);
  }
}

function renderGraph(graph) {
  const svg = $('#graph');
  svg.innerHTML = '';
  const width = 1200;
  const height = 600;
  // Skip the per-file "module" pseudo-symbols in the visible graph to avoid clutter.
  const visibleNodes = graph.nodes.filter((n) => n.kind !== 'module');
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = graph.edges.filter((e) => visibleIds.has(e.src) && visibleIds.has(e.dst));

  // Group nodes by file; lay each file group in a column.
  const byFile = new Map();
  for (const n of visibleNodes) {
    if (!byFile.has(n.file)) byFile.set(n.file, []);
    byFile.get(n.file).push(n);
  }
  const files = [...byFile.keys()].sort();
  const colW = files.length > 0 ? width / files.length : width;
  const positions = new Map();
  files.forEach((f, ci) => {
    const xs = colW * ci + colW / 2;
    const items = byFile.get(f);
    items.forEach((n, ri) => {
      const ys = 60 + ri * Math.max(30, (height - 100) / Math.max(items.length, 1));
      positions.set(n.id, { x: xs, y: ys });
    });
  });

  // Edges first (so nodes draw on top).
  for (const e of visibleEdges) {
    const s = positions.get(e.src);
    const d = positions.get(e.dst);
    if (!s || !d) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', s.x);
    line.setAttribute('y1', s.y);
    line.setAttribute('x2', d.x);
    line.setAttribute('y2', d.y);
    line.setAttribute('class', `edge ${e.kind}${e.weak ? ' weak' : ''}`);
    svg.appendChild(line);
  }
  for (const n of visibleNodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `node ${n.kind}`);
    g.setAttribute('transform', `translate(${p.x},${p.y})`);
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '6');
    g.appendChild(c);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', '10');
    t.setAttribute('y', '4');
    t.textContent = n.qualifiedName ?? n.name;
    g.appendChild(t);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${n.kind}: ${n.qualifiedName ?? n.name}\n${n.file}:${n.startLine}`;
    g.appendChild(title);
    svg.appendChild(g);
  }
  // File column labels at top.
  files.forEach((f, ci) => {
    const xs = colW * ci + colW / 2;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', xs);
    t.setAttribute('y', 20);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-weight', '600');
    t.setAttribute('fill', '#8b949e');
    t.textContent = f;
    svg.appendChild(t);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init().catch((err) => {
  document.body.innerHTML =
    `<pre style="padding:1rem;color:#f85149">Failed to load Atlas dashboard:\n${err.message}</pre>`;
});
