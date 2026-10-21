# Atlas

> Local-first codebase intelligence engine. Point it at any Git repository and
> get a symbol + dependency graph, self-maintaining docs, hybrid (semantic +
> structural) search, grounded Q&A, and doc-drift detection — with a CLI and a
> local dashboard.

Atlas runs **offline by default**. The local-hash embeddings, SQLite-vec
KNN store, and a deterministic mock LLM mean you can index, search, document,
and run drift over a repo without any API keys. Drop in `ANTHROPIC_API_KEY` to
swap in real Claude-backed synthesis and Q&A.

## Status

| Phase | Title                  | Status |
| ----- | ---------------------- | ------ |
| 1     | Foundation             | done   |
| 2     | Ingestion & parsing    | done   |
| 3     | Graph                  | done   |
| 4     | Embeddings & search    | done   |
| 5     | Synthesis              | done   |
| 6     | Q&A                    | done   |
| 7     | Drift                  | done   |
| 8     | Dashboard              | done   |
| 9     | CI                     | done   |
| 10    | Polish                 | done   |

Languages: TypeScript, JavaScript (ESM + CommonJS `require()`), and Python.

## Quickstart — fresh clone, end to end

You'll have a fully indexed repo with semantic search, docs, and Q&A in about
a minute. No API key required.

```bash
# 1. Clone Atlas and build the CLI.
git clone https://github.com/ashtonantony28/atlasproject atlas && cd atlas
npm install
npm run build

# 2. Point it at *any* repo on disk. We use the bundled fixture here; swap
#    in any other path you like (your own project, a clone of express, etc.).
TARGET=./fixtures/sample
node ./dist/cli/index.js init  --cwd "$TARGET"
node ./dist/cli/index.js index "$TARGET"

# 3. Hybrid (semantic + structural) search.
node ./dist/cli/index.js search "circle area"            --cwd "$TARGET" --limit 5
node ./dist/cli/index.js search "shape" --kind class     --cwd "$TARGET"

# 4. Export the dependency graph.
node ./dist/cli/index.js graph --format dot  --cwd "$TARGET" > graph.dot
node ./dist/cli/index.js graph --format json --cwd "$TARGET" | jq '.nodes | length'

# 5. Generate module + architecture docs (offline mock — no spend).
node ./dist/cli/index.js docs --offline                  --cwd "$TARGET"
node ./dist/cli/index.js docs --show src/shapes.ts       --cwd "$TARGET"
node ./dist/cli/index.js docs --show architecture        --cwd "$TARGET"

# 6. Ask a grounded question, with citations.
node ./dist/cli/index.js ask --offline --cwd "$TARGET" "How is the area of a circle computed?"

# 7. Drift report. Exits 2 if any doc is stale or any public symbol undocumented.
node ./dist/cli/index.js drift --cwd "$TARGET"

# 8. Open the dashboard (graph + doc browser + search).
node ./dist/cli/index.js serve --cwd "$TARGET"
# then visit http://127.0.0.1:4321/
```

The `scripts/demo.sh` script runs steps 2-7 end-to-end against the fixture in
one go.

## Using it on your own project

Once Atlas is built, run it against any repo. The first run does the full
walk → parse → graph → embed pass; subsequent runs are incremental and finish
in ~50ms when nothing has changed.

```bash
# Anywhere outside the Atlas repo:
ATLAS=/path/to/atlas/dist/cli/index.js
node "$ATLAS" init  --cwd ~/projects/my-app
node "$ATLAS" index ~/projects/my-app
node "$ATLAS" search "auth token refresh" --cwd ~/projects/my-app
node "$ATLAS" docs   --offline             --cwd ~/projects/my-app
node "$ATLAS" serve                        --cwd ~/projects/my-app
```

### With `npx` / once published

```bash
# As a one-shot, no global install:
npx atlas index ~/projects/my-app
npx atlas search "auth token refresh" --cwd ~/projects/my-app
```

(Until Atlas is published to npm, build locally and use `node ./dist/cli/index.js`
or `npm link` it into your `PATH`.)

### Real Claude-backed synthesis and Q&A

The `--offline` flag is for the deterministic mock. To use the real Anthropic
API, export your key and drop `--offline`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
node ./dist/cli/index.js docs --cwd "$TARGET"
node ./dist/cli/index.js ask  --cwd "$TARGET" "How does Counter.increment work?"
```

The default synth model is `claude-sonnet-4-6`; override it in `.atlas/config.json`.
Per-run spend is capped by `tokenBudget` (default 200k).

### Configuration

`atlas init` (or the first `atlas index`) writes `.atlas/config.json`; nothing
else is created in the target. A legacy root `atlas.config.json` is still read
if `.atlas/config.json` is absent, but is never written. Walk filters:

- `languages` — subset of `typescript`, `javascript`, `python` (default: all).
- `include` — gitignore-style globs; when non-empty only matching files are
  indexed (default `[]` = everything not excluded).
- `exclude` — globs added to `.gitignore` rules.

### MCP server

`atlas mcp` serves the index over stdio to MCP clients (Claude Code, Cursor, …)
as tools: `atlas_index`, `atlas_search`, `atlas_symbol`, `atlas_graph`,
`atlas_drift`, `atlas_docs` (read generated docs) and `atlas_ask` (grounded
answer with citation checks). It is additive: `atlas docs` and `atlas ask`
still work. `atlas_ask` spends tokens within `tokenBudget` per server session;
`--offline` uses the mock LLM. Like the CLI, it writes only under `.atlas/`.

```json
{
  "mcpServers": {
    "atlas": {
      "command": "npx",
      "args": ["atlas", "mcp", "--cwd", "/path/to/repo"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-…" }
    }
  }
}
```

## Verified on real third-party repos

The `scripts/verify-external.sh` script clones a public repo into a temp dir,
runs the full pipeline, and asserts that known symbols/edges/search results
show up. It works against two checked-in targets:

```bash
npm run build
bash scripts/verify-external.sh got       # sindresorhus/got (ESM TS)
bash scripts/verify-external.sh express   # expressjs/express (CommonJS JS)
```

Representative output (got, May 2026):

```
totals: files=78 symbols=2780 imports=656 edges=1093
  ok   files: 78 (>= 70)
  ok   symbols: 2780 (>= 2000)
  ok   edges: 1093 (>= 900)
  ok   known symbol: source/index.ts :: got = variable
  ok   search 'retry delay' surfaces source/core/options.ts in top 5
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/cli/`        | `commander` commands; thin — all logic in `core/` |
| `src/core/db/`    | SQLite schema + migrations + typed query helpers |
| `src/core/ingest/`| repo walker (respects `.gitignore`), language detect, content hashing, indexer |
| `src/core/parse/` | tree-sitter symbol extractors (TS/JS/Python; ESM + CJS) |
| `src/core/graph/` | reference resolution + JSON/DOT export |
| `src/core/vector/`| `sqlite-vec` vec0 store + local-hash embedder + hybrid search |
| `src/core/synth/` | LLM client interface (Anthropic + offline mock) + doc synthesis |
| `src/core/qa/`    | retrieval + grounded ask |
| `src/core/drift/` | stale-doc + undocumented-symbol detection |
| `src/web/`        | dashboard HTTP API + static UI |
| `src/mcp/`        | MCP server (`atlas mcp`) over the same core |
| `fixtures/sample/`| tiny multi-language repo used by tests |
| `.github/workflows/atlas.yml` | PR action that runs index + drift + posts a sticky comment |
| `scripts/demo.sh` | full pipeline against the bundled fixture |
| `scripts/verify-external.sh` | full pipeline against a freshly cloned public repo |

## Development

```bash
npm run typecheck       # strict TS, zero errors
npm run lint            # ESLint flat config, zero errors
npm test                # vitest — 62 tests
npm run build           # tsc + copy static assets
```

`npm test` includes a self-index integration test (Atlas indexes its own
source tree) and an end-to-end CI workflow test (index → docs → drift →
ci-comment produces the exact comment payload).

## CI

`.github/workflows/atlas.yml` runs on every PR: index, then drift against the
docs committed under `.atlas/docs` (not regenerated in CI), then posts a sticky
comment summarising stale docs and undocumented public symbols. Commit
`.atlas/docs/` and `.atlas/config.json` (so CI indexes with the same filters).
The job fails (so PR checks go red) when drift is present; `drift --docs-dir`
exits 1 when that directory is missing or holds no docs.

## Costs and safety

- **Secrets:** `ANTHROPIC_API_KEY` is read from the environment; `.env` is
  gitignored. Atlas fails loudly if it's missing and `--offline` wasn't
  passed.
- **Spend cap:** per-run token budget in `tokenBudget`; the synthesizer
  skips work rather than overrunning.
- **Offline mode:** `--offline` swaps in the deterministic mock LLM so
  synthesis and Q&A run in tests / CI / on planes.
- **Read-only on inputs:** Atlas never modifies the target repository; it
  only writes to its own index under `.atlas/`.

See `DECISIONS.md` for non-obvious architectural choices and `CLAUDE.md`
for the operating manual that drove the build.

## License

MIT — see `LICENSE`.
