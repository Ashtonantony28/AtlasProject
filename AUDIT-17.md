# AUDIT-17: soundness (round 5, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `7f4cea0` (SG40 merged, after SG31–SG34) on
`claude/atlas-audit-17`. Date: 2026-10-22.

Question: can Atlas silently miss something it claims to capture, or report something stale as current? Scope:
the fixes since AUDIT-13 (SG31 destructured symbols, SG32 cross-process index lock, SG33 interrupted-run
recovery, SG34 yielding and joining queued runs, SG40 MCP config reload), the open A13-04/05/06, and new false
negatives in extraction, edges, drift and search.

Method:
- **Oracles on real repos** (read-only clones in the scratchpad from AUDIT-13: express, got, trpc, create-t3-app,
  flask, attrs; indexes went to scratch DBs or copies). The AUDIT-13 scripts were re-run against this build:
  - `tsc` `getExportsOfModule` vs Atlas exports: trpc misses 89 → **75** and t3 27 → **20** (all 14 + 7
    destructured exports now found; what is left is A13-07 `export default <expr>`, type-only re-exports of
    imports and JSDoc typedefs), express 13 (A13-04, unchanged), got 1.
  - Python `ast` (`python3 -I`): 0 missing top-level bindings, 0 missing and 0 wrong exports on flask (726) and
    attrs (569).
  - Callback-local leak (`leak.mjs`): 0 on express, got, trpc and t3.
  - SG31 before/after: the pre-SG31 tree (`f75358a`, `git archive`) and this one on fixtures and the four JS/TS
    repos, counting strong `calls` edges into a same-file `variable` that is also an import binding.
- **Process-level attacks** with the built CLI (`node dist/cli/index.js`):
  - SG33: a trpc copy, 40 files changed, `atlas index` SIGKILLed after 0.6/1.0/1.5/2.5 s, then a plain run;
    edges and symbols compared with a fresh index of the same tree.
  - SG32: two `atlas index` processes on a got copy, the second started 0/0.3/0.6/0.9/1.2 s later; a third
    process holding `<db>.lock`; a garbage, random-bytes and directory `<db>.lock`; the project on a read-only
    tmpfs mount.
- **In-process attacks** (`test/audit/audit-17.test.ts`): TS/JS and Python pattern shapes, SG34 joins timed
  around the queued run's start, SG40 edits (budget up/down with a call in flight, respelled `indexPath`, invalid
  config), parallel `atlas_ask`, and MCP reads while `atlas_index` runs.

Repros are in `test/audit/audit-17.test.ts`. An `it.fails` asserts the correct behaviour; each was run once as
a plain `it` and fails on the assertion that names its defect (messages below). Plain `it` blocks pin what was
attacked and held.

**Summary: 0 critical, 0 high, 3 medium, 2 low.** SG31, SG32, SG33, SG34 (as specified) and SG40 hold. Two of
the mediums are side effects of those fixes: SG31 widens A13-05 to destructured `require` (A17-01), and SG34's
yields let an MCP read see the graph half-rebuilt (A17-03). A13-04, A13-05 and A13-06 are still open (their
`it.fails` still fail; express numbers unchanged: 13 missing CommonJS value exports, 159 self-binding edges).

## Re-verified (fixes since AUDIT-13)

| Fix | Attack | Result |
| --- | --- | --- |
| SG31 (TS/JS) | nested object/array patterns, defaults, rest (object and array), renames, holes, computed/string/numeric keys, type annotations, `as const`, namespaces, `export var {a} = x, b`, a later `export { a, b as c }`, IIFE wrappers; `for…of` targets, callback and function locals | every bound name is a `variable`, exported like its declaration; locals and loop targets are not symbols (pinned). Importers and callers resolve strongly. |
| SG31 (Python) | `a, b =`, `(a, b) =`, `[a, b] =`, starred, nested, chained (`m = n =`, `o, p = q, r = x`), attribute/subscript targets, under `if`/`try`, `_private`, `__all__` | every name bound, attributes/subscripts and `for` targets skipped, exports follow `__all__`/naming (pinned); `from m import a` and `m.b()` resolve. A class-level `ca, cb = 1, 2` is no symbol, but no class attribute is (`x = 1` neither), so this is consistent. |
| SG32 | 5 staggered two-process races on got | both exit 0, edges and symbols identical to a single run every time. A held lock makes `atlas index` wait (2.5 s while a holder kept it 3 s); a lock file left by a dead holder does not block (pinned). A corrupt or unopenable lock file, or a read-only filesystem, fails the run before anything is written (pinned), with a poor message (A17-05). |
| SG33 | SIGKILL at 4 points of a 1,058-file run; two injected interruptions in a row | every next run matches a fresh index (at 0.6 s the kill landed in the parse loop, at 1.0 s after it: `resolved … after an interrupted run`; at 1.5/2.5 s the run had finished); after two interruptions the next run re-resolves and the one after keeps the graph (pinned). An extractor upgrade interrupted mid-parse is re-run whole, because the version is read from the last *finished* run. |
| SG34 | a change written after a call queued but before its run started, then a second call | the second call joins (same promise) and the run sees the change; a call made after the run started (its `runs` row exists) does not join, and its change is indexed by its own run (pinned). Joined callers get one stats object for one run: no stats/rows mismatch. `runKind` covers every `IndexOptions` field. |
| SG40 | raise, lower below spent, keep; a call in flight while the budget object is replaced; `indexPath: './.atlas/../.atlas/index.db'`; `tokenBudget: -5` | spend is carried (in-flight usage lands on the new budget, none lost); a lowered cap refuses; a respelling of the same DB is not an `indexPath` change; an invalid config fails the call and leaves `ctx.config` and the budget unchanged (pinned). |

## Critical

None found.

## High

None found.

## Medium

### A17-01 A call through a destructured `require` of a package resolves to the importer's own binding (SG31 widens A13-05)

- **Evidence:** `const { join } = require('path'); function main() { join() }` gives a **strong**
  `main -calls-> use.js::join`; so does `const { missing } = require('./util')` when `util` exports no `missing`.
  On the pre-SG31 tree (`f75358a`) both are weak calls, as they are for the ESM `import { join } from 'path'`.
  The resolvable case (`const { helper } = require('./util')`) still resolves to `util.js::helper`, and a CommonJS
  barrel that re-exports such a binding is followed to the definition (checked). Real repos: express, got, trpc and
  t3 have no bare call through a destructured `require` today (express's 11 are `new AsyncLocalStorage()`-style
  aliases also present pre-SG31), so the count is 0 there; it is the idiomatic Node form
  (`const { promisify } = require('util')`). Weak counts understate unresolved calls and Q&A expansion follows
  a `variable` that is a `require` binding.
- **Test:** `A17-01 …` → `expected [ …(6) ] to not include 'use.js::main -calls-> use.js::join'`.
- **Cause:** SG31 makes each destructured name a top-level `variable` (`visitDeclarator`, `ts.ts:891-893`); the
  resolver's fallback for a binding with no symbol (`viaBinding`, `resolver.ts:289-293`, written for
  `const x = require('…')`) then finds that variable by name. Same fix as A13-05: a name bound by an import row is
  never resolved to the importer's own `variable`.

### A17-02 Parallel `atlas_ask` calls on one MCP session spend past `tokenBudget`

- **Evidence:** three parallel `atlas_ask` calls with `tokenBudget: 6000` and a client billed for the whole prompt
  and `max_tokens` spend **18,000** tokens. Run one after another, the second is capped to what is left and the
  third refused. The MCP SDK dispatches requests concurrently, and agents do issue parallel tool calls. The
  overrun is bounded by (parallel calls) × (prompt + up to `ASK_MAX_TOKENS` = 16k) per call; once spent, later
  calls are refused. `atlas docs` and CLI `ask` are sequential and not affected.
- **Test:** `A17-02 …` → `expected 18000 to be less than or equal to 6000`.
- **Cause:** `metered` (`server.ts`, SG40) and `budgeted` (`budget.ts`) check `affordableMaxTokens` against
  `remaining()` and only `record` after the response, so every in-flight call sees the same remaining budget.
  Reserving `input estimate + maxTokens` before the call and settling to the actual usage after it (or
  serialising `ctx.llm()` calls) closes it.

### A17-03 An MCP read during `atlas_index` sees the graph without the edges of every re-parsed file (exposed in-process by SG34)

- **Evidence:** a 60-file index (1,260 edges); `atlas_index {force: true}` and `atlas_graph` polled while it runs:
  the graph reports **0 edges** at the yield after the parse loop, then 1,260 again when the run ends. The same
  script on the pre-SG34 tree (`d029481`) polls once and sees 1,260: the run never yielded, so no MCP request ran
  in between. Each re-parsed file's transaction deletes its symbols and so (cascade) every edge touching them;
  edges come back only in `resolveGraph`. Readers in that window: `atlas_graph` and `atlas_ask` graph expansion
  return missing callers/callees as an authoritative answer; `atlas_drift` reports docs stale (false positives).
  Other processes (`atlas serve`, a CLI `drift`) could always see this window; SG34 brings it into the MCP
  server, where an agent's parallel tool calls land in it. Search is unaffected (per-file transactions).
- **Test:** `A17-03 …` → `expected +0 to be 1260`.
- **Cause:** `runIndex` (`indexer.ts`) commits per file and yields (`yieldIfDue`) between the parse loop and the
  resolver. Options: hold MCP read tools until the queue for the DB is idle (or answer with an `indexing: true`
  marker), or keep edges until the resolve transaction replaces them (delete edges by file inside it).

## Low

### A17-04 Calls in destructuring defaults are dropped (`export const { c = make() } = obj`)

No `<module> -calls-> lib.ts::make` edge (also absent before SG31). `visitDeclarator` collects calls from the
declarator's value only; pattern defaults (and function values in them) are not walked. Test `A17-04 …` →
`expected [ …(2) ] to include 'use.ts::<module> -calls-> lib.ts::make'`.

### A17-05 A corrupt or unopenable `<db>.lock` fails with a message that does not name it

`atlas index` stops before writing (pinned), but says `atlas: file is not a database` (garbage or random lock
file) or `atlas: unable to open database file` (a directory at that path, or the project on a read-only mount),
which reads as if `.atlas/index.db` were damaged; the fix (delete `index.db.lock`) is not discoverable. Test
`A17-05 …` → `expected [Function] to throw error matching /index\.db\.lock/ but got 'file is not a database'`.

### A17-06 Notes (no test)

- After an `indexPath` edit, `atlas_index`/`atlas_ask` fail with "restart the server" (SG40) but `atlas_search`,
  `atlas_graph`, `atlas_drift` and `atlas_docs` keep answering from the old DB, which no CLI run updates any more
  (`test/mcp/server.test.ts` pins this as intended). A file added afterwards is then never listed as undocumented
  by MCP drift.
- Embedding text is read from disk in the embed phase, after the parse; a file edited in between is embedded
  from newer text than its symbol spans (pre-existing; the next run re-embeds it).
- `A13-04`, `A13-05`, `A13-06` (and the lows `A13-07`..`A13-12`) are open; their `it.fails` still fail.

## No finding (checked clean)

- **Drift:** the module prompt carries the file's content hash and an uncapped neighbourhood digest, so any edit
  or cross-file edge change flags the doc; a file changed on disk since indexing is `unindexed`; the
  architecture doc covers every path. Destructured exports (SG31) are now public symbols, so drift lists them
  as undocumented. The bare-member-name match (A1-18) is unchanged.
- **Interrupted runs:** SIGKILLs that landed in the parse loop and between parse and the run's end converge to
  the fresh-index graph (above). By code reading, a kill before the retry blanking (the failed file keeps its old
  hash, so it is re-parsed) or before pruning (the next walk prunes) is also recovered.
- **Locks across spellings:** the lock key is the real path, so a symlinked `.atlas` or DB path shares the lock
  (A13-02 stays fixed).
