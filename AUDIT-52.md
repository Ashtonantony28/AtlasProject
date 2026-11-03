# AUDIT-52: API and SDK consistency, round 15

This audit checks whether the CLI (text and `--json`), the exported core functions, the MCP tools (handlers and
through the SDK client), the dashboard HTTP API and `README.md`/tool descriptions agree on names, shapes, error
messages, exit codes and behaviour. Since AUDIT-48 (`9f3b7fc`) no `src/` file changed: SG270 (#98) and AUDIT-49
(#97) touched only tests (`git diff --stat 9f3b7fc HEAD -- src` is empty). So this round looks at the surfaces
AUDIT-44 (leftover WAL) and AUDIT-48 (SG240 excerpts) covered least:
- the committed-docs path: a fresh clone, or the README reset;
- graph export formats;
- the MCP tool metadata as the SDK client sees it;
- the package entry point and the README's `npx` instructions.

It also re-checks the recorded API findings.

Base: `2f2ff73` on `claude/atlas-audit-52`. Date: 2026-11-03. The auditor wrote none of this code.
`@modelcontextprotocol/sdk` 1.32.1, better-sqlite3 11.10.0, Node 22.22.

**Method.**
- I drove the CLI as `node --import tsx src/cli/index.ts` on copies of `fixtures/sample`, and read stdout, stderr
  and the exit code separately.
- I called the MCP handlers in-process, and also through the stock SDK `Client` over `InMemoryTransport`
  (`callTool`, `listTools`).
- I queried `atlas serve` (`startServer` on a read-only connection) with `fetch`.
- I read `npm view atlas` from the public registry once, for A52-01.
- The "fresh index with committed docs" setup works like this. Index the sample and run `atlas docs --offline`
  (5 docs in `.atlas/docs`). Append `export function sub(…)` to `src/math.ts`. Then
  `rm .atlas/index.db*` and `atlas index`. This is the README's own reset recipe, and it is also what a fresh
  clone of a project that commits `.atlas/docs` has.

The repros are in `test/audit/audit-52.test.ts` as `it.fails`, named by ID. I ran each one as a plain `it` and
confirmed that it fails on the assertion that names the defect. Each failure is quoted under **Test**. Nothing
needs `cc` or the network: A52-01's test checks the repository and records the registry fact in a comment.

**Totals:** 0 critical, 0 high, 2 medium, 3 low. No new SG rows.

## Findings

### Critical

None found.

### High

None found.

### Medium

**A52-01: the README's MCP config and its `npx atlas …` examples run a different package. The npm name `atlas`
belongs to an unrelated project, which has no `bin` and has a `postinstall` script.** Medium.
- **Evidence:**
  - `npm view atlas` (2026-11-03) shows `atlas@1.0.0-alpha.0`, maintainer `chrisui`, last modified 2022-06-13.
    It has no `bin`, and its `scripts.postinstall` is `npm run bootstrap` (currently `echo "all good!"`).
  - This repo's `package.json` is `"name": "atlas"`, so it cannot be published under that name.
  - The README's MCP block (`README.md:200-210`) has no "once published" caveat. It configures
    `"command": "npx", "args": ["atlas", "mcp", "--cwd", …]` with `"env": { "ANTHROPIC_API_KEY": … }`.
  - `README.md:96-97` shows `npx atlas index …` and `npx atlas search …`. DECISIONS (line 65) says the shebang
    is kept "so `npx atlas` works once published".
- **Impact:**
  - An MCP client set up from the README installs the other package and runs its `postinstall`. It then fails
    with npx's "could not determine executable to run". The server never starts.
  - The README hands that third-party install the user's `ANTHROPIC_API_KEY` in its environment. The script is
    benign today, but any future version of that package receives the key.
  - CLAUDE.md §10 ("`npx atlas` works on a fresh clone") cannot be met under this name.
  - This is medium, not high: no wrong result is served, the launch just fails. But the documented setup exposes
    a secret to a package nobody here controls.
- **Test:** `A52-01`. As a plain `it`, it fails with `expected 'atlas' not to be 'atlas'` (the README uses bare
  `npx atlas`, and the package is named `atlas`).
- **Repro:** `npm view atlas name version bin scripts maintainers`; `grep -n 'npx atlas\|"npx"' README.md`.
- **Location:** `package.json:2`, `README.md:92-101` and `README.md:200-210`, `DECISIONS.md:65`.
- **Fix:** publish under a scoped name, such as `@<owner>/atlas`, with `bin: {atlas: …}`. Use
  `npx -y @<owner>/atlas mcp` in the README, or `node /path/to/atlas/dist/cli/index.js mcp` until it is
  published. Mark the MCP block "once published" as the quickstart is.

**A52-02: on an index whose only docs are the committed `.atlas/docs` (a fresh clone, or after the README
reset), every listing shows the docs, but `atlas drift` and `atlas_drift` say `no docs found in the index (run
\`atlas docs\` first)`. Following that remedy regenerates the stale docs, so the report that should have named
them is lost.** Medium.
- **Evidence:** on the fresh index with committed docs, where `src/math.ts` and the architecture doc are stale:
  - `atlas docs --list` lists 5 docs, all `persisted` (exit 0). `atlas_docs {}` and `/api/docs` list the same 5,
    and `/api/stats` says `docs: 5` (pinned).
  - `atlas drift` exits 1 with `atlas drift: no docs found in the index (run \`atlas docs\` first)`.
    `atlas_drift {}` (SDK) returns `isError` with the same text.
  - `atlas drift --docs-dir .atlas/docs` exits 2 and names `src/math.ts` and `architecture` as stale. So does
    `atlas_drift {persisted: true}` (pinned equal).
  - Following the remedy, `atlas docs --offline` prints `modules: generated 1, cached 3`. The stale docs are
    rewritten (with the real client this spends tokens), and `atlas drift` then prints `no drift …` and exits 0.
    No surface ever said which docs had been stale.
- **Impact:**
  - One state gives contradictory answers: the docs are listed everywhere, but "no docs found" comes from both
    drift surfaces.
  - The remedy is the one action that destroys the information drift exists to report. The README's own
    Quickstart step 7 runs plain `atlas drift`, as does a developer after cloning.
  - An MCP agent has no tool that runs `atlas docs`, and the error does not mention `persisted: true`, which
    would work.
  - CI is unaffected, because it uses `--docs-dir`. That is why this is medium, not high.
- **Test:** `A52-02`. As a plain `it`, it fails with `expected 'atlas drift: no docs found in the ind…' not to
  match /run \`atlas docs\` first/`.
- **Repro:**
  1. `cp -r fixtures/sample R && atlas index R && atlas docs --offline --cwd R`.
  2. Append a function to `R/src/math.ts`.
  3. `rm R/.atlas/index.db* && atlas index R`.
  4. Run `atlas docs --list --cwd R; atlas drift --cwd R; atlas drift --cwd R --docs-dir .atlas/docs`.
- **Location:** `src/core/drift/run.ts:31-35` (index mode ignores persisted docs, which `listDocs` and
  `countDocs` include).
- **Fix:** one of the following.
  - When the index holds no docs but `<atlasDir>/docs` does, check those, as `listDocs` does (index first, then
    `.atlas/docs`).
  - Keep the refusal, but say `no docs in the index; .atlas/docs holds N: run \`atlas drift --docs-dir
    .atlas/docs\` (MCP: \`persisted: true\`)`.

### Low

**A52-03: `graph --format dot` (and `atlas_graph {format: "dot"}`) is not the same graph as the JSON export. It
drops every edge with a null endpoint without saying so, and a page draws edges to nodes it never declares.**
Low.
- **Evidence:** this uses the sample plus `src/ext.ts`, which imports `lodash` and `./missing` and calls `_.map`.
  - `atlas graph` (JSON) has 18 edges, 3 of them with `dst: null` (two weak `imports`, one weak `calls`).
    `--format dot` draws 15 arrows. The DOT has no truncation comment, because `truncated` is false, so nothing
    shows that 3 edges are missing. `atlas_graph {format: "dot"}` matches.
  - `graph --format dot --limit 5` holds `n1 -> n12` and `n1 -> n15`, but declares only `n1`…`n5`. Graphviz
    draws `n12` and `n15` as bare boxes with no kind, name or file. Its comment says `4 of 15 edges`.
  - The JSON page has the same edges with `dst` ids that a client can resolve on another page.
- **Impact:**
  - The README presents `--format json|dot` (and the MCP `format` enum) as two encodings of one export.
  - A DOT reader undercounts edges and sees unresolved references as absent. On a page (the default for
    `atlas_graph`: 1000 nodes), it gets anonymous nodes.
  - The JSON surfaces are correct, and DOT is usually consumed visually.
- **Test:** `A52-03`. As a plain `it`, it fails with `expected [ 'n12', 'n15' ] to deeply equal []`. The arrow
  count (15 against 18) is asserted next.
- **Location:** `src/core/graph/export.ts:187-208` (`graphToDot`: `continue` on a null endpoint, and nodes
  declared only from `json.nodes`).
- **Fix:** declare a placeholder node, such as `n12 [label="(other page) #12" style=dotted]`, for every endpoint
  that is not on the page. Draw a null endpoint as a per-edge `unresolved: <module or name>` node from `meta`, or
  count the dropped edges in a comment.

**A52-04: no MCP tool carries `annotations`. By the MCP defaults, a client must treat all seven tools as
non-read-only, destructive and open-world.** Low.
- **Evidence:** `client.listTools()` returns `annotations: undefined` (and no `title`) for every tool. The tools
  behave like this:
  - `atlas_search`, `atlas_symbol`, `atlas_graph`, `atlas_drift`, `atlas_docs` and `atlas_ask` write nothing
    (DECISIONS and the README say read tools never write);
  - `atlas_index` writes only under `.atlas/`;
  - only `atlas_ask` reaches a network service.
- **Impact:**
  - Clients that gate tools on `readOnlyHint` or `destructiveHint` ask for approval on every search, or refuse
    to auto-run it.
  - Nothing tells a client that `atlas_ask` spends tokens (`openWorldHint`), except the prose description.
  - The tool metadata contradicts the tools' documented behaviour, but no result is wrong.
- **Test:** `A52-04`. As a plain `it`, it fails with `expected undefined to be true`.
- **Location:** `src/mcp/server.ts:341-450` (seven `registerTool` configs with no `annotations`).
- **Fix:** add `annotations` to each config:
  - the six read tools: `{readOnlyHint: true, openWorldHint: false}`;
  - `atlas_ask`: `openWorldHint: true`;
  - `atlas_index`: `{readOnlyHint: false, destructiveHint: false, idempotentHint: true}`.

**A52-05: the package's `main` is the CLI entry. Importing the package runs the CLI on the importer's `argv`,
prints the usage and exits the importing process with code 1. No path exposes the core functions.** Low.
- **Evidence:**
  - `package.json` has `"main": "./dist/cli/index.js"` (the same file as `bin.atlas`) and no `exports`.
  - `node --input-type=module -e "await import('<atlas>/src/cli/index.ts'); console.log('imported')"` prints
    commander's `Usage: atlas [options] [command] …` on stderr, exits 1 and never prints `imported`.
  - The core barrel (`src/core/index.ts`, the `@atlas/core` surface that earlier audits pin) re-exports only
    config, db, params and project. `search`, `ask`, `runDrift` and `buildGraphJson` are reachable only by deep
    paths into `dist/`.
- **Impact:**
  - A program that does `import 'atlas'` (or `require`), or a tool that probes the package's `main`, is killed
    by `process.exit(1)` from inside the import.
  - The README documents no library API, so nothing promises one. The core functions the audits compare
    against are not part of any published surface.
- **Test:** `A52-05`. As a plain `it`, it fails with `expected 'Usage: atlas [options] [command]\n\nL…' not to
  match /Usage: atlas/`.
- **Location:** `package.json:9`, `src/cli/index.ts:5-12`, `src/core/index.ts`.
- **Fix:** point `main`/`exports["."]` at `dist/core/index.js` and widen that barrel (search, graph, drift, qa,
  synth), or drop `main` so that only `bin` is published. Also guard the CLI with an entry check.

## Scope checks

- **Shared parameter refusals (pinned):** four refusals give the same text on all three surfaces: `limit` 0,
  a blank query, kind `module` and `depth` 9.
  - The CLI prints `atlas: <message>` on stderr only and exits 1.
  - HTTP returns 400 `{error: <message>}`.
  - The SDK client gets `isError` whose text contains the message, after the SDK's `MCP error -32602: Input
    validation error: Invalid arguments for tool …:` prefix.
  - `atlas_symbol`'s limit is the exception (A11-11).
  - Handler-level errors, such as `name must not be empty` and `no doc for 'nope': run \`atlas docs\` …`, come
    through bare.
- **Committed docs (pinned):** on the fresh index with committed docs, `docs --list`, `atlas_docs {}` and
  `/api/docs` list the same 5 targets, all `persisted`, and `/api/stats` counts 5. `drift --json --docs-dir
  .atlas/docs` deep-equals `atlas_drift {persisted: true, limit: 1000}` (exit 2, `src/math.ts` and `architecture`
  stale).
- **Graph JSON (pinned):** on the sample, `atlas graph --limit 1000 --edge-limit 2000`, `atlas_graph {}` through
  the SDK and `/api/graph` are deep-equal.
- **Tool schemas:** the `listTools` input schemas match `core/params.ts`. Ranges, defaults, the `kind` enum
  without `module`, `required` and `additionalProperties: false` match the CLI help and the README ranges. The
  `atlas mcp` help, the README and `listTools` name the same seven tools.
- **`atlas index --verbose`** lists the oversized and diagnostic files that the summary refers to. The counts
  match the A11-04 behaviour already recorded.
- **Not filed (already recorded):**
  - a graph `symbol` that matches nothing returns an empty, untruncated graph on every surface (a behaviour,
    consistent across surfaces);
  - `handleSymbolTool` accepts `limit: 0` (returns `[]`) and `limit: -1` (all but the last match) when called
    directly, because its limit is not in `core/params.ts` (A11-11);
  - search hit shapes (A3-11);
  - `/api/doc/file/:id` addressing (A3-12, A7-09);
  - `index`'s positional path (A3-13);
  - `atlas init`'s "(phase 2)" hint (A7-11).

## Re-verified

`audit-3`, `-7`, `-11`, `-15`, `-19`, `-23`, `-27`, `-31`, `-37`, `-41`, `-44` and `-48`, as they are: 12 files,
130 tests, green in 86 s. Every `it.fails` still fails, so the findings below remain open. No `src/` file has
changed since AUDIT-48.

| ID | Finding | Status | Evidence now |
| --- | --- | --- | --- |
| A48-01 | a deleted, renamed or unreadable file drops out of `ask` with no note; drift shows a hash | open | `it.fails` still fails; `textForSymbol.ts` unchanged |
| A48-02 | `atlas docs` writes a source-less doc for an unindexed edit and says "generated" | open | `it.fails` still fails |
| A48-03 | drift text, `formatted` and `ci-comment` cut `unindexed` to `unindexe` | open | `it.fails` still fails |
| A48-04 | `atlas_ask`'s note says `run \`atlas index\`` | open | `it.fails` still fails |
| A48-05 | `atlas_symbol` returns `excerpt: null` with `truncated: true` | open | `it.fails` still fails |
| A48-06 | `retrieve` is not exported; `retrieveForQuery` drops changed files silently | open | `it.fails` still fails |
| A48-07 | the `atlas_symbol` description and the README omit the null excerpt and the note | open | `it.fails` still fails |
| A44-01, A44-02 | move-back offer at startup; two-line `cannot check` | open | `it.fails` still fail (with `cc` present) |
| A41-02, A41-04 | three error kinds for `cannot check`; DECISIONS half of SG150 | open | `it.fails` still fail |
| A37-01..A37-05 | leftover-WAL reminder, rename, 60 s wait, README `isError`, plain `Error` | open | `it.fails` still fail |
| A31-03, A31-04 | renamed-in index under `atlas mcp`; 0-byte index on `atlas serve` | open | `it.fails` still fail |
| A27-01..A27-03 | bare `disk I/O error`; deleted-index answers; blocked MCP loop | open | `it.fails` still fail |

## Notes

- `atlas_symbol`'s `stale` flag is still a pending owner decision (AUDIT-48 notes, PLAN SG240). It is not rated
  here.
- A52-01 relies on the public registry as of the audit date. The test checks the repository side only (bare
  `npx atlas` in the README and `"name": "atlas"`), so it stays deterministic offline.
- Scratch (`audit-52/`): `p1.mts`/`p2.mts` (handler and SDK drivers) and the sample copies. Deleted at the end.
