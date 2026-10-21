# AUDIT-1: graph and drift soundness

Auditor: an independent subagent that wrote none of this code. Base: `f25ab12` (SG9). Date: 2026-10-21.
Bar: no false negatives. Every finding below was reproduced. Each has an `it.fails` test in
`test/audit/audit-1.test.ts` named with its ID, and most also have a shell repro against
`node dist/cli/index.js`. The suite stays green: `it.fails` passes while the defect exists, and
it turns red once the defect is fixed.

The vitest tests are the canonical repros. The shell helpers (`edges.mjs`, `drift.sh`,
`trunc-pre.sh`) were scratch-only and are not committed. `drift.sh <name> '<mutation>'` builds
`a.ts`/`b.ts`/`c.py` and runs `index`, then `docs --offline`, then the mutation, then `index`. It
then runs `drift --json` in DB mode and with `--docs-dir .atlas/docs`.
Shell repros use `$S`, a `mktemp -d` scratch directory, together with the helper
`edges.mjs <root>`. The helper indexes `<root>` with `indexRepo(..., { skipEmbeddings: true })`
and prints every edge as `src -kind-> dst`, prefixing weak edges with `WEAK`.

## Critical

None found. No writes to the target outside `.atlas/` and no crashes of the CLI process were seen.
Parser exceptions are caught per file (see A1-04). Source text and keys were out of scope here.

## High

### A1-01 Re-exports (`export … from`, `export *`, barrel `index.ts`, Python `__init__.py`) produce no edges

- **Severity:** High. Barrels are standard in TS and Python packages, and every relationship that passes through one is lost.
- **Evidence:** the tests `A1-01 TS barrel…`, `A1-01 the barrel file itself…` and `A1-01 Python re-exports…`. The shell repro uses `lib/index.ts` = `export { foo, Base } from './foo'; export * from './bar';`, together with `use.ts` = `import { foo, Base, bar } from './lib'` and calls to `foo()`/`bar()` plus `class Sub extends Base<string>`.
  - Actual output:
    `WEAK use.ts::<module> -imports-> lib/index.ts::<module>`,
    `WEAK use.ts::viaBarrel -calls-> null {"name":"foo"}`,
    `WEAK use.ts::viaBarrel -calls-> null {"name":"bar"}`,
    `WEAK useBarrel.ts::Sub -extends-> null {"name":"Base"}`.
    `lib/index.ts` has **no edge at all** to `foo.ts` or `bar.ts`, not even a weak one.
  - Python behaves the same way. With `app/api/__init__.py` = `from .views import view` and `main.py` = `from app.api import view; view()`, the result is `WEAK main.py::run -calls-> null {"name":"view"}`.
  - Expected: resolved edges to `lib/foo.ts::foo`, `lib/bar.ts::bar`, `lib/foo.ts::Base` and `app/api/views.py::view`, plus an import edge from the barrel to each module it re-exports.
- **§5 classification:** the barrel's own missing edge breaks §5, which allows weak edges but not dropped ones. The consumers' edges are weak where they should be resolved: their accuracy is degraded, but nothing is dropped.
- **Location:**
  - `src/core/parse/ts.ts:242-244`: only `import_statement` is collected, and `export_statement` with a `source` is ignored.
  - `src/core/parse/ts.ts:404`: `collectExportNames` skips sourced exports.
  - `src/core/graph/resolver.ts:147`: `exportsByName` holds only the target file's own symbols, and imports are never followed through as re-exports.

### A1-02 Default imports and CJS `module.exports = fn` never resolve to the exported symbol

- **Severity:** High. `import X from` is the most common React/TS import form, and `module.exports = fn` is the Express pattern.
- **Evidence:** the tests `A1-02 default imports…` and `A1-02 CJS…`.
  - With `import makeThing from './lib/def'; makeThing()` the output is `WEAK useDefault.ts::useDef -calls-> null {"name":"makeThing"}`.
  - With `import DefClass from './lib/DefClass'; class Child extends DefClass {}` the output is `WEAK useDefault.ts::Child -extends-> null`.
  - The import edge points at the module, not at the default-export symbol.
  - CJS case: `app.js` = `function createApp(){}; module.exports = createApp;` and `main.js` = `const app = require('./app'); function main(){ app(); }`. The output is `main.js::main -calls-> main.js::app`, which is a *resolved* edge to the local `require` variable. There is no edge to `app.js::createApp`.
- **§5 classification:** for ESM the edge is weak where it should be resolved. For CJS the real edge is missing and a misleading resolved edge stands in for it.
- **Location:**
  - `src/core/graph/resolver.ts:137-146`: `imported: 'default'` is treated as a module binding.
  - `src/core/graph/resolver.ts:186-191`: a receiver-less call through a module binding falls back to the importer's own symbol of the same name.
  - Default-export names are never registered. `export default function f`, `export default X` and `module.exports = X` all set `exported` without recording which symbol is the default (`ts.ts:401-418`).

### A1-03 Python base classes with subscripts (generics) produce no extends edge

- **Severity:** High. `class UserRepo(Repo[User])` is idiomatic Python (Generic, Pydantic, SQLAlchemy), and generics in heritage clauses were an explicit target of this audit.
- **Evidence:** the test `A1-03 …`. With `class UserRepo(Repo[User]): def all(self): return self.get()`, the extends edge is missing entirely, with no weak edge either. The only edge is `WEAK users.py::UserRepo.all -calls-> null {"name":"get","receiver":"this"}`. Expected: `UserRepo -extends-> models.py::Repo` and `UserRepo.all -calls-> models.py::Repo.get`. TS generics work: `extends A<T>`, `implements IB<T>`, `extends nsA.A<string>` and interface `extends IA<T>` all resolve.
- **§5 classification:** missing edge, not even weak.
- **Location:** `src/core/parse/py.ts:66-84`. `addRef` handles only `identifier`/`attribute`, so a `subscript` base is silently dropped. The call site is `py.ts:160-162`.

### A1-04 Parser throws `RangeError` on deep top-level expressions, and the changed file then hides drift

- **Severity:** High. The parser throws, the index command still exits 0, and drift reports clean (exit 0) for a file whose content and exported symbols changed.
- **Evidence:** the tests `A1-04 parser does not throw… (TS)`, `(Python)` and `A1-04 an edit that makes the parser throw still marks the doc stale`.
  - A module-level `console.log("a" + "a" + … )` with about 3,000 terms throws `RangeError: Maximum call stack size exceeded`. 2,000 terms is fine. Python `print(…)` behaves the same. The stack is `visit (ts.js) → visit → … → namedChildren`.
  - Generated string tables and data modules reach this depth.
  - Drift repro: `drift.sh deep` in the scratch directory. It indexes, generates docs offline, appends such a line plus `export function added()` to `a.ts`, and re-indexes. The output is `indexed 0, skipped 2, failed 1`, `index exit=0`, then `db-mode exit=0 stale=[]` and `persisted exit=0 stale=[]`.
  - The indexer keeps the old rows and hash on failure. That is the SG2 contract, but drift then compares against the stale hash. The failure is not surfaced in the exit code.
- **Location:**
  - `src/core/parse/ts.ts:363-366` and `src/core/parse/py.ts:199-201`: the recursive `visit` should be iterative, like `forEachOfType`.
  - `src/core/ingest/indexer.ts:107-118`: a failure leaves the old hash in place.
  - `src/cli/commands/indexCmd.ts`: exits 0 when `filesFailed > 0`.

### A1-05 Drift misses call-neighbourhood changes beyond 12 cross-file edges

- **Severity:** High. Any hub module, meaning anything with more than 12 distinct cross-file callers or callees, has a blind spot.
- **Evidence:** the test `A1-05 …`, plus the shell repro `drift.sh hub3`. In that repro, `a.ts::foo` is called from `k01.ts`…`k12.ts` and from `zz.ts`, and the mutation changes `zz.ts` to call `a.ts::other` instead of `foo`.
  - Actual: `stale=["zz.ts"]` in both modes. `a.ts` is not stale, and neither is architecture, because the totals and degrees are unchanged.
  - Expected: `a.ts` is stale, because its incoming call neighbourhood changed.
  - `ORDER BY COUNT(*) DESC` does nothing, because edges are already deduped per `(src, dst, kind)` and every count is 1. The 12 rows that are kept are simply the alphabetically first.
- **Location:** `src/core/synth/context.ts:50-65` (`LIMIT ${MAX_CALLS}`, with `MAX_CALLS = 12` at `:32`).

### A1-07 The CI drift step passes silently when `.atlas/docs` is absent, empty or misnamed

- **Severity:** High. The CI gate is a no-op today: `git ls-files .atlas` is empty in this repo, as PLAN SG6's follow-up notes.
- **Evidence:** the test `A1-07 …`. After a content edit, `atlas drift --docs-dir .atlas/doc-typo` exits 0 and reports `0 stale`, with `totals.docs = 0`. `.github/workflows/atlas.yml:49` runs exactly this command against `.atlas/docs`, which does not exist, so the job reports `has_drift=false` on every PR.
- **Expected:** a non-zero exit, or at least a loud error, when `--docs-dir` is missing or holds no parseable docs.
- **Location:**
  - `src/core/synth/persist.ts:269-270`: `walkMarkdown` returns `[]` for a missing directory.
  - `src/cli/commands/driftCmd.ts:203`.
  - `.github/workflows/atlas.yml:45-61`.

## Medium

### A1-06 The 6,000-char module-prompt cap cuts the incoming-call tail out of the hash

- **Evidence:** the test `A1-06 …`, plus the shell repro `drift.sh trunc` using `trunc-pre.sh`.
  - Setup: `hub.ts` has 30 imports from a path about 70 chars deep and is called by 12 files in that directory with descriptive names.
  - `modulePrompt(hub.ts)` has length 6,000 and ends mid-line in the *Incoming calls* section, so callers 11 and 12 are cut off.
  - Renaming `caller_12`'s function gives `stale=["…/caller_12.ts"]`, but `hub.ts` is not stale, even with the architecture doc checked.
  - Shrinking drops snippets and symbols but never imports or calls, and the final `slice(0, 6000)` truncates what remains.
- **Location:** `src/core/synth/context.ts:129-139`. The hash should be computed over the full, untruncated neighbourhood, or calls should be shrunk before truncation.

### A1-08 Persisted docs with CRLF line endings are silently ignored

- **Evidence:** the test `A1-08 …`. After converting `.atlas/docs/**/*.md` to CRLF, which is what a Windows checkout with `core.autocrlf=true` produces, `drift --docs-dir` reports `0 stale` (exit 0). The LF copy of the same docs reports `1 stale`.
- **Location:** `src/core/synth/persist.ts:255`. The regex `^---\n…\n---\n` fails to match, and `parse` returns null without any warning.

### A1-09 JSX component usage produces no edge

- **Evidence:** the test `A1-09 …`. `App.tsx` renders `<Button />` and `<Icon></Icon>` imported from `./Button`. The only edges are the imports; there is no `App -calls-> Button`. Calls inside JSX expressions such as `{foo()}` are found.
- **§5 classification:** missing edge, not even weak.
- **Location:** `src/core/parse/ts.ts:147` (`CALL_NODES`). `jsx_self_closing_element` and `jsx_opening_element` names are not recorded.

### A1-10 Dynamic `import()`, function-scoped `require()`, `import x = require()` and Python function-local imports produce no edge

- **Evidence:** the four `A1-10` tests.
  - `const m = await import('./lib/bar'); m.bar()` gives no edge of any kind.
  - `function inner(){ const b = require('./bar'); b.bar() }` gives no edge.
  - `import B = require('./bar')` gives no edge.
  - Python `def view(): from helpers import helper; return helper()` gives neither an import edge nor a call edge.
- **§5 classification:** missing, not even weak.
- **Location:**
  - `src/core/parse/ts.ts:246-253`: `require` is collected at the top level only.
  - `src/core/parse/ts.ts:424-426`: `import_require_clause` has no `source` field.
  - Dynamic `import` is a `call_expression` whose callee is `import`, and `targetOf` returns null for it (`ts.ts:166-190`).
  - `src/core/parse/py.ts:123-142`: function bodies are only scanned for calls.

### A1-11 Decorators: bare decorators, and decorators on non-exported classes, produce no edge

- **Evidence:** the three `A1-11` tests.
  - `@Log` on a TS method gives no edge.
  - `@Dec() class D {}`, with the class not directly exported, gives no edge. The same decorator on `export class` is attributed to `<module>`, not to the class.
  - Python `@register` gives no edge.
  - Decorator *calls* in Python, such as `@app.route(...)`, are found.
- **Location:**
  - `src/core/parse/ts.ts:263-270`: the class branch walks heritage and body only, not `decorator` children.
  - The `decorator` node is never treated as a call in `ts.ts` or in `py.ts`.

### A1-12 Calls to names from a Python star import produce no edge

- **Evidence:** the test `A1-12 …`. With `from .lib import *` followed by `star_fn()`, the import edge to `lib.py` exists, but the call has no edge, not even a weak one. The import creates no binding, so the call counts as "unbound" and is dropped.
- **Location:** `src/core/graph/resolver.ts:137-170`, where `imported === '*'` gives `localName = null`.

### A1-13 The parser has no diagnostics channel

- **Evidence:** `parseSource` returns `{ language, symbols, imports, references }` only (`parse1.mjs` prints `keys`). ERROR or MISSING nodes, such as the stray `}}}} ))) class { @@@` in `garbage.ts`, are recovered silently. Any internal failure surfaces only as a thrown exception (A1-04), so callers cannot tell a clean parse from a partial one.
- **Location:** `src/core/parse/types.ts:35-40`, `src/core/parse/parser.ts:82-97` (`tree.rootNode.hasError()` is never consulted).

### A1-20 CI indexes with default config, because `.atlas/config.json` is git-ignored; spurious drift results

- **Evidence:** shell repro.
  1. `atlas init`, then add `"tests/"` to `exclude` in `.atlas/config.json`.
  2. Run `index`, then `docs --offline`, then commit with the project's `.gitignore`, which keeps `.atlas/docs` and drops everything else under `.atlas`.
  3. `git clone`, `index .`, `drift --docs-dir .atlas/docs`.
  - Result: `exit=2 stale=['a.ts','architecture']` for an unchanged tree. The clone indexes `tests/`, which adds incoming calls.
- This is a false positive, not a false negative. Its practical effect is a permanently red gate that teams will switch off.
- **Location:** `.gitignore` (`.atlas/*`), `src/core/config.ts:6`, `.github/workflows/atlas.yml:42`.

## Low

### A1-14 Calls in non-function values of `export default {…}`, `module.exports = {…}` and `exports.x = {…}` are dropped

- **Evidence:** the test `A1-14 …`. `export default { value: compute() }` records the ref from `default`, but no symbol `default` exists, so `srcOf` returns null and the ref is discarded. `exports.settings = { v: compute() }` behaves the same way.
- **Location:** `src/core/parse/ts.ts:277-288` (synthetic scope owner) and `src/core/graph/resolver.ts:175-178`.

### A1-15 `exports.helper = function helper() {}` defines no symbol

- **Evidence:** the test `A1-15 …`. `util.js` has no `helper` symbol, so `const { helper } = require('./util'); helper()` gives a weak edge only.
- **Location:** `src/core/parse/ts.ts:377-399`. The CJS export name is recorded, but no symbol is pushed for the function expression.

### A1-16 Heritage from class expressions and mixin calls is lost

- **Evidence:** the test `A1-16 …`. `const E = class extends A {}` and `class F extends mixin(A) {}` produce no extends or calls edge to `A` or `mixin`.
- **Location:** `src/core/parse/ts.ts:263` (only declarations), `ts.ts:166-190` (`targetOf` has no case for `call_expression`).

### A1-17 DB-mode drift does not report a deleted file's doc; deleted or added files pass with `--skip-architecture`

- **Evidence:** the test `A1-17 …`, plus the shell repro `DRIFTARGS=--skip-architecture drift.sh sa-delete-c 'rm c.py'`.
  - DB mode gives `exit=0 stale=[]`. Persisted mode reports `c.py` as `missing` (exit 2).
  - Adding a new file under `--skip-architecture` exits 0 in both modes, because it only produces "undocumented" entries.
  - Without `--skip-architecture`, the architecture doc catches both cases.
- **Location:** the `files` cascade-deletes the doc (`src/core/db/schema.ts:35`), and `docsFromDb` (`src/core/synth/persist.ts:281-290`) can no longer see it.

### A1-18 The "undocumented" check accepts a bare member name match from anywhere in the doc

- **Evidence:** the test `A1-18 …`. Classes `Foo` and `Bar` both have a `render` method, and the doc mentions only `Bar.render`. `Foo.render` is still counted as documented.
- **Location:** `src/core/drift/detect.ts:94` (`mentions(doc.content, sym.name)`).

### A1-19 Calls on unbound names or receivers are dropped rather than stored as weak

- **Evidence:** inspection plus the repros above. `const x = new Foo(); x.bar()` and calls on parameters, such as `o?.hello()`, give no edge. This is a deliberate SG4 policy recorded in `DECISIONS.md`. It conflicts with CLAUDE.md §5: "store them as edges with a null/weak flag rather than dropping them".
- **Location:** `src/core/graph/resolver.ts:247-248`. Either amend §5 or store these as weak edges.

## Summary

| ID | Severity | Title | Edge or drift false negative? |
| --- | --- | --- | --- |
| A1-01 | High | Re-exports and barrels produce no edges | Yes (barrel: missing; consumers: weak) |
| A1-02 | High | Default imports and CJS `module.exports = fn` do not resolve | Yes (weak; CJS: wrong target) |
| A1-03 | High | Python subscripted bases produce no extends edge | Yes (missing) |
| A1-04 | High | Parser stack overflow on deep expressions hides drift | Yes (drift) and crash |
| A1-05 | High | Drift neighbourhood capped at 12 edges | Yes (drift) |
| A1-07 | High | CI drift passes with missing or empty docs dir | Yes (CI) |
| A1-06 | Medium | Prompt truncation hides incoming calls from drift | Yes (drift) |
| A1-08 | Medium | CRLF persisted docs ignored | Yes (drift) |
| A1-09 | Medium | JSX usage produces no edge | Yes (missing) |
| A1-10 | Medium | Dynamic, nested and `import =` requires produce no edge | Yes (missing) |
| A1-11 | Medium | Bare and class decorators produce no edge | Yes (missing) |
| A1-12 | Medium | Python star-import calls produce no edge | Yes (missing) |
| A1-13 | Medium | No parser diagnostics | n/a |
| A1-20 | Medium | CI indexes with uncommitted config, causing spurious stale | No (false positive) |
| A1-14 | Low | Calls in default-export object values dropped | Yes (missing) |
| A1-15 | Low | `exports.x = function` defines no symbol | Weak only |
| A1-16 | Low | Class-expression and mixin heritage lost | Yes (missing) |
| A1-17 | Low | DB-mode drift silent on a deleted file's doc | Yes (with `--skip-architecture`) |
| A1-18 | Low | Undocumented check matches bare member names | Yes (report only) |
| A1-19 | Low | Unbound calls dropped, contrary to §5 | Policy |

## Checked and clean

- **Comment, string and template decoys:** `// foo()`, `/* bar() */`, `'foo()'`, `` `bar() ${1}` `` and Python `"helper()"` / `# helper()` produce no edges. Real calls inside `${…}` and f-string `{h()}` are found.
- **TS imports:** aliased named imports (`{ foo as aliasFoo }`), namespace imports (`L.foo()`), explicit `.js`/`.ts` specifiers, directory `index.ts` resolution, `import type`, and top-level `require` destructuring with aliases (`{ foo: f2 }`) all resolve.
- **Calls:** `this.m()`, `super.m()`, inherited `this.m()` across files and through multi-level chains (`D → B → A`), class-field arrows, nested arrows inside methods, tagged templates, optional calls (`util?.()`), `new C()` and static `A.make()` all resolve. Namespace-then-class `nsA.A.make()` gives a weak edge, which is acceptable under §5.
- **TS heritage:** `extends A<T>`, `implements IB<T>`, `extends nsA.A<string>`, interface `extends IA<T>` and cross-file chains all resolve.
- **Python imports:** relative (`from ..core.models import X`, `from . import api`, `from ..core import models as m`), absolute from a package root (`from app.core.models import helper as h`), `import app.core.models` followed by `app.core.models.Model` / `.helper()`, `super().save()`, `self.m()` and `m.helper()` all resolve.
- **Large files:** a 104 KB TS file and a 67 KB Python file, each with 1,500 functions and non-BMP characters (including a surrogate pair straddling the 8 KB chunk boundary), parse fully. The final `last()` function keeps its correct line and its cross-file call.
- **Renames and deletes across re-index:** after renaming `a.ts` to `c.ts`, the old import and call become weak. Updating the importer re-resolves them to `c.ts::foo`. Renaming the symbol makes the call weak again. Pruning removes the old rows (`filesRemoved` 1).
- **Drift, DB and persisted modes:**
  - These all mark the right doc stale: a content edit, a single trailing-whitespace edit, a new cross-file caller (the callee's doc goes stale), a deleted or renamed caller (the callee goes stale; persisted mode reports the deleted doc as `missing`), a new file (architecture goes stale), and a Python edit.
  - **Whitespace-only edits *are* stale.** This is by design, because the prompt carries the file's content hash. It is conservative and documented in SG6.
  - Exit codes: 0 when clean, 2 when stale, 2 with `--strict` when only undocumented, and 1 when the DB is missing (`atlas: unable to open database file`).
- **Malformed input:** garbage TS and Python, binary bytes in a `.js` file and modern syntax all return symbols without throwing. The modern syntax covered TS 5 `accessor`, `satisfies`, `await using` and `<const T>`, and Python 3.12 `def f[T]`, `class Box[T]` and `match`. The only throw found is A1-04.
- **Target stays read-only:** all runs wrote only under `<target>/.atlas/`.
