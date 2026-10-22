---
kind: file
target: src/core/db/repo.ts
source_hash: 98ad952c11a1adc8118a70de8cb439b4bbe2789de1191c090536988a5f51a955
---
# module src/core/db/repo.ts

`module src/core/db/repo.ts` exposes the following public surface:

- `UpsertFileInput` — interface (src/core/db/repo.ts:17)
- `upsertFile` — function (src/core/db/repo.ts:24)
- `getFileByPath` — function (src/core/db/repo.ts:48)
- `getAllFiles` — function (src/core/db/repo.ts:52)
- `deleteSymbolsForFile` — function (src/core/db/repo.ts:56)
- `deleteImportsForFile` — function (src/core/db/repo.ts:60)
- `InsertSymbolInput` — interface (src/core/db/repo.ts:64)
- `insertSymbol` — function (src/core/db/repo.ts:76)
- `insertSymbols` — function (src/core/db/repo.ts:96)
- `getSymbolsForFile` — function (src/core/db/repo.ts:117)
- `getAllSymbols` — function (src/core/db/repo.ts:123)
- `findSymbolByName` — function (src/core/db/repo.ts:127)
- `findSymbolsByKind` — function (src/core/db/repo.ts:131)
- `InsertEdgeInput` — interface (src/core/db/repo.ts:135)
- `insertEdge` — function (src/core/db/repo.ts:143)
- `insertEdges` — function (src/core/db/repo.ts:153)
- `BATCH_SIZES` — variable (src/core/db/repo.ts:165)
- `batchSql` — variable (src/core/db/repo.ts:166)
- `insertBatched` — function (src/core/db/repo.ts:173)
- `getAllEdges` — function (src/core/db/repo.ts:198)
- `clearEdges` — function (src/core/db/repo.ts:202)
- `InsertImportInput` — interface (src/core/db/repo.ts:206)
- `insertImport` — function (src/core/db/repo.ts:215)
- `insertImports` — function (src/core/db/repo.ts:232)
- `getImportsForFile` — function (src/core/db/repo.ts:243)
- `getAllImports` — function (src/core/db/repo.ts:249)
- `InsertRefInput` — type (src/core/db/repo.ts:253)
- `insertRefs` — function (src/core/db/repo.ts:255)
- `getAllRefs` — function (src/core/db/repo.ts:266)
- `deleteRefsForFile` — function (src/core/db/repo.ts:270)
- `UpsertDocInput` — interface (src/core/db/repo.ts:274)
- `upsertDoc` — function (src/core/db/repo.ts:282)
- `getDoc` — function (src/core/db/repo.ts:309)
- `TOMBSTONE_KIND` — variable (src/core/db/repo.ts:318)
- `getAllDocs` — function (src/core/db/repo.ts:320)
- `DocTombstone` — interface (src/core/db/repo.ts:326)
- `getDocTombstones` — function (src/core/db/repo.ts:332)
- `clearDocTombstones` — function (src/core/db/repo.ts:344)
- `startRun` — function (src/core/db/repo.ts:348)
- `finishRun` — function (src/core/db/repo.ts:355)
- `getLastRunStats` — function (src/core/db/repo.ts:364)
- `getLastRun` — function (src/core/db/repo.ts:381)
- `counts` — function (src/core/db/repo.ts:385)
- `deleteFile` — function (src/core/db/repo.ts:404)

References: `src/core/db/repo.ts:17`, `src/core/db/repo.ts:24`, `src/core/db/repo.ts:48`, `src/core/db/repo.ts:52`, `src/core/db/repo.ts:56`.

_Generated offline (mock client)._
