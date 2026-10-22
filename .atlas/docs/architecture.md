---
kind: architecture
target: architecture
source_hash: 8e302f3aea96deba5257f68317d6a477a7dc2d54d3b2483510679cb5ac1c9bf0
---
# Architecture

This codebase's modules collaborate through the graph above.

**Totals:** 191 files, 2648 symbols, 6408 edges

## Modules

- `fixtures/graph/py/pkg/hooks.py` — python, loc=13, 3 symbols
- `fixtures/graph/py/pkg/models.py` — python, loc=14, 5 symbols
- `fixtures/graph/py/pkg/repo.py` — python, loc=23, 6 symbols
- `fixtures/graph/py/pkg/sub/service.py` — python, loc=20, 2 symbols
- `fixtures/graph/py/pkg/util.py` — python, loc=6, 2 symbols
- `fixtures/graph/web/app.tsx` — typescript, loc=18, 4 symbols
- `fixtures/graph/web/cjs/Model.js` — javascript, loc=5, 2 symbols
- `fixtures/graph/web/cjs/app.js` — javascript, loc=10, 2 symbols
- `fixtures/graph/web/cjs/main.js` — javascript, loc=16, 5 symbols
- `fixtures/graph/web/consumer.js` — javascript, loc=7, 2 symbols
- `fixtures/graph/web/decoys.ts` — typescript, loc=15, 2 symbols
- `fixtures/graph/web/geo.ts` — typescript, loc=15, 6 symbols
- `fixtures/graph/web/handlers.js` — javascript, loc=18, 4 symbols
- `fixtures/graph/web/legacy.cjs` — javascript, loc=8, 2 symbols
- `fixtures/graph/web/measure.ts` — typescript, loc=8, 2 symbols
- `fixtures/graph/web/routes.js` — javascript, loc=11, 3 symbols
- `fixtures/graph/web/shape.ts` — typescript, loc=7, 2 symbols
- `fixtures/graph/web/strings.ts` — typescript, loc=7, 2 symbols
- `fixtures/graph/web/ui/Base.ts` — typescript, loc=8, 3 symbols
- `fixtures/graph/web/widget.ts` — typescript, loc=38, 9 symbols
- `fixtures/parse/walk.js` — javascript, loc=40, 10 symbols
- `fixtures/parse/walk.ts` — typescript, loc=79, 23 symbols
- `fixtures/sample/src/app.ts` — typescript, loc=14, 2 symbols
- `fixtures/sample/src/math.ts` — typescript, loc=15, 3 symbols
- `fixtures/sample/src/shapes.ts` — typescript, loc=35, 11 symbols
- `fixtures/sample/src/util.py` — python, loc=18, 4 symbols
- `scripts/audit-explain.mjs` — javascript, loc=30, 9 symbols
- `scripts/audit-load.mjs` — javascript, loc=136, 44 symbols
- `scripts/audit-perf.mjs` — javascript, loc=213, 58 symbols
- `scripts/audit-repo.mjs` — javascript, loc=176, 12 symbols
- `scripts/audit-scaling.mjs` — javascript, loc=64, 13 symbols
- `scripts/audit2-load.mjs` — javascript, loc=161, 36 symbols
- `scripts/audit2-mcp-index.mjs` — javascript, loc=51, 13 symbols
- `scripts/audit2-memory.mjs` — javascript, loc=84, 21 symbols
- `scripts/audit2-reindex.mjs` — javascript, loc=146, 31 symbols
- `scripts/audit3-patho.mjs` — javascript, loc=164, 29 symbols
- `scripts/bench.mjs` — javascript, loc=93, 25 symbols
- `scripts/copy-static.mjs` — javascript, loc=16, 3 symbols
- `src/cli/commands/askCmd.ts` — typescript, loc=87, 2 symbols
- `src/cli/commands/ciCommentCmd.ts` — typescript, loc=165, 7 symbols
- `src/cli/commands/docsCmd.ts` — typescript, loc=99, 2 symbols
- `src/cli/commands/driftCmd.ts` — typescript, loc=64, 2 symbols
- `src/cli/commands/indexCmd.ts` — typescript, loc=101, 6 symbols
- `src/core/config.ts` — typescript, loc=134, 14 symbols
- `src/core/db/database.ts` — typescript, loc=95, 9 symbols
- `src/core/db/repo.ts` — typescript, loc=408, 44 symbols
- `src/core/db/schema.ts` — typescript, loc=187, 3 symbols
- `src/core/db/types.ts` — typescript, loc=79, 9 symbols
- `src/core/drift/detect.ts` — typescript, loc=245, 10 symbols
- `src/core/graph/export.ts` — typescript, loc=212, 18 symbols

## Key collaborations

- `src/core/db/repo.ts` (degree=371)
- `src/core/db/database.ts` (degree=369)
- `src/mcp/server.ts` (degree=257)
- `src/core/parse/ts.ts` (degree=229)
- `src/core/ingest/indexer.ts` (degree=178)
- `src/core/graph/modules.ts` (degree=172)
- `src/core/synth/persist.ts` (degree=167)
- `test/synth/completion.test.ts` (degree=153)
- `test/audit/audit-4.test.ts` (degree=137)
- `test/graph/paging.test.ts` (degree=136)

_Generated offline (mock client)._
