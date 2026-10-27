---
kind: architecture
target: architecture
source_hash: c0e76024b0379db5455b4d90421638fe678f821d835cf4860a853109b8e99167
---
# Architecture

This codebase's modules collaborate through the graph above.

**Totals:** 233 files, 1796 symbols, 8647 edges

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
- `fixtures/graph/web/geo.ts` — typescript, loc=15, 6 symbols
- `fixtures/graph/web/handlers.js` — javascript, loc=18, 4 symbols
- `fixtures/graph/web/routes.js` — javascript, loc=11, 3 symbols
- `fixtures/graph/web/ui/Base.ts` — typescript, loc=8, 3 symbols
- `fixtures/graph/web/widget.ts` — typescript, loc=38, 9 symbols
- `fixtures/parse/walk.js` — javascript, loc=40, 11 symbols
- `fixtures/parse/walk.ts` — typescript, loc=79, 18 symbols
- `fixtures/sample/src/math.ts` — typescript, loc=15, 3 symbols
- `fixtures/sample/src/shapes.ts` — typescript, loc=35, 11 symbols
- `fixtures/sample/src/util.py` — python, loc=18, 4 symbols
- `scripts/audit-explain.mjs` — javascript, loc=30, 9 symbols
- `scripts/audit-load.mjs` — javascript, loc=136, 44 symbols
- `scripts/audit-perf.mjs` — javascript, loc=213, 66 symbols
- `scripts/audit-repo.mjs` — javascript, loc=176, 14 symbols
- `scripts/audit-scaling.mjs` — javascript, loc=64, 16 symbols
- `scripts/audit2-load.mjs` — javascript, loc=161, 36 symbols
- `scripts/audit2-mcp-index.mjs` — javascript, loc=51, 16 symbols
- `scripts/audit2-memory.mjs` — javascript, loc=84, 26 symbols
- `scripts/audit2-reindex.mjs` — javascript, loc=146, 37 symbols
- `scripts/audit3-patho.mjs` — javascript, loc=164, 38 symbols
- `scripts/audit4-fresh.mjs` — javascript, loc=87, 16 symbols
- `scripts/audit4-mcp-queue.mjs` — javascript, loc=121, 20 symbols
- `scripts/bench.mjs` — javascript, loc=93, 25 symbols
- `scripts/copy-static.mjs` — javascript, loc=16, 3 symbols
- `src/cli/commands/ciCommentCmd.ts` — typescript, loc=165, 7 symbols
- `src/cli/commands/indexCmd.ts` — typescript, loc=106, 6 symbols
- `src/core/config.ts` — typescript, loc=134, 14 symbols
- `src/core/db/database.ts` — typescript, loc=631, 40 symbols
- `src/core/db/repo.ts` — typescript, loc=413, 44 symbols
- `src/core/db/schema.ts` — typescript, loc=187, 3 symbols
- `src/core/db/types.ts` — typescript, loc=79, 9 symbols
- `src/core/drift/detect.ts` — typescript, loc=245, 10 symbols
- `src/core/graph/export.ts` — typescript, loc=212, 18 symbols
- `src/core/graph/modules.ts` — typescript, loc=704, 47 symbols
- `src/core/graph/resolver.ts` — typescript, loc=416, 12 symbols
- `src/core/ingest/indexer.ts` — typescript, loc=520, 16 symbols
- `src/core/ingest/language.ts` — typescript, loc=28, 4 symbols
- `src/core/ingest/lock.ts` — typescript, loc=35, 3 symbols
- `src/core/ingest/walker.ts` — typescript, loc=202, 17 symbols
- `src/core/params.ts` — typescript, loc=93, 22 symbols

## Key collaborations

- `src/core/db/database.ts` (degree=713)
- `src/core/db/repo.ts` (degree=455)
- `src/mcp/server.ts` (degree=373)
- `src/core/parse/ts.ts` (degree=296)
- `src/core/ingest/indexer.ts` (degree=234)
- `src/core/graph/modules.ts` (degree=184)
- `src/core/synth/persist.ts` (degree=161)
- `src/core/db/index.ts` (degree=140)
- `test/cli/helpers.ts` (degree=136)
- `test/audit/audit-31.test.ts` (degree=131)

_Generated offline (mock client)._
