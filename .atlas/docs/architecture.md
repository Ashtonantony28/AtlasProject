---
kind: architecture
target: architecture
source_hash: 5940f6dc3f0eb9c1931caa532c896ef626eb65080dec06c86dd848b84324dbf6
---
# Architecture

This codebase's modules collaborate through the graph above.

**Totals:** 160 files, 1914 symbols, 4728 edges

## Modules

- `eslint.config.js` — javascript, loc=32, 0 symbols
- `fixtures/graph/py/pkg/__init__.py` — python, loc=1, 0 symbols
- `fixtures/graph/py/pkg/api/__init__.py` — python, loc=2, 0 symbols
- `fixtures/graph/py/pkg/api/star_src.py` — python, loc=2, 1 symbols
- `fixtures/graph/py/pkg/api/views.py` — python, loc=2, 1 symbols
- `fixtures/graph/py/pkg/models.py` — python, loc=14, 5 symbols
- `fixtures/graph/py/pkg/repo.py` — python, loc=23, 6 symbols
- `fixtures/graph/py/pkg/star_use.py` — python, loc=5, 1 symbols
- `fixtures/graph/py/pkg/sub/__init__.py` — python, loc=1, 0 symbols
- `fixtures/graph/py/pkg/sub/service.py` — python, loc=20, 2 symbols
- `fixtures/graph/py/pkg/sub/tools.py` — python, loc=2, 1 symbols
- `fixtures/graph/py/pkg/util.py` — python, loc=6, 2 symbols
- `fixtures/graph/web/Button.tsx` — typescript, loc=5, 1 symbols
- `fixtures/graph/web/app.tsx` — typescript, loc=18, 4 symbols
- `fixtures/graph/web/cjs/Model.js` — javascript, loc=5, 2 symbols
- `fixtures/graph/web/cjs/app.js` — javascript, loc=10, 2 symbols
- `fixtures/graph/web/cjs/index.js` — javascript, loc=1, 0 symbols
- `fixtures/graph/web/cjs/main.js` — javascript, loc=16, 5 symbols
- `fixtures/graph/web/consumer.js` — javascript, loc=7, 2 symbols
- `fixtures/graph/web/decoys.ts` — typescript, loc=15, 2 symbols
- `fixtures/graph/web/ids.ts` — typescript, loc=5, 1 symbols
- `fixtures/graph/web/legacy.cjs` — javascript, loc=8, 2 symbols
- `fixtures/graph/web/lib/index.mts` — typescript, loc=3, 1 symbols
- `fixtures/graph/web/store.ts` — typescript, loc=1, 1 symbols
- `fixtures/graph/web/strings.ts` — typescript, loc=7, 2 symbols
- `fixtures/graph/web/ui/Base.ts` — typescript, loc=8, 3 symbols
- `fixtures/graph/web/ui/Panel.tsx` — typescript, loc=3, 1 symbols
- `fixtures/graph/web/ui/cycle.ts` — typescript, loc=5, 1 symbols
- `fixtures/graph/web/ui/extra.ts` — typescript, loc=3, 1 symbols
- `fixtures/graph/web/ui/index.ts` — typescript, loc=4, 0 symbols
- `fixtures/graph/web/widget.ts` — typescript, loc=38, 9 symbols
- `fixtures/parse/walk.js` — javascript, loc=40, 8 symbols
- `fixtures/parse/walk.ts` — typescript, loc=79, 22 symbols
- `fixtures/sample/src/app.ts` — typescript, loc=14, 2 symbols
- `fixtures/sample/src/math.ts` — typescript, loc=15, 3 symbols
- `fixtures/sample/src/shapes.ts` — typescript, loc=35, 11 symbols
- `fixtures/sample/src/util.py` — python, loc=18, 4 symbols
- `scripts/audit-explain.mjs` — javascript, loc=30, 9 symbols
- `scripts/audit-load.mjs` — javascript, loc=136, 44 symbols
- `scripts/audit-perf.mjs` — javascript, loc=213, 58 symbols
- `scripts/audit-repo.mjs` — javascript, loc=176, 12 symbols
- `scripts/audit-scaling.mjs` — javascript, loc=64, 13 symbols
- `scripts/bench.mjs` — javascript, loc=93, 25 symbols
- `scripts/copy-static.mjs` — javascript, loc=16, 3 symbols
- `scripts/synthetic-repo.mjs` — javascript, loc=29, 1 symbols
- `src/cli/commands/askCmd.ts` — typescript, loc=87, 2 symbols
- `src/cli/commands/ciCommentCmd.ts` — typescript, loc=91, 3 symbols
- `src/cli/commands/docsCmd.ts` — typescript, loc=99, 2 symbols
- `src/cli/commands/driftCmd.ts` — typescript, loc=64, 2 symbols
- `src/cli/commands/graphCmd.ts` — typescript, loc=70, 2 symbols

## Key collaborations

- `src/core/db/database.ts` (degree=300)
- `src/core/db/repo.ts` (degree=271)
- `src/mcp/server.ts` (degree=226)
- `src/core/parse/ts.ts` (degree=164)
- `test/synth/completion.test.ts` (degree=153)
- `src/core/synth/persist.ts` (degree=143)
- `src/core/ingest/indexer.ts` (degree=136)
- `test/audit/audit-4.test.ts` (degree=133)
- `test/mcp/server.test.ts` (degree=120)
- `test/audit/audit-3.test.ts` (degree=116)

_Generated offline (mock client)._
