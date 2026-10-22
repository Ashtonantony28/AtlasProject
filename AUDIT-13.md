# AUDIT-13: soundness (round 4, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `701d847` (AUDIT-12 merge, after SG25–SG29) on
`claude/atlas-audit-13`; every result below was re-run on `69c1150` (SG30 merged; it changes only
`src/core/ingest/walker.ts`) with identical numbers. Date: 2026-10-22.

Question: can Atlas silently miss something it claims to capture, or report something stale as current? Scope:
TS/JS/Python symbol extraction with SG26's callback-scope rules (module wrappers, getter/`defineProperty`
methods, chained aliases, `as const`/`satisfies`, CommonJS export chains, Python `__all__ +=`), SG27's Python root
index and `PathsMatcher`, SG25's incremental freshness (`EXTRACTOR_VERSION`, `resolverFingerprint`,
`maxFileBytes`), SG29's per-DB index queue, SG28's budget cap and drift. The walker's nested-`.gitignore`
re-include issue (A12-01, fixed by SG30) was skipped. AUDIT-9's fixes (A9-01, A9-02, A9-07, A9-11, A9-12) were
re-checked first.

Method:
- **Ground truth on real repos** (read-only clones in the scratchpad: express, got, trpc, create-t3-app, flask,
  attrs; nothing written into them: indexes went to scratch DBs via `indexRepo`, CLI runs used copies).
  - **Exports vs the TypeScript compiler**: `checker.getExportsOfModule` (with `allowJs`, CommonJS inference) for
    every JS/TS file vs Atlas's exported symbols plus local-export rows: express 102, got 188, t3 344, trpc 3,035
    tsc exports.
  - **Python vs `ast`** (`python3 -I`): every top-level binding (incl. under `if`/`try`/`with`) and the public set
    (`__all__` literal, `+=`, `.extend`, `.append`, else the naming rule) on flask (726) and attrs (569).
  - **Callback-local leak** re-measured with `sg26/leak.mjs` (tree-sitter re-parse).
  - **SG26 before/after**: express, got, trpc and t3 indexed by `75dd831` (pre-SG26, built from `git archive`)
    and by this build; distinct resolved (src file, kind, dst symbol) triples and import rows compared.
  - **SG27 equivalence**: the pre-SG27 `ModuleResolver` (`75dd831`) and this one on every import row of all six
    repos (11,489 lookups incl. Python submodule lookups), plus two randomised fuzzers: Python layouts
    (pyproject/setup.cfg/setup.py roots, `src/`, `.pyi`, nested and namespace packages; 284,616 lookups) and
    tsconfig `paths` (exact/wildcard/suffix/duplicate patterns, with and without `baseUrl`; 84,000 lookups, of
    which 8,303 also checked against `ts.resolveModuleName`).
  - **Concurrency**: two `atlas index` processes on a copy of got, start staggered by 0–1.2 s.
- **Adversarial fixtures** for each SG26 rule (16 wrapper shapes, 13 `defineProperty`/getter shapes, 13 chain
  shapes, 12 `as const`/`satisfies` shapes, 7 `__all__` shapes, 8 CommonJS export shapes); tsc as the oracle
  where it has an opinion.

Repros are in `test/audit/audit-13.test.ts`. An `it.fails` asserts the correct behaviour; each was run once as a
plain `it` and fails on the assertion that names its defect. Plain `it` blocks pin what was checked and holds.
Shell repros use `$A` = `node dist/cli/index.js` after `npm run build`.

**Summary: 0 critical, 3 high, 3 medium, 6 low.** AUDIT-9's A9-01, A9-02, A9-07, A9-11 and A9-12 hold, on the
fixtures and on the real repos.

## Re-verified (AUDIT-9 fixes)

| ID | Evidence on real repos |
| --- | --- |
| A9-01 | express index written by `75dd831` (extractor v1), then a plain index with this build: `extractorUpgrade {from:1,to:2}`, 141 files re-parsed, 764 symbols, identical to a fresh index; the run after it is a no-op. |
| A9-02 | callback locals among top-level variables/functions: express 0/547, got 0/486, trpc 0/2,240, t3 0/405 (AUDIT-9: 69%, 90%, 61%, 0%). |
| A9-07 | `as const`, `satisfies`, `as const satisfies` members are qualified and exported; `export default {…} satisfies X` gives `default.fetch`, not a top-level method. |
| A9-11 | express `lib/application.js` 17/33 exported (all 16 `app.*` methods and `app`; the rest are `require` bindings and two private helpers), `lib/response.js` 23/46. |
| A9-12 | `req.get`, `req.header`, `res.contentType`, `res.set`, `res.header` are symbols. |

## Critical

None found. No import resolved to a wrong file: the SG27 resolver gave the pre-SG27 answer on every one of
380,105 real and fuzzed lookups, and `tsc` agreed on all 8,303 fuzzed `paths` lookups it resolved.

## High

### A13-01 Destructured top-level declarations define no symbol: `export const { auth, handlers } = NextAuth(…)` is invisible

- **Severity:** High. A whole declaration form is dropped with no diagnostic: no symbol, every named import of it is
  a weak `imports` edge to `<module>`, every call of it is weak, and drift can never list it as undocumented. It
  is the documented entry point of NextAuth v5 (`auth` is called on every protected page) and of tRPC v11's
  `createTRPCContext` (`TRPCProvider`, `useTRPC`).
- **Evidence:**
  - tsc oracle: trpc 14 of 3,035 exports and t3 7 of 344 are destructured (`GET`/`POST` route handlers,
    `auth`/`handlers`/`signIn`/`signOut`, `TRPCProvider`/`useTRPC`, `api`/`HydrateClient`). In trpc, they are
    **4 of 4** named imports that fall back to a weak `<module>` edge: the last cause left.
  - Python: `release, version = get_version()` (flask `docs/conf.py`) defines neither name; flask's only 2
    misses of 726 top-level bindings vs `ast`.
  - Test `A13-01 …` (TS object pattern with rename, Python tuple target).
- **Cause:** `visitDeclarator` (`src/core/parse/ts.ts:891-893`) returns after `collectCalls` when the name is not an
  `identifier` (`object_pattern`, `array_pattern`); `py.ts` `visit` records only `left.type === 'identifier'`.

### A13-02 Two `atlas index` processes on one index duplicate symbols permanently (SG29 serialises only in-process)

- **Severity:** High: A11-02's impact (duplicated search hits, symbols, graph nodes, retrieval snippets; kept until
  `--force`) through a different door: an editor's long-running `atlas mcp` and a terminal `atlas index`, or a
  git hook.
- **Evidence:** got copy, two `atlas index` processes, the second started 0.3/0.6/0.9 s after the first: one exits
  with `atlas: database is locked` **after** committing some files, the other prints success with
  `symbols=1089`/`1118`/`1094`/`1126` instead of 1,080 (all duplicates of real rows, e.g. `test/https.ts`
  `closeServer` ×2). The next plain `atlas index` prints `edges: 3138 (graph unchanged)` and keeps them. Started
  together (0 s) or 1.2 s apart, one fails cleanly: AUDIT-11's "on the CLI one fails at once" holds only then.
  - Test `A13-02 …`: the same race in one process through a symlinked path to the same DB file (the queue key is
    `path.resolve(db.name)`, which does not resolve symlinks): `expected 18 to be 12`.
- **Cause:** `runIndex` (`src/core/ingest/indexer.ts:137-146`) snapshots `files` once; for a path the snapshot lacked it
  deletes nothing and `upsertFile` then reuses the row the other run inserted, appending a second set of symbols,
  imports and refs (`:218-266`). The queue (`:95-108`) is per process and per path string. Deleting the path's
  existing rows inside the per-file transaction (by path, not by snapshot) fixes both doors; a run-level lock
  (`BEGIN IMMEDIATE` or a lock file in `.atlas/`) also makes the loser wait instead of half-failing.

### A13-03 An index run interrupted between parsing and resolving leaves a stale graph that the next run calls current

- **Severity:** High. Ctrl-C, a CI timeout, an OOM kill, or any exception from `resolveGraph` after the parse loop
  commits leaves the new file hashes with the old edges, and from then on `atlas index` prints
  `(graph unchanged)` until some file changes again. Edges of re-parsed files are gone (cascade), and edges whose
  resolution changed stay **wrong**, not just missing. Local drift, MCP and the dashboard serve that graph.
- **Evidence:** test `A13-03 …`: `src/a.ts` imports `./util` (→ `src/util/index.ts`); adding `src/util.ts` changes the
  target (tsc agrees). With the resolver interrupted once, the next plain run keeps
  `src/a.ts::a -calls-> src/util/index.ts::f` and `resolveReason` is null. A CLI SIGINT repro on a trpc copy did not
  land in the window (resolve is ~0.4 s and synchronous), so the test injects the interruption.
- **Cause:** `runIndex` writes each file's hash in its own transaction (`indexer.ts:218`) and decides to re-resolve
  only from this run's counters and the last **finished** run's fingerprint (`:305-309`, `lastState` reads
  `finished_at IS NOT NULL`). An unfinished run row after the last finished one is the signal it ignores: when
  present, re-resolve (or store a "graph dirty" flag set before the parse loop and cleared by the resolve
  transaction).

## Medium

### A13-04 A CommonJS export of a non-function value is no symbol (`exports.json = bodyParser.json`)

- **Evidence:** `export const wetag = make()` is a variable symbol and `import { wetag }` resolves; the CommonJS
  form `exports.wetag = make()` defines nothing. tsc oracle on express: 13 of 102 exports missing, all of this
  kind (`express.json`, `.raw`, `.static`, `.text`, `.urlencoded`, `.Route`, `utils.methods`, `utils.wetag`, plus
  value exports in `examples/mvc`). **19** `express.json()`/`express.static()`/… calls in express are weak. Test
  `A13-04 …`.
- **Cause:** `defineValue` (`ts.ts:624-625`) returns false unless the value is a function or class, and nothing else
  defines `exports.x` / `module.exports.x` for other values.

### A13-05 Calls through a default `require` binding with no resolvable default resolve to the importer's own binding variable

- **Evidence:** `const debug = require('debug'); debug('x')` gives a **strong** `main -calls-> use.js::debug` (the
  `require` binding itself); ESM `import debug from 'debug'` gives a weak edge. Same for an internal module whose
  default is a call result (`module.exports = make()`). express: **159** such edges in 104 files (`logger()`,
  `cookieParser()`, `session()`, …), 22% of its 714 resolved edges; pre-SG26 builds have them too (167). Weak
  counts understate unresolved calls and Q&A expansion follows a `variable` that is a `require` call. Test
  `A13-05 …`.
- **Cause:** `const x = require(…)` is also a top-level `variable` symbol (`visitDeclarator`), and the resolver's
  same-file lookup wins when the import binding resolves to no symbol.

### A13-06 CommonJS exports inside an IIFE/UMD wrapper or a top-level `if` are not exported

- **Evidence:** test `A13-06 …`; tsc reports all three as exports. SG26 now makes a wrapper's declarations
  symbols, but `exports.format = format` / `exports.direct = function …` inside `;(function(){…})()` and
  `if (typeof module !== 'undefined') module.exports.g = g` leave them `exported = 0`, so a UMD or wrapped-CJS
  library's API never counts as public for drift. `Object.assign(module.exports, {…})` exports nothing either
  (no test; absent from the six repos).
- **Cause:** `collectExports` (`ts.ts:993-1038`) reads only the root's direct `expression_statement`s.

## Low

### A13-07 `export default <expression>` defines no `default` symbol

tsc oracle: trpc 58 and t3 20 misses (Next.js `_app.tsx` `export default api.withTRPC(MyApp)`, API routes
`export default createNextApiHandler({…})`, every `defineConfig({…})`). Such a file has no exported symbol;
`import d from './g'; d()` is weak. Test `A13-07 …`. Cause: the `export default` branch (`ts.ts:798-813`) defines
only function/class values and opens a scope for objects.

### A13-08 A class declared in a callback loses its `extends` edge (SG26 regression)

got `test/hooks.ts -extends-> source/core/errors.ts::RequestError` and trpc's 3 test `extends TRPCError` /
`TRPCClientError` edges existed before SG26 and are gone; callback bodies contribute calls and values to the owner,
not heritage. Import/call edges to the base remain. Test `A13-08 …`.

### A13-09 The `defineGetter`-shape rule defines a method for any `f(obj, 'name', fn)` call

`emitter.on(req, 'data', function onData() {})` defines an exported `req.data`. The rule (`definedProperty`,
`ts.ts:562-596`) checks argument shape only, any callee. Also missed: `set` accessors, `defineProperties`,
template-literal names, `defineProperty(exports, …)` (tsc's CJS re-export emit). Test `A13-09 …`.

### A13-10 `__all__.extend([...])` / `.append(...)` and `__all__ +=` under a top-level `if` are ignored

`b` and `c` stay unexported while `__all__ = ['a']` makes everything else private. Test `A13-10 …`. Cause:
`literalAll` (`py.ts`) reads only direct `assignment`/`augmented_assignment` statements.

### A13-11 A method assigned inside a declarator chain is not defined

`const s1 = res.s1 = function () {}` defines only variable `s1` (no `res.s1`); `var debug = module.exports.debug =
function debug() {}` is a `variable`, not a function. `visitDeclarator` does not run `visitAssignment` on the
value chain. Test `A13-11 …`.

### A13-12 The budget is enforced on a 3 chars/token estimate, so dense prompts overspend

`budgeted`/`affordableMaxTokens` cap `max_tokens` to `remaining - chars/3`. With 6,000 CJK characters (~5,000 real
tokens) and an 8,000 cap a call spends 11,000. Code prompts are denser than 3 chars/token only when they carry
non-Latin docstrings or comments; the overrun is bounded by one prompt's estimate error. Test `A13-12 …`.

### A13-13 Notes (no test)

- Module-wrapper shapes not recognised (locals not symbols, so false negatives only for code written this way):
  `new function () {…}()`, `(function () {…}).bind(this)()`, `(0, function () {…})()`. A callback passed to an
  IIFE that is not a factory (`(function (cb) {…})(function () { var x })`) is treated as a module body.
- `({…}) as const`, `<const>{…}`, `{…}!` lose their members; `const f = (() => 1) as Handler` is a `variable`.
- `atlas docs` with modules skipped for budget exits 0 (they are listed as `skipped`, and drift then reports
  them stale, so nothing is silent).
- `EXTRACTOR_VERSION` is bumped by hand; a grammar upgrade (`tree-sitter-*`) that changes CSTs needs the same bump
  and only the fixture golden test would notice.

## No finding (checked clean)

- **SG26 module wrappers**: rollup UMD (`(function (g, f) {…}(this, (function () {…})))`), `!function(){}()`,
  `.call(this)`, arrow and async-arrow IIFEs, AMD `define` with id and deps keep their declarations; `describe`
  callbacks, IIFEs nested in callbacks, AMD `require([...], cb)`, `foo.define(cb)` and assigned-then-called
  functions keep their locals out (pinned). No import row was lost by SG26 on four repos (express gains the
  `application.js` default row).
- **Getters**: `defineGetter(obj, 'x', fn)`, `defineProperty` `get`/`value` (method, `get:` function or arrow),
  `Reflect.defineProperty`, nested owners (`req.sub.deep`) define methods without leaking their locals (pinned).
- **SG27**: 0 differences from the pre-SG27 resolver on 11,489 real and 284,616 fuzzed Python lookups and 84,000
  fuzzed `paths` lookups; 0 disagreements with `ts.resolveModuleName` on 8,303; precedence (exact, longest prefix,
  first on a tie, suffix check) pinned against tsc.
- **Python extraction**: 0 missing exports and 0 wrong exports vs `ast` on flask and attrs.
- **SG25**: upgrade re-parse (A9-01 above); an `extends` target in a directory with no indexed file is fingerprinted
  and editing it re-resolves (pinned); oversized files are counted and reported by the CLI (`1 file over the
  1048576-byte cap not indexed`).
- **SG29**: parallel runs through one DB path leave one copy (pinned).
- **SG28**: `max_tokens` is capped to the remaining budget and an unpayable call is refused (pinned); see A13-12.
- **Drift**: unchanged since AUDIT-9; A13-03 is the only new way for local drift to serve a stale graph.
