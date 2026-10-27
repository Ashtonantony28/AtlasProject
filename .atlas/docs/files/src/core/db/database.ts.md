---
kind: file
target: src/core/db/database.ts
source_hash: 86507dd7220d716dcaed8ab2fdb74c2ba5ad457c00f09aca3680ea072361b132
---
# module src/core/db/database.ts

`module src/core/db/database.ts` exposes the following public surface:

- `DB` — type (src/core/db/database.ts:17)
- `BUSY_TIMEOUT_MS` — variable (src/core/db/database.ts:20)
- `LOCK_POLL_MS` — variable (src/core/db/database.ts:22)
- `statements` — variable (src/core/db/database.ts:24)
- `prepareCached` — function (src/core/db/database.ts:27)
- `OpenDbOptions` — interface (src/core/db/database.ts:35)
- `loadVecExtension` — function (src/core/db/database.ts:41)
- `openDatabase` — function (src/core/db/database.ts:50)
- `dropForeignWal` — function (src/core/db/database.ts:99)
- `checkIntegrity` — function (src/core/db/database.ts:119)
- `neverCheckpointed` — function (src/core/db/database.ts:145)
- `readHead` — function (src/core/db/database.ts:159)
- `fileInUse` — function (src/core/db/database.ts:174)
- `createWalFile` — function (src/core/db/database.ts:198)
- `switchToWal` — function (src/core/db/database.ts:222)
- `immediate` — function (src/core/db/database.ts:245)
- `BUSY_REMEDY` — variable (src/core/db/database.ts:268)
- `nameBusy` — function (src/core/db/database.ts:274)
- `lastOpened` — variable (src/core/db/database.ts:287)
- `nameCorrupt` — function (src/core/db/database.ts:293)
- `closeOnSignal` — function (src/core/db/database.ts:313)
- `ensureMigrationsTable` — function (src/core/db/database.ts:328)
- `appliedVersion` — function (src/core/db/database.ts:338)
- `runMigrations` — function (src/core/db/database.ts:349)
- `closeDatabase` — function (src/core/db/database.ts:372)

References: `src/core/db/database.ts:17`, `src/core/db/database.ts:20`, `src/core/db/database.ts:22`, `src/core/db/database.ts:24`, `src/core/db/database.ts:27`.

_Generated offline (mock client)._
