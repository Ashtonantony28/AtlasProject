# AUDIT-9: encoding soundness (round 3, no false negatives)

Auditor: an independent subagent that wrote none of this code. Base: `f65410c` (SG18, after SG19–SG24) on
`claude/atlas-audit-9`. Date: 2026-10-22.

Question: can Atlas silently miss something it claims to capture? Scope: symbol extraction (TS/JS/Python), edge
resolution (imports, calls, heritage, `references`, re-exports, tsconfig `paths`/`baseUrl`, workspaces, Python
layouts), incremental indexing, drift, and the walker. SG18–SG24 were checked first.

Method:
- **Ground truth on real repos** (shallow HTTPS clones, read-only, in the scratchpad): express, got, trpc (pnpm
  monorepo, 1,058 files), create-t3-app, flask (src layout), attrs (src layout).
  - Walker vs `git ls-files` on all six.
  - Atlas's `ModuleResolver` vs the TypeScript compiler's `ts.resolveModuleName` (with each file's own
    `tsconfig.json` parsed by `ts.parseJsonConfigFileContent`) for every JS/TS import row: 9,418 imports.
  - Python: every internal import (relative, or whose top-level package exists in the repo) on flask and attrs.
  - tree-sitter re-parse of every JS/TS file to find top-level symbols that are really function locals.
  - Upgrade path: express indexed by the pre-SG18 build (`0680211`, built from `git archive`), then by this one.
- **Adversarial fixtures** for each construct below, indexed with `indexRepo(..., { skipEmbeddings: true })`, and
  `tsc --traceResolution` where TS semantics were in doubt.
- **Mutation**: 22 hand mutations of SG18–SG20 and drift code paths, one at a time against the full suite
  (see [Mutation results](#mutation-results)); `git diff -- src` empty after each.

Repros are in `test/audit/audit-9.test.ts`. An `it.fails` asserts the correct behaviour and was run once as a plain
`it`; each fails on the assertion that names its defect. A plain `it` pins behaviour checked and found sound, or
kills a surviving mutant. Shell repros use `$A` = `node dist/cli/index.js` after `npm run build`.

Load note: AUDIT-10 (performance) ran in another worktree on the same machine; load average 1–6 during this audit.
Nothing here depends on timing.

**Summary: 0 critical, 2 high, 9 medium, 3 low.**

## Critical

None found. On the four real repos with a resolvable TS setup, Atlas and `tsc` disagreed on **0** of 9,418 import
resolutions where both resolved a file; on trpc every one of the 258 workspace-package imports that tsc could not
resolve (no `node_modules` in the clone) was resolved by Atlas to the right `src/` entry, and none of the `@trpc/*`
imports was left unresolved. No import resolved to a wrong file.

## High

### A9-01 Upgrading Atlas never re-parses unchanged files: SG11/SG18 extraction fixes are invisible on an existing index

- **Severity:** High. A stale result after the most common workflow there is (update the tool, run `atlas index`),
  with a message that says nothing changed. Every parser fix since migration v5 (SG11, SG18) is affected.
- **Evidence:**
  - Express indexed by the pre-SG18 build, then `$A index .` with this build:
    `edges: 1554 (graph unchanged)`, `totals: files=141 symbols=2052 imports=417 edges=1554`. That is the old graph:
    no `res.send`/`app.use` methods, ~200 leaked locals (A5-01), no `references` edges.
  - `$A index . --force` then gives `symbols=1992 imports=418 edges=1613`, the SG18 numbers in PLAN.md.
  - Local DB-mode drift, MCP and the dashboard keep serving the old graph. Docs regenerated locally from it carry
    prompt hashes that CI's fresh index never reproduces, so CI then reports them stale.
  - Test: `A9-01 an index written by an older extractor is re-parsed after an upgrade, without --force` (simulates a
    v5 index whose rows the pre-SG18 parser wrote).
- **Repro:** `git archive 0680211 | tar -x -C old && (cd old && ln -s $PWD/../node_modules . && npx tsc -p .)`;
  `node old/dist/cli/index.js index express && $A index express` prints "graph unchanged".
- **Cause:** `src/core/ingest/indexer.ts:110-115` skips any file whose content hash matches; the only thing that
  ever invalidates stored parse results is a migration doing `UPDATE files SET content_hash = ''`
  (`src/core/db/schema.ts:172,184`, v4 and v5). SG11 and SG18 changed extractor output with no migration. Nothing
  records which extractor version wrote a row, so a fix has to remember a migration every time. A stored extractor
  version (reparse when it differs) would make this automatic.

### A9-02 Locals of functions passed as callbacks at module level become top-level symbols, and can capture a real symbol's edges

- **Severity:** High. Same class as A5-01 (High), but SG18 fixed only the assignment form. The callback form is in
  every test file (`describe(() => { const x … })`), every route handler (`app.get('/', (req, res) => { … })`),
  and express's own `lib/request.js`.
- **Evidence (tree-sitter re-parse of every JS/TS file; "leaked" = the declaration's nearest function ancestor is
  not an IIFE):**

  | Repo | Top-level `variable`/`function` symbols | Actually callback locals | Files |
  | --- | --- | --- | --- |
  | express | 1,789 | 1,242 (69%) | 83 |
  | trpc | 5,683 | 3,443 (61%) | 192 |
  | got | 5,047 | 4,561 (90%) | 45 |
  | create-t3-app | 405 | 0 | 0 |

  - Express `lib/request.js` defines 12 getters as `defineGetter(req, 'protocol', function protocol(){ var proto …;
    var trust …})`. None of `req.protocol`, `req.ip`, `req.query`, … is a symbol; their locals (`proto`, `trust` ×3,
    `header`, `index`, `queryparse`, `addrs`, …) are top-level variables of `lib/request.js`.
  - Same-file calls resolve to the leaked locals: 10 call edges in express, 208 in trpc and 186 in got point at a
    callback's local variable.
  - A local that shares a top-level name wins (`byQName`/`exportsByName` keep the last symbol): with
    `function render(){}` at line 1 and `var render = …` inside a route handler at line 4,
    `use.js::page -calls-> lib.js::render` targets the **variable at line 4**, which is also flagged exported.
  - Tests: `A9-02 locals of a callback passed at module level are not top-level symbols` and
    `A9-02 a callback local that shares a top-level name does not capture its incoming edges`.
- **Cause:** `visit` returns true for call nodes (`src/core/parse/ts.ts:625`, falls through to `:719`), so the walk
  descends into call arguments with `ctx.qualifier` still empty. A `lexical_declaration`/`variable_declaration` there
  is recorded as top-level (`ts.ts:705-717`) and a `function_declaration` as a top-level function (`ts.ts:597-602`).
  SG18's `atModuleLevel` (`ts.ts:509-520`) guards only `visitAssignment`.

## Medium

### A9-03 A config-only change (tsconfig `paths`/`baseUrl`, `workspaces`, `main`/`exports`, pyproject) leaves edges stale, or wrong, until `--force`

- **Evidence:** tests `A9-03 a tsconfig paths change alone …` and `A9-03 adding workspaces to package.json alone …`.
  - Retarget `@/lib/util` to `other.ts` in `tsconfig.json`: the next `atlas index` reports `indexed=0` and keeps
    `page -calls-> src/lib/util.ts::util`, which is now **wrong**, not just missing. Same for adding `workspaces`
    (edges stay weak) and changing a workspace package's `main` (edge keeps the old file).
  - `--force` fixes all three. Local drift and MCP are affected; CI is not (fresh index).
  - DECISIONS.md (SG19) records this as a known gap, but `atlas index` prints "graph unchanged" with no hint.
- **Why Medium:** config-only commits are rarer than source edits, which already trigger a full re-resolve.
- **Cause:** `src/core/ingest/indexer.ts:207-211` re-resolves only when a source file changed or was removed. The
  config files `ModuleResolver` reads (`src/core/graph/modules.ts`) are neither walked nor hashed.

### A9-04 Relative and aliased imports of `.d.ts` modules never resolve

- **Evidence:** test `A9-04 …`. `import { Shape, helper } from './types'` with only `src/types.d.ts` gives weak
  imports, a weak `implements` and a weak call; `tsc` resolves it to `types.d.ts`. Hand-written `types.d.ts`,
  `env.d.ts` and `global.d.ts` modules are common in TS apps. Ambient `declare module 'x'` blocks are not resolution
  targets either.
- **Cause:** `TS_CANDIDATES` (`src/core/graph/modules.ts:33`) lists `.ts`…`.cjs` and `/index.*`, but not `.d.ts`
  (or `.d.mts`/`.d.cts`, `/index.d.ts`).

### A9-05 package.json `imports` (`#subpath`) and a package importing itself by name are not resolved

- **Evidence:** test `A9-05 package.json imports …`. `import { fmt } from '#util/fmt'` with
  `"imports": { "#util/*": "./src/util/*.ts" }`, and `import { lib } from 'mylib'` in the package's own tests, are
  both weak; `tsc --traceResolution` (`moduleResolution: nodenext`) resolves both to the right files. Subpath
  imports are the Node-native replacement for `paths` aliases and are spreading in ESM packages.
  - Also: `pnpm-workspace.yaml` with a flow-style list (`packages: ['pk/*']`) finds no members (test
    `A9-05 pnpm-workspace.yaml with a flow-style …`).
- **Cause:** `resolve` (`modules.ts:54-56`) sends bare specifiers to tsconfig, then to workspace members only; no
  code reads `imports`, and the root package is a workspace member only when a pattern matches `''`.
  `pnpmPackages` (`modules.ts:423`) matches only `- item` lines.

### A9-06 Tracked files that match `.gitignore` are not indexed

- **Evidence:** create-t3-app: 182 tracked JS/TS files, 181 walked; `cli/template/base/next-env.d.ts` is tracked
  but `.gitignore:40` matches it. Test `A9-06 …` (`git add -f` of a gitignored file and a `vendor/` dir). Committed
  generated clients, vendored code and template files are the usual cases; their importers get weak edges and drift
  never sees them.
- **Cause:** `src/core/ingest/walker.ts` applies `.gitignore` to every path; in a git checkout, `git ls-files` (plus
  untracked, not-ignored files) is the ground truth for "in the repo".

### A9-07 Members of `as const` / `satisfies` objects are lost; `export default {…} satisfies X` leaks its methods as top-level

- **Evidence:** test `A9-07 …`.
  - `export const routes = { home() {…}, about: () => 2 } as const` gives only `variable routes`;
    `routes.home()` in the same file is weak.
  - `export default { async fetch(req) {…} } satisfies ExportedHandler` (the Cloudflare Workers entry point) gives a
    top-level, unexported `method fetch`; arrow members are dropped, and there is no `default` symbol.
- **Cause:** `visitDeclarator` (`ts.ts:732`) and the `export default` branch (`ts.ts:640-649`) open a member scope
  only when the value node is `object`; `as_expression`/`satisfies_expression` wrap it. The walk then meets the
  `method_definition` at qualifier 0.

### A9-08 Function values wrapped in an expression get no `references` edge (SG18)

- **Evidence:** test `A9-08 …`. `app.get('/', h1 as unknown)`, `cond ? h2 : null`, `h3 || null`, `(h4)`,
  `function f(cb = h5)`, and Python `g1 if c else None`, `g2 or None` give no edge; the bare forms do. A concise arrow
  body (`() => h6`) and spread are also missed.
- **Why Medium:** the import edge to the symbol still exists for named imports (as in A5-04); what is lost is the
  symbol-level edge, and with it drift's neighbourhood entry for a namespace or same-file use.
- **Cause:** `addValue`/`addValuesAt`/`addValueAt` (`ts.ts:381-431`) and the Python `addValue` (`py.ts:120`) accept only an
  identifier or member expression as the direct child of a value node; no wrapper is unwrapped.

### A9-09 `module.Class.method()` through a module binding is weak, and `import a.b` + `a.b.C.m()` gives no edge at all

- **Evidence:** test `A9-09 …`. `import * as util from './util'; util.Timer.start()` and Python
  `from app import models; models.User.create()` are weak. `import app.models; app.models.User.create()` produces
  **no edge**, not even a weak one (`app.models.User()` resolves). Calling a classmethod or static factory through a
  module is common Python.
- **Cause:** `viaBinding` (`src/core/graph/resolver.ts:276-283`) looks the whole receiver up as one binding; for
  `models.User` it finds `models` bound and returns null (weak); for `app.models.User` neither the full key nor `app`
  is bound (Python binds `app.models`), so it returns undefined and the ref is dropped.

### A9-10 Source files over 1 MiB are dropped silently

- **Evidence:** test `A9-10 …`. A 1.35 MB `checker.ts` plus a 2-line importer: `$A index .` prints
  `indexed 1, skipped 0, failed 0`, the import is weak, and no event, count or diagnostic mentions the big file. A
  file that grows past the cap is pruned like a deletion. The cap is not configurable (`maxBytes` is not in
  `ConfigSchema`).
- **Cause:** `src/core/ingest/walker.ts:123` `continue`s past it before the indexer sees it.

### A9-11 Public API declared through a `module.exports` alias, `export declare` or `__all__ +=` is not exported

- **Evidence:** test `A9-11 …`. Drift's "undocumented" list and the prompt's symbol priority use `exported`.
  - Express `lib/application.js` (`var app = exports = module.exports = {}`): **0 of 34** symbols exported, so
    `app.use`, `app.listen`, `app.route`, … can never be reported undocumented. (`lib/response.js`: 21/44.)
  - `export declare function|class|const` in `.d.ts` files: `exported = 0`.
  - Python `__all__ += ['b']`: `b` is not exported, though `a` from `__all__ = ['a']` is.
- **Cause:** `collectExports` (`ts.ts:818`) reads only top-level `export_statement`s and assignment statements, not
  a declarator whose value is a `module.exports` chain. `isExported` (`ts.ts:135`) checks the direct parent, which is
  `ambient_declaration` under `export declare`. `literalAll` (`py.ts:147`) takes the last plain assignment only.

## Low

### A9-12 Chained method assignments define only the innermost name (`req.get = req.header = fn`)

- **Evidence:** test `A9-12 …`. Express's `req.get`, `res.contentType` and `res.set` (lib/request.js:63,
  lib/response.js:507,670) are not symbols; `req.get('host')` through `require('./request')` is weak.
- **Cause:** `visitAssignment` (`ts.ts:561-578`) needs a function on the right; the outer assignment's right is
  another assignment, so only the inner one is defined.

### A9-13 Resolver diagnostics are computed but never surfaced

- **Evidence:** test `A9-13 …`. Two workspace members named `example` (common for `examples/*`) make every import
  of that name weak; `ResolveStats.diagnostics` names it, but `indexRepo` drops it (`indexer.ts:213-215`) and the
  CLI, MCP and run stats never show it. A malformed or package-`extends` tsconfig is equally silent.

### A9-14 Notes (no test)

- Python `import pkg` then `pkg.core.helper()` (submodule bound as a side effect of `pkg/__init__.py` importing it)
  is weak.
- TS `namespace A.B {}` is one symbol named `A.B`, so `import { A }` cannot find it.
- DB-mode drift before re-indexing misses an *added* file (no `module` undocumented entry, architecture fresh) —
  the counterpart of A5-11.

## Still open (re-verified)

`npm test` runs every pin below as `it.fails`; each still fails on its stated assertion.

| ID | Status |
| --- | --- |
| A1-11 decorators produce no edge (TS bare, non-exported class, Python) | open |
| A1-14 calls in non-function values of `export default {…}` / `exports.x = {…}` dropped | open |
| A1-16 class expressions and mixin calls in heritage | open (`export const Cls = class Named extends Abs {}`: no `extends`, no methods) |
| A1-18 bare member name match counts as documented | open |
| A1-19 calls on unbound names dropped rather than weak | unchanged policy |
| A5-04 type annotations | **partial**: SG18 covers function/method/class values; `function g(m: T.Model)` through `import * as T` still gives no edge. New pin `A5-04 (still open, partial) …` |
| A5-10 non-UTF-8 bytes hashed after decoding | open |
| A5-11 deleting a symbol-less file invisible to DB-mode drift before re-index | open |
| A5-12 `f.call()`/`f.apply()`/`super()` | open |
| A5-13 `from . import sub` self-import edge in `__init__` | open |

Fixed and still passing as plain `it`: A5-01, A5-02, A5-03, A5-05, A5-06, A5-07, A5-08, A5-09 and every AUDIT-1
finding not listed above.

## Mutation results

22 hand mutations of SG18–SG20 resolution, walker, indexer and drift code, one at a time against the full suite
(`npx vitest run`, JSON reporter), restored after each; `git diff -- src` was empty at the end. The existing suite
killed **16/22**. The 6 survivors are killed by the new plain `it` pins in `test/audit/audit-9.test.ts` (each re-run
against its mutant with `-t <ID>`: 6/6 killed), so the kill rate with this audit's tests is **22/22**.

| ID | Mutation | Existing suite | With audit-9 |
| --- | --- | --- | --- |
| M01 | longest-wildcard `paths` rule inverted (`modules.ts:91`) | killed (`test/graph/modules.test.ts`) | |
| M02 | child `baseUrl` ignored for `paths` targets (`:97`) | killed (modules) | |
| M03 | `jsconfig.json` ignored | killed (modules) | |
| M04 | solution-style `references` ignored | killed (modules) | |
| M05 | tsconfig `extends` ignored | killed (modules) | |
| **M06** | workspace `dist/`→`src/` fallback removed (`:199`) | **survived** | killed (`M06 …`) |
| M07 | `pnpm-workspace.yaml` ignored | killed (modules) | |
| M08 | workspace `!` exclusions ignored | killed (modules) | |
| M09 | duplicate workspace name keeps the first | killed (modules) | |
| M10 | ambiguous discovered Python root used | killed (modules) | |
| **M11** | Python `src/` beside a config not added as a root | **survived** (discovery covers it unless ambiguous) | killed (`M11 …`) |
| M12 | prune no longer triggers re-resolve (`indexer.ts:209`) | killed (`test/ci/workflow.test.ts`) | |
| M13 | nested `.gitignore` files not read | killed (`test/ingest/skip.test.ts`) | |
| **M14** | drift neighbourhood loses **outgoing** edges (`context.ts`, first `SELECT`) | **survived** | killed (`M14 …`: a moved re-export target stales the unchanged importer) |
| M15 | Python function-local imports not collected | killed (golden, audit-1) | |
| M16 | `atModuleLevel` always true (assignments in callbacks define symbols) | killed (`test/parse/assigned.test.ts`) | |
| M17 | `references` edges also to variables | killed (`test/graph/references.test.ts`) | |
| **M18** | `.pyi` candidate dropped | **survived** | killed (`M18 …`: stub-only compiled module) |
| **M19** | `exports` conditions: `default`/`require` before `import` | **survived** | killed (`M19 …`) |
| M20 | virtualenv dirs not skipped | killed (skip) | |
| **M21** | exact `paths` pattern loses its priority | **survived** (only differs when a wildcard prefix is as long) | killed (`M21 …`) |
| M22 | `references` edges never emitted | killed (golden, references, audit-5) | |

The survivors were all correct code with no test; none hid a defect.


## No finding (checked clean)

- **Walker (SG20).** Identical to `git ls-files` on express, got, attrs, flask and trpc (0 missing, 0 extra; t3:
  A9-06 only). On an adversarial tree (root, nested and re-including `.gitignore`s, `/lib/` with `!lib/keep.ts`,
  `**/tmp/**`, `*.py[cod]`, `src/build/`) it equals `git ls-files -o --exclude-standard` (pinned).
- **tsconfig/workspace resolution (SG19)** vs `tsc`: 0 disagreements (above). Longest-wildcard and exact-pattern
  precedence, child `baseUrl` overriding a parent's `paths` base, local `extends` chains, solution-style
  `references`, JSONC (comments, trailing commas, `//` inside strings), `exports` conditions and `dist/`→`src/`
  fallback all behave as tsc or as documented.
- **Python layouts (SG19).** flask: 315/319 internal imports resolve; the 4 misses are `import json` (stdlib) next to
  `flask/json/`, correctly *not* resolved to the subpackage (pinned). attrs: 325/325. Relative `from ...pkg import
  core`, `from .. import core as c2`, `import pkg.core`, `async def`, `@property`/`@staticmethod`, defs under
  top-level `if` all resolve.
- **Incremental.** Every source change re-runs the full resolver, so edits, renames, deletions and branch switches
  leave no stale edge (rename of a callee with unchanged importers pinned). Only A9-01 and A9-03 escape it.
- **Parser robustness.** Chunked parsing of >8 KB files with 2- and 4-byte characters keeps every symbol (pinned);
  BOM, shebang and CRLF sources parse fully; the native `descendantsOfType` path (>500 descendants) includes the
  root node, so `x = build(<huge args>)` keeps its call.
- **Drift.** The prompt hash covers content plus every resolved cross-file edge of every kind (incl. SG18
  `references`); persisted docs with BOM/CRLF or broken front matter are stale rather than dropped; tombstones,
  `missing` and `unindexed` behave as recorded in AUDIT-5.
- **TS/JS constructs that resolve:** `export declare` targets (for edges), generators, async functions, enums,
  abstract/static/getter members, `import type X from`, CJS `module.exports.x = function`, `exports.x = () => …`,
  `module.exports.Other = class`, destructured `require` with rename, JSX `<Card.Header />`.
