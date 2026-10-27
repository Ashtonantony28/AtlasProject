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

# 7. Drift report. Exits 2 if any doc is stale (with --strict, also if a public
#    symbol is undocumented); `--json` sets `failing` exactly when it exits 2.
#    Exits 1 when there are no docs to check.
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

The default synth model is `claude-sonnet-4-6`; override it with `synthModel` in
`.atlas/config.json`. Spend is capped by `tokenBudget` (default 200k) per run of
`atlas docs` (or `--budget <n>`) and of `atlas ask`, and per `atlas mcp` session.
Each call's `max_tokens` (at most 16k) is capped to what the budget has left after
its prompt; a call that could not get 1024 output tokens is refused. When the
budget cannot pay for the first doc or answer, `docs`, `ask` and `atlas_ask` fail
with `token budget exhausted: …`; once some docs are written, `docs` skips the rest.

### Configuration

`atlas init` (or the first `atlas index`) writes `.atlas/config.json`; nothing
else is created in the target. A legacy root `atlas.config.json` is still read
if `.atlas/config.json` is absent, but is never written. Walk filters:

- `languages` — subset of `typescript`, `javascript`, `python` (default: all).
- `include` — gitignore-style globs; when non-empty only matching files are
  indexed (default `[]` = everything not excluded).
- `exclude` — globs applied after every `.gitignore` in the tree (root and
  nested); a `!pattern` here re-includes a gitignored path. The default is
  root-anchored: `node_modules/**`, `dist/**`, `build/**`, `.atlas/**`,
  `coverage/**`, `.venv/**`, `venv/**`, `.next/**`, `.cache/**`. Remove an
  entry to index that directory; `src/build/` or `lib/vendor/` is indexed
  unless a `.gitignore` or `exclude` rule says otherwise.

Whatever the config, `.git`, `.atlas`, `node_modules` and `__pycache__`
directories are skipped at any depth, as is any virtualenv (a directory holding
`pyvenv.cfg`).

Other keys: `tokenBudget` (positive integer, default 200000), `synthModel`,
`embeddingModel` (default `local-hash-v1`), `indexPath` (default
`.atlas/index.db`; it must resolve inside `.atlas/`, or every command fails) and
the optional `maxFileBytes` (positive integer, default 1048576): larger source
files are not indexed, and `atlas index` counts them (`--verbose` lists them).

### Command notes

The CLI, the dashboard API and the MCP tools validate parameters with one
shared schema, so a bad value fails everywhere (CLI exit 1, HTTP 400, MCP
error) instead of being ignored:

- `index` re-parses only changed files, except after an Atlas upgrade that changed
  extraction (it then re-parses everything once and says so). Edges are rebuilt
  when a file changed or a resolver input did (`tsconfig.json`/`jsconfig.json`
  and their `extends`, `package.json` `name`/`workspaces`/`main`/`module`/`exports`,
  `pnpm-workspace.yaml`, `pyproject.toml`/`setup.cfg`/`setup.py`), so `--force`
  is never needed for correctness. Resolver diagnostics (malformed configs,
  ambiguous workspace packages) are printed (first 10) and returned in full
  (first 20) by `atlas_index`.
- `search`: `--limit` 1–100 (default 10); `--kind` is a comma-separated list of
  `function`, `method`, `class`, `interface`, `type`, `variable`; the query must
  not be blank.
- `ask`: `--k` 1–20 seed snippets (default 5), `--expand` 0–20 (default 5).
- `docs`: `--budget` must be a positive integer. `--list` and `--show <path>`
  read the index, then the committed `.atlas/docs` (as the dashboard and
  `atlas_docs` do); `--show` exits 1 when there is no doc. A refused, cut-off
  (`max_tokens`) or empty completion is never stored: `docs` names the target
  and exits 1, and `ask` fails with an error.
- `serve`: `--port` 0–65535.
- Read commands (`search`, `graph`, `docs`, `ask`, `drift`, `serve`) fail with
  "no index … run `atlas index` first" on an unindexed directory and "directory not found"
  for a bad `--cwd`, and create nothing.
  `search`, `graph`, `ask` and `drift` also exit 1 with "index is empty: run
  `atlas index` first" when no file is indexed (MCP: "index is empty: call
  atlas_index first").

### MCP server

`atlas mcp` serves the index over stdio to MCP clients (Claude Code, Cursor, …)
as tools: `atlas_index`, `atlas_search`, `atlas_symbol`, `atlas_graph`,
`atlas_drift`, `atlas_docs` (read generated docs) and `atlas_ask` (grounded
answer with citation checks). It is additive: `atlas docs` and `atlas ask`
still work. `atlas_ask` spends tokens within `tokenBudget` per server session;
`--offline` uses the mock LLM. `atlas_drift` returns the same report as
`atlas drift --json`, paged to 100 stale and 100 undocumented entries
(`limit`/`offset`; `totals` and `truncated` say what was left out; `formatted:
true` adds the text report; `strict` sets `failing` like `--strict`) and errors
when there are no docs to check. `atlas_graph` (and the dashboard's
`/api/graph`) returns at most 1000 nodes and 2000 edges by default, scoped with
`file` or `symbol` + `depth`; `atlas graph` takes the same flags but exports
everything unless `--limit` is given. A page holds `limit` nodes from `offset`
and the edges whose `src` is among them (the `dst` may be on another page), so
paging through every node returns every edge in `totals.edges` once;
`truncated` is true whenever the response is not the whole scope, including
every page after the first. `--cwd` must exist; like the CLI,
the server writes only under `.atlas/`.

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

### The index files: reset and backup

The index is `.atlas/index.db` plus, while a process has it open (or after one
was killed), `index.db-wal` and `index.db-shm`. The three move together: recent
writes may live only in the `-wal`, so copying or moving `index.db` alone
loses them, and an `index.db` copied beside another index's `-wal` would be
mixed with it. `atlas index`, `atlas docs`, `atlas mcp` and `atlas serve`
close the index when stopped with Ctrl-C or SIGTERM, which leaves a complete
`index.db` and no `-wal`.

- **Reset:** stop every Atlas process on the project, then
  `rm .atlas/index.db*` and `atlas index`. The index is rebuilt from source;
  committed `.atlas/docs` are imported again by `atlas docs`.
- **Back up or restore:** with no Atlas process running (so there is no
  `-wal`), copy `index.db`; when restoring, delete the old `index.db-wal` and
  `index.db-shm` first.

Copying or moving the project or its `.atlas/` (`cp -r`, `cp -a`, `rsync -a`,
`tar`, `mv`), a killed writer's last `-wal` included, keeps every committed
write. Before opening an index beside a `-wal` that no running process holds,
Atlas checks it under `.atlas/index.db.open.lock`, which every Atlas process
opening the index takes: the `-wal` is kept when the index with it replayed
passes SQLite's integrity check. Otherwise, if no checkpoint of it ever started,
it is renamed to `index.db-wal.foreign-<ms>` (never deleted) and Atlas says so on
stderr; move it back beside the index it came from to recover its writes. In
any other case, or when SQLite finds the index corrupt, every surface fails with
one message naming the file, the `-wal` (a symlinked index's target) and the
remedy above (CLI exit 1, MCP `isError`, HTTP 500).

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
npm test                # vitest unit + integration suites (parallel)
npm run test:perf       # frozen wall-clock budgets in test/perf/, run serially
npm run test:coverage   # npm test + src/core coverage thresholds (CI runs this)
npm run build           # tsc + copy static assets
```

A change to what the parser extracts (symbols, imports, references) must bump
`EXTRACTOR_VERSION` in `src/core/parse/version.ts`; the parse golden test
(`ATLAS_UPDATE_GOLDEN=1`) refuses to regenerate without it. A resolver change that
alters edges for the same input bumps `RESOLVER_VERSION` in
`src/core/graph/modules.ts`. Existing indexes then re-parse / re-resolve on the
next `atlas index` without a migration.

`npm test` includes a self-index integration test (Atlas indexes its own
source tree) and an end-to-end CI workflow test (index → docs → drift →
ci-comment produces the exact comment payload). Timing budgets (search p95
≤ 50 ms at 10k symbols, cached synthesis and drift ≤ 1 s at 1k files) live in
`test/perf/` and run only under `npm run test:perf`, one file at a time, so a
loaded machine running the parallel suite cannot fail them.

## CI

`.github/workflows/atlas.yml` runs on every PR: index, then drift against the
docs committed under `.atlas/docs` (not regenerated in CI), then posts a sticky
comment summarising stale docs and undocumented public symbols. Commit
`.atlas/docs/` and `.atlas/config.json` (so CI indexes with the same filters).
The job fails (so PR checks go red) when a doc is stale: `drift` exits 2 and the
JSON has `failing: true`, and the comment says "Drift check: failed".
Undocumented public symbols are listed in the comment but do not fail the job
(that needs `--strict`). `drift --docs-dir` exits 1 when that directory is
missing or holds no docs. `hasDrift` in the JSON means "anything to report"
(stale or undocumented); use `failing` for the gate.

## Costs and safety

- **Secrets:** `ANTHROPIC_API_KEY` is read from the environment; `.env` is
  gitignored. Atlas fails loudly if it's missing and `--offline` wasn't
  passed.
- **Spend cap:** per-run token budget in `tokenBudget`; calls are capped to
  what is left, and the synthesizer skips work rather than overrunning.
- **Offline mode:** `--offline` swaps in the deterministic mock LLM so
  synthesis and Q&A run in tests / CI / on planes.
- **Read-only on inputs:** Atlas never modifies the target repository; it
  only writes to its own index under `.atlas/`.

See `DECISIONS.md` for non-obvious architectural choices and `CLAUDE.md`
for the operating manual that drove the build.

## License

MIT — see `LICENSE`.
