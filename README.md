# Atlas

> Local-first codebase intelligence engine. Point it at any repository and get
> a symbol + dependency graph, self-maintaining docs, hybrid (semantic +
> structural) search, grounded Q&A, and doc-drift detection — with a CLI and a
> local dashboard.

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

# generate module + architecture docs (offline mock — no API spend)
node ./dist/cli/index.js docs --offline --cwd ./fixtures/sample
node ./dist/cli/index.js docs --show src/shapes.ts --cwd ./fixtures/sample
node ./dist/cli/index.js docs --show architecture --cwd ./fixtures/sample

# ask a grounded question (offline mock cites the snippets it received)
node ./dist/cli/index.js ask --offline --cwd ./fixtures/sample "How is the area of a circle computed?"

# drift report (exits non-zero if any doc is stale or any public symbol is undocumented)
node ./dist/cli/index.js drift --cwd ./fixtures/sample

# open the dashboard (graph + doc browser + search)
node ./dist/cli/index.js serve --cwd ./fixtures/sample
# then open http://127.0.0.1:4321/
```

For the real LLM-backed synthesis and Q&A, set `ANTHROPIC_API_KEY` and drop
`--offline`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
node ./dist/cli/index.js docs --cwd ./fixtures/sample
node ./dist/cli/index.js ask --cwd ./fixtures/sample "How does Counter.increment work?"
```

## What's in here

| Path | Purpose |
| --- | --- |
| `src/cli/`        | `commander` commands; thin — all logic in `core/` |
| `src/core/db/`    | SQLite schema + migrations + typed query helpers |
| `src/core/ingest/`| repo walker, language detect, content hashing, indexer |
| `src/core/parse/` | tree-sitter symbol extractors (TS/JS/Python) |
| `src/core/graph/` | reference resolution + JSON/DOT export |
| `src/core/vector/`| local-hash embeddings + hybrid search |
| `src/core/synth/` | LLM client interface (Anthropic + offline) + doc synthesis |
| `src/core/qa/`    | retrieval + grounded ask |
| `src/core/drift/` | stale-doc + undocumented detection |
| `src/web/`        | dashboard HTTP server + static UI |
| `fixtures/sample/`| tiny multi-language repo used by tests |
| `.github/workflows/atlas.yml` | PR action that runs index + drift + posts a comment |

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Costs and safety

- **Secrets:** `ANTHROPIC_API_KEY` is read from the environment; `.env` is
  gitignored.
- **Spend cap:** per-run token budget from config (`tokenBudget`); the
  synthesizer skips work rather than overrunning.
- **Offline mode:** `--offline` swaps in a deterministic mock LLM so synthesis
  and Q&A can run in tests / CI / on planes.
- **Read-only on inputs:** Atlas never modifies the target repository; it only
  writes to its own index under `.atlas/`.

See `DECISIONS.md` for non-obvious choices and `CLAUDE.md` for the operating
manual that drove the build.
