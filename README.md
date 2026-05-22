# Atlas

> Local-first codebase intelligence engine. Point it at any repository and get
> a symbol + dependency graph, hybrid (semantic + structural) search, and
> doc-drift detection — with a CLI, a local dashboard, and an **MCP server** so
> Claude Code can synthesize docs and answer questions grounded in the index.

## Status

| Phase | Title                  | Status |
| ----- | ---------------------- | ------ |
| 1     | Foundation             | done   |
| 2     | Ingestion & parsing    | done   |
| 3     | Graph                  | done   |
| 4     | Embeddings & search    | done   |
| 5     | Synthesis (via MCP)    | done   |
| 6     | Q&A (via MCP)          | done   |
| 7     | Drift                  | done   |
| 8     | Dashboard              | done   |
| 9     | CI                     | done   |
| 10    | Polish                 | done   |

## Quickstart

```bash
# clone + install
npm install
npm run build

# initialize Atlas in a target repo (or use the bundled fixture)
node ./dist/cli/index.js init --cwd ./fixtures/sample

# index it: walks, parses, builds the graph, embeds symbols
node ./dist/cli/index.js index ./fixtures/sample

# semantic + structural search
node ./dist/cli/index.js search "circle area" --cwd ./fixtures/sample
node ./dist/cli/index.js search "shape" --kind class --cwd ./fixtures/sample

# export the graph
node ./dist/cli/index.js graph --format dot --cwd ./fixtures/sample > graph.dot
node ./dist/cli/index.js graph --format json --cwd ./fixtures/sample | jq '.nodes | length'

# drift report (exits non-zero if any doc is stale or any public symbol is undocumented)
node ./dist/cli/index.js drift --cwd ./fixtures/sample

# open the dashboard (graph + doc browser + search)
node ./dist/cli/index.js serve --cwd ./fixtures/sample
# then open http://127.0.0.1:4321/
```

## MCP Server (Claude Code integration)

Atlas ships an MCP server so Claude Code can query the index directly.
The `.claude/settings.json` in this repo auto-connects when you open it in
Claude Code (after building):

```bash
npm run build
# Claude Code auto-connects to the atlas MCP server via .claude/settings.json
```

Or start it manually for any target repository:

```bash
node ./dist/cli/index.js mcp --cwd /path/to/repo
```

### Available tools

| Tool | What it does |
|------|-------------|
| `atlas_index` | Walk & parse the repo; build graph + embeddings. |
| `atlas_search` | Hybrid semantic + structural symbol search. |
| `atlas_symbol` | Look up a symbol by name with source excerpt. |
| `atlas_graph` | Export the dependency graph (JSON or DOT). |
| `atlas_drift` | Detect stale docs and undocumented public symbols. |

Once connected, ask Claude Code to:
- *"Index this repository"* → calls `atlas_index`
- *"Find where Circle.area is defined"* → calls `atlas_symbol`
- *"Search for shape-related classes"* → calls `atlas_search`
- *"Generate module docs for src/shapes.ts"* → uses `atlas_symbol` + `atlas_graph` to ground its output
- *"What's drifted since last doc run?"* → calls `atlas_drift`

## What's in here

| Path | Purpose |
| --- | --- |
| `src/cli/`        | `commander` commands; thin — all logic in `core/` or `mcp/` |
| `src/mcp/`        | MCP server (StdioServerTransport + 5 tools) |
| `src/core/db/`    | SQLite schema + migrations + typed query helpers |
| `src/core/ingest/`| repo walker, language detect, content hashing, indexer |
| `src/core/parse/` | tree-sitter symbol extractors (TS/JS/Python) |
| `src/core/graph/` | reference resolution + JSON/DOT export + arch context |
| `src/core/vector/`| local-hash embeddings + hybrid search |
| `src/core/qa/`    | retrieval (grounded snippets for graph expansion) |
| `src/core/drift/` | stale-doc + undocumented detection |
| `src/web/`        | dashboard HTTP server + static UI |
| `fixtures/sample/`| tiny multi-language repo used by tests |
| `.claude/settings.json` | MCP auto-connect config for Claude Code |
| `.github/workflows/atlas.yml` | PR action that runs index + drift + posts a comment |

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Costs and safety

- **No direct LLM calls in Atlas core.** All synthesis and Q&A happen in the
  MCP client (Claude Code). Atlas is purely a data and retrieval layer.
- **Read-only on inputs:** Atlas never modifies the target repository; it only
  writes to its own index under `.atlas/`.
- **Offline by default:** search, graph, and drift work without any API key.

See `DECISIONS.md` for non-obvious choices and `CLAUDE.md` for the operating
manual that drove the build.
