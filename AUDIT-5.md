# AUDIT-5: graph and drift soundness (round 2)

Auditor: an independent subagent that wrote none of this code. Base: `1e804ae` (SG16). Date: 2026-10-21.
Bar: no false negatives. Every finding below was reproduced. Each has an `it.fails` test in
`test/audit/audit-5.test.ts` named with its ID. Each test was also run once as a plain `it`, and
all 18 failed on the assertion that names the defect. The suite stays green: `it.fails` passes
while the defect exists and turns red once it is fixed, at which point it should become `it`.

Shell repros use `node dist/cli/index.js` (`$A` below) after `npm run build`. The scratch helper
`edges.mts` was not committed. It indexed a directory with `indexRepo(..., { skipEmbeddings: true })`
and printed every edge as `src -kind-> dst`, prefixing weak edges with `WEAK`.

Summary: 0 critical, 3 high, 5 medium, 5 low.

## Critical

None found. No crashes, no writes outside `.atlas/`, and no case where the drift gate's exit code
disagreed with its own report.

## High

### A5-01 `obj.m = function m() {}` and `exports.x = function () {}` define no symbol, and their bodies leak into module scope

- **Severity:** High. Express, the repo used for external verification, builds its whole public API
  this way, so its graph is wrong where users would rely on it. A1-15 (Low) covered only the named
  `exports.x = function x() {}` case. The anonymous form and prototype or object method
  assignments are far more common, and the leak of their locals was not reported in round 1.
- **Evidence:**
  - Tests: `A5-01 obj.m = function m() {} defines a symbol…`, `A5-01 a call to an assigned method resolves across files`
    and `A5-01 anonymous exports.x = function () {}…`.
  - Express `lib/` at HEAD has 52 top-level `x.y = function` assignments, including
    `res.send`, `res.json`, `res.sendFile`, `app.use`, `app.listen` and `req.get`.
    - None of them becomes a symbol.
    - About 200 `variable` symbols are created instead. Most are function locals: `lib/response.js` alone yields 83 variables and 2 functions, for example `var opts`, `var req` and `var body` from inside the method bodies.
    - The local `var res = this` inside `res.sendFile` becomes a second top-level `res` at `lib/response.js:378`. `atlas drift` lists it as an undocumented export. `verify-external.sh express` prints it, yet the script passes because it only asserts `createApplication`.
    - Every call inside those methods is attributed to `<module>`, for example `response.js::<module> -calls-> response.js::setCharset`.
  - Express's own `examples/route-separation` shows the controller pattern `exports.index = function(req, res){…}`:
    - `site.js`, `user.js` and `post.js` have **no** function symbols.
    - `user.js` gets top-level `id`, `err` and `user` variables from inside the handlers.
- **Cause:**
  - `src/core/parse/ts.ts:434-450` handles `assignment_expression` only when the left side is `module.exports` and the function is named.
  - Otherwise `visit` returns true (`ts.ts:531`), and the `function_expression` body is walked with `VISITED_TOP` at qualifier 0.
  - Any `var`, `let` or `const` in it is recorded as a top-level variable (`ts.ts:404-409`, `:517-528`), and any nested `function_declaration` as a top-level function (`ts.ts:412-417`).
  - `collectCjsExport` (`ts.ts:591-601`) records the export name but pushes no symbol.

### A5-02 tsconfig `paths` and `baseUrl` aliases and workspace packages never resolve: every such edge is weak, and drift cannot see their neighbourhood

- **Severity:** High. `create-next-app` scaffolds the `@/*` alias by default, and most TS monorepos
  import sibling packages by name. In such repos nearly every cross-file import, call and heritage edge is
  weak. The resolved neighbourhood that drift hashes (`context.ts:53-68` joins only edges with a
  `dst_symbol`) is therefore empty, so a caller switching callees never makes the callee's doc stale.
- **Evidence:**
  - The test `A5-02 tsconfig paths aliases…` gives:
    - `WEAK src/app/page.ts::<module> -imports-> null {"module":"@/lib/util",…}`
    - `WEAK src/app/page.ts::page -calls-> null {"name":"util"}`
  - The test `A5-02 workspace package imports…` behaves the same for `@acme/utils` with `workspaces: ["packages/*"]`.
  - The drift test `A5-02 an aliased caller switching callee…` changes `page()` from calling `foo()` to calling `other()`.
    - With `--skip-architecture` the result is `stale = ['src/app/page.ts']` only.
    - `src/lib/util.ts` stays fresh, even though its incoming calls changed. The same edit through a relative import marks it stale.
- **Cause:** `src/core/graph/resolver.ts:396` returns null for any specifier that does not start with
  `.` or `/` ("package, not indexable"). Nothing in `src/` reads `tsconfig.json`/`jsconfig.json`
  (`compilerOptions.paths` and `baseUrl`), and nothing maps `package.json` `workspaces` or `name`/`main`/`exports` to indexed files.

### A5-03 Directories named `build`, `dist`, `coverage`, `.cache`, `venv` and similar are skipped at any depth, with no override

- **Severity:** High.
  - A realistic repo loses whole source packages from the index, with no warning.
  - Edits there are invisible to drift: no doc, no "undocumented" entry and no architecture change.
  - Imports into those packages are weak.
  - Config cannot restore them, because `include` only filters files and `exclude` only adds rules.
- **Evidence:**
  - Tests: `A5-03 source directories named build…` (`src/build/compile.ts` is absent from `files`, and `run -calls-> compile` is weak) and `A5-03 an edit under src/build/ is reported by drift` (report not failing, nothing listed).
  - Real repo: in pip at HEAD, `src/pip/_internal/operations/build/` holds 6 tracked `.py` files that `git check-ignore` says are **not** ignored.
    - After `$A index pip`, `SELECT count(*) FROM files WHERE path LIKE '%/build/%'` returns 0.
    - 12 files have 14 weak import edges to `pip._internal.operations.build.*`.
  - Next.js keeps its build pipeline in `packages/next/src/build/` in the same way.
- **Cause:** `src/core/ingest/walker.ts:38-50` (`ALWAYS_SKIP`) is applied to every directory name at every
  depth (`walker.ts:100`), before `.gitignore` or config. The default config `exclude`
  (`config.ts:21-23`: `dist/**`, `build/**`, `coverage/**`) is already root-anchored, which is the
  behaviour this list was presumably meant to have.

## Medium

### A5-04 Functions passed as values produce no edge; the `references` edge kind is never emitted

- **Evidence:** the test `A5-04 a function passed as a value…`.
  - `app.get('/users', users.list)` and `r.get('/u/:id', users.view)`, where `users = require('./users')`, produce no edge to `users.js::list` or `users.js::view`, not even a weak one. Only the module-level import edge exists.
  - The same holds for callbacks (`arr.map(fmt)`), `{ handler: fn }`, JSX props (`component={Button}`), and type annotations (`x: Options`).
  - CLAUDE.md §5 lists `references` as an edge kind, and `EdgeKind` declares it (`src/core/db/types.ts:10`), but no code path produces it.
- **Why Medium, not High:** with named ESM imports, the import edge already points at the symbol. Only references through a module or namespace binding, and same-file references, are lost entirely.
- **Cause:** `RefKind` is `'calls' | 'extends' | 'implements'` (`src/core/parse/types.ts:25`). The parser records only `CALL_NODES` (`ts.ts:167-172`) and heritage. Identifiers in argument or value position are never collected.

### A5-05 TS `namespace` / `module` / `declare module` bodies are flattened into top-level symbols

- **Evidence:** the test `A5-05 …`. Two namespaces, `Circle` and `Square`, each export `area()`.
  - The output is two unqualified top-level `function area` symbols and no `Circle` symbol.
  - `import { Circle } from './geo'; Circle.area()` gives a weak edge.
  - `import { area } from './geo'` would wrongly resolve to whichever `area` comes last.
- **Cause:** `visit` (`ts.ts:396-531`) has no case for `internal_module` / `module`. The walk descends at qualifier 0, and inner `function_declaration`s are pushed as top-level functions.

### A5-06 Anonymous default exports (`export default class extends Base {…}`, `export default function () {}`) lose their heritage and leak their members

- **Evidence:** the test `A5-06 …`.
  - `shape.ts` gets a top-level `method area` and no class.
  - There is no `extends` edge to `base.ts::Base`.
  - In the consumer, `import Shape from './shape'; new Shape()` is weak.
  - For `export default function () { util() }`, the call is attributed to `<module>`, and `import AnonFn …; AnonFn()` is weak.
- **Cause:**
  - The anonymous class is a `class` node in `export_statement.value`, but `CLASS_NODES` holds only declarations (`ts.ts:33`), and the `value` branch handles only `object` (`ts.ts:452-464`). The body is then walked at qualifier 0, where `method_definition` pushes unqualified methods (`ts.ts:478-483`).
  - Nameless `FN_NODES` push no symbol (`ts.ts:412-415`), and `collectExports` registers a default only when the declaration has a name (`ts.ts:643-646`).

### A5-07 Python `src/` layout: tests, scripts and anything outside the package cannot resolve absolute imports

- **Evidence:** the test `A5-07 …`. The repo has `src/mypkg/{__init__,core}.py` and `tests/test_core.py`.
  - `from mypkg.core import helper; helper()` gives `WEAK … -imports-> null {"module":"mypkg.core",…}` and a weak call.
  - The src layout is the PyPA-recommended layout.
- **Cause:** `resolvePython` (`resolver.ts:421-445`) searches only the repo root and the *importing* file's own package root. It never searches other top-level package roots such as `src/`, and it never reads `pyproject.toml` or `setup.cfg` for a package dir.

### A5-08 A persisted doc whose front matter does not parse (e.g. a UTF-8 BOM) is silently dropped, so its file is never checked for staleness

- **Evidence:** the test `A5-08 …`.
  - After an edit to `a.ts`, `drift --docs-dir` reports `a.ts` stale.
  - Prefix `files/a.ts.md` with a BOM, as Windows Notepad and some editors do on save, and the result is `stale = []`. `a.ts` is now only "undocumented", which does not fail the gate without `--strict`.
  - A hand edit that breaks the front matter has the same effect. A1-08 (CRLF) belongs to the same class of defect.
- **Cause:**
  - `src/core/synth/persist.ts:44-46`: `^---\n` does not match after `﻿`, so `parse` returns null.
  - `readPersistedDocs` (`persist.ts:128-135`) drops it with no warning or error.
  - `detect.ts:116-123` then treats the file as having no doc.

## Low

### A5-09 `ci-comment` counts the page it was given, not the report totals

- **Evidence:**
  - Test: `A5-09 …`.
  - Command: in a repo with 3 stale docs, `$A drift --limit 1 --json > d.json` exits 2 with `totals.stale = 3`. `$A ci-comment --in d.json` then renders `**Drift check: failed** (1 stale doc(s))` and `### Stale docs (1)`.
  - With `--offset` past the end, the comment says `failed ()`.
  - CI does not pass `--limit` today, so its comment is complete. The exit code and `failing` are correct.
- **Cause:** `src/cli/commands/ciCommentCmd.ts:45-47,57-58,70-83` use `report.stale.length` and `report.undocumented.length` instead of `report.totals`, and do not mention `truncated`.

### A5-10 Content hashes are taken over UTF-8-decoded text, so edits to non-UTF-8 bytes are invisible

- **Evidence:** the test `A5-10 …`.
  - A Latin-1 `legacy.py` edited from `"café"` (0xE9) to `"cafè"` (0xE8) decodes to the same `U+FFFD` both times.
  - Re-index reports the file as `skipped` (unchanged), and both drift modes report it fresh.
  - The same applies to any byte change inside an invalid UTF-8 sequence, such as identifiers or strings in legacy-encoded files.
- **Cause:** `src/core/ingest/indexer.ts:99,110` and `src/core/drift/detect.ts:190-194` hash `readFileSync(…, 'utf8')`. Hashing the raw `Buffer` would fix both.

### A5-11 DB-mode drift before re-indexing misses the deletion of a file with no symbols

- **Evidence:** the test `A5-11 …`.
  - Delete `barrel.ts` (`export * from './a'`), then run `detectDrift` without re-indexing. The result is `stale = []`.
  - A deleted file *with* symbols is reported, but only because its snippets disappear from the prompt.
  - MCP and dashboard drift read the index without re-indexing.
- **Cause:** `indexedContentChanged` (`src/core/drift/detect.ts:187-195`) returns false on any read error, including `ENOENT`. A missing file could be reported as `missing`.

### A5-12 `f.call()` / `f.apply()` / `f.bind()` and `super()` give no resolved edge

- **Evidence:** the test `A5-12 …`.
  - `foo.call(null)` gives `WEAK … -calls-> null {"name":"call","object":"foo"}` and no edge to `a.ts::foo`.
  - `super()` in a constructor gives no edge to the parent class or its constructor. `super.m()` already works.
- **Cause:** `targetOf` / `targetAt` (`ts.ts:196-219`, `:272-301`) take the property as the callee, and they have no case for a callee of type `super`.

### A5-13 `from . import sub` in a package `__init__.py` adds a self-import edge

- **Evidence:** the test `A5-13 …`. The edge `pkg/__init__.py::<module> -imports-> pkg/__init__.py::<module>` appears next to the correct edge to `pkg/sub.py`. This is a false positive that adds a self-loop to the module graph and its degree.
- **Cause:** `resolver.ts:240-245`. The "imported through a barrel" edge is emitted to `target`, which here is the importing file itself.

## Re-verified (AUDIT-1)

`npm test` (347 tests) runs `test/audit/audit-1.test.ts` against this commit.

- **Still fixed:**
  - These tests pass as plain `it`: A1-01 (TS barrels, the barrel's own edges, Python `__init__`), A1-02 (default and CJS), A1-03, A1-04 (TS, Python and drift), A1-05, A1-06, A1-07, A1-08, A1-09, A1-10 (all four), A1-12 and A1-17.
  - A1-13: diagnostics are returned.
  - A1-20: `.atlas/config.json` is committed and un-ignored.
- **Still open, as recorded:**
  - A1-11, A1-14, A1-15, A1-16 and A1-18 remain `it.fails`, and they still fail.
  - A1-15 is subsumed and escalated by A5-01.
  - A1-19 (unbound calls dropped) is unchanged policy (`resolver.ts:342-343`).
  - `atlas index` still exits 0 when files fail. Drift compensates through the "unindexed" check (SG11).

## No finding (checked clean)

- **SG16 walk equivalence.** The pre-SG16 parser (`51bbe95:src/core/parse`) and the current one were run over 10,937 real files: every JS/TS/MJS/CJS/`.d.ts` file under `node_modules` (up to 400 KB) plus the CPython 3.11–3.13 stdlib.
  - Symbols, imports, references (with order) and internal-failure diagnostics were identical for every file, with 0 diffs.
  - The cursor walk, peeked calls, cached node types and the native `descendantsOfType` path above 100 descendants skip nothing that the old walk handled.
  - The corpus has no `.tsx`. `fixtures/parse` and `golden.json` cover it.
- **TS/JS constructs that resolve:**
  - Imports and exports: re-exports (`export *`, `export * as ns`, `export { default as B }`, `export { x as y }` of an imported name), default imports through barrels, `import type`, and dynamic `import()` (import edge).
  - Classes: interface `extends` with multiple bases, `implements`, abstract classes, `this.m()` to an inherited method, getters and setters, `#private` methods, constructors, overloads, static blocks and field initialisers.
  - Other: object-literal methods, TSX components (`<Impl2 />`), and calls inside JSX attributes.
- **Python constructs that resolve:**
  - Imports: relative and absolute imports, `import a.b as x`, `pkg.Engine()` via `__init__`, and conditional and `try` imports (weak when missing).
  - Calls and bases: attribute bases (`core.Base`, `pkg.core.Base`), `metaclass=` keyword, calls in comprehensions, lambdas, `async` and `with` blocks, and functions defined under top-level `if`.
- **SG15 paging.** `failing`, `hasDrift` and `totals` come from the full report (`detect.ts:169-184`). With `$A drift --limit 1` on 3 stale docs, and with `--offset 5`, the CLI exits 2. MCP pages the same full report. The only miscount is A5-09.
- **SG17 unreadable paths** (by code reading; this sandbox runs as root, so `chmod 000` is not enforced):
  - Rows under an unreadable directory or file are kept, not pruned (`indexer.ts:83-91`).
  - In DB mode their docs still go stale when snippets can no longer be read, unless the file has no symbols (see A5-11).
  - In CI the index is fresh, so a persisted doc for an unreadable file is reported `missing`.
  - A deletion can stay hidden only while its directory stays unreadable. The next readable walk prunes it.
- **Tombstones:**
  - DB-mode deletion is reported with `--skip-architecture` (A1-17 test).
  - A tombstone whose path is re-added is superseded by the live file (`detect.ts:85-88`).
  - Tombstones are cleared only by `atlas docs`.
- **Renames, extension changes and case-only renames** become a delete plus an add. The old doc is reported `missing` in persisted mode and as a tombstone in DB mode.
- **CRLF:**
  - Source CRLF↔LF changes the content hash, so the doc goes stale (conservative).
  - CRLF docs are parsed (A1-08).
- **`.gitignore` and config changes.** Newly ignored or excluded documented files are pruned, then reported stale or missing. Nested `.gitignore` files are not read (`walker.ts:52-63`), which only causes extra indexing (false positives).
- **Symlinks.** Symlinked files and directories are never followed (`walker.ts:99-103` check `isDirectory()` and `isFile()` on the dirent). A target inside the repo is indexed under its real path. A target outside the repo is not indexed. This is consistent and documented by the walker's behaviour; it is not a drift false negative.
- **Neighbourhood hash.** Every resolved cross-file edge in both directions, including module-level imports and weak edges with a module `dst`, is hashed without a cap (`context.ts:107-112`). Retargeting a call through a changed barrel makes the consumer stale.
- **External repos.** `bash scripts/verify-external.sh express` and `… got` both pass.
