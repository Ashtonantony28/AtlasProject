# AUDIT-48: API and SDK consistency, round 12

This audit checks how the CLI, the dashboard HTTP API (`atlas serve`), the MCP tools (SDK over stdio and in-memory)
and the exported core APIs behave after SG240, and whether `README.md`, `DECISIONS.md` and the tool descriptions
match the code. Since AUDIT-44 (`ead477f`) the only `src/` change is SG240 (#94); SG230 (#92) is test-only
(`git diff --stat ead477f HEAD -- src`). SG240 changed:
- `readIndexedSource(root, file)` (`src/core/vector/textForSymbol.ts`) reads a file and returns `source: null,
  changed: true` when its sha256 is not `files.content_hash`, and `source: null, changed: false` when it cannot
  be read;
- `handleSymbolTool` (`atlas_symbol`), `retrieve` (`atlas ask`, `atlas_ask`), `buildModuleContext` (`atlas
  docs`, drift's prompt hash) and drift's `unindexed` check read through it;
- `ask` appends `Note: <paths> changed since indexing, so its snippets were left out; run \`atlas index\`.` to
  the answer. No result gains a field. `atlas_symbol` returns `excerpt: null`; whether it should also carry a
  `stale` flag is a pending owner decision (PLAN SG240 row, DECISIONS SG240 entry), which this audit notes but
  does not rate.

Base: `9f3b7fc` on `claude/atlas-audit-48`. Date: 2026-10-27. The auditor wrote none of this code.
`@modelcontextprotocol/sdk` 1.32.1, better-sqlite3 11.10.0, Node 22.

**Method.**
- I drove the CLI as `node --import tsx src/cli/index.ts` on copies of `fixtures/sample` and read stdout, stderr
  and the exit code separately.
- I called the MCP handlers in-process and through the stock SDK `Client` over `InMemoryTransport`, and queried
  `atlas serve` (`startServer`, read-only connection) with `fetch`.
- I called the exported core APIs (`ask`, `retrieveForQuery`, `runDrift`, `formatDriftReport`) directly.
- The edit is SG240's acceptance edit: 12 comment lines prepended to `src/math.ts` with no re-index. A deleted
  file is `rm src/math.ts` with no re-index.

Repros are in `test/audit/audit-48.test.ts` as `it.fails`, named by ID. I ran each one as a plain `it` and
confirmed that it fails on the last assertion, which names the defect. Each failure is quoted under **Test**.
Nothing needs `cc`.

**Totals:** 0 critical, 0 high, 1 medium, 6 low. No new SG rows.

## Findings

### Critical

None found.

### High

None found.

### Medium

**A48-01: a file deleted, renamed or made unreadable since indexing loses its snippets in `ask` and `atlas_ask`
with no note. An edited file gets `Note: … changed since indexing …`. `atlas_symbol` gives `excerpt: null` for
both, and drift reports the deleted file with a real hash, not `unindexed` or `missing`.** Medium.
- **Evidence:** index the sample, then `rm src/math.ts` with no re-index.
  - `atlas ask --offline "What does add do?"` exits 0. It cites four `src/shapes.ts` snippets, and the answer
    has no note. The same question after the 12-line edit ends with `Note: src/math.ts changed since indexing,
    so its snippets were left out; run \`atlas index\`.`. `atlas_ask` matches in both cases.
  - `atlas_symbol {name: "add"}` returns `excerpt: null` with the indexed `startLine: 4`, `endLine: 6` and
    `signature`. That is the same response as for the edit, so a client cannot tell "deleted" from "edited" from
    "unreadable".
  - `atlas drift` prints `[file] src/math.ts (stored df53c22c, current c41c2b52)` and exits 2. The edit gives
    `current unindexe` (A48-03). The deleted file has a hash because `readIndexedSource` returns
    `changed: false` for an unreadable file, so the prompt is hashed without source.
- **Impact:**
  - SG240 wants `ask` to say that the file changed since indexing instead of answering as if it had no symbols.
    A rename (`git mv` without `atlas index`) or a delete is the most common unindexed change, and it gets the
    silent path.
  - The answer is grounded only in other files. Nothing on the CLI, `--json` or MCP says that a file the index
    still lists was left out.
  - This is medium, not high: no wrong lines are served (SG240's goal holds), and the answer reads like "not
    derivable".
- **Test:** `A48-01`. As a plain `it`, it fails with `expected 'Based on the grounded snippets, here …' to match
  /src\/math\.ts[^\n]*since indexing/`.
- **Repro:**
  1. `cp -r fixtures/sample R && atlas index R`.
  2. `rm R/src/math.ts`.
  3. Run `atlas ask --offline --cwd R "What does add do?"`. Compare the result with step 2 replaced by the
     12-line prepend.
- **Location:**
  - `src/core/vector/textForSymbol.ts:95` (`catch { return { source: null, changed: false } }`);
  - `src/core/qa/retrieve.ts:81-87` (only `read.changed` reaches `changed`);
  - `src/core/drift/detect.ts:98-100`.
- **Fix:** have `readIndexedSource` report an unreadable indexed file as `changed: true`, or give it a third
  state, `missing`. `retrieve` then lists it, and `ask` says `<path> changed or was removed since indexing …`.
  Drift should report it as `unindexed` or `missing`, as it does after a re-index prunes it.

### Low

**A48-02: `atlas docs` on a file edited since indexing writes that file's doc from a prompt with no source, and
reports it as generated. `atlas drift` then fails on it, a second `atlas docs` reports it as cached, and neither
command says to run `atlas index`. Only `ask` says so.** Low.
- **Evidence:**
  - After the 12-line edit, `atlas docs --offline` prints `modules: generated 4, cached 0, skipped 0, failed 0`
    and `persisted: 5 docs in .atlas/docs (5 written, 0 removed)`, then exits 0.
  - `atlas drift` prints `[file] src/math.ts (stored c41c2b52, current unindexe)` and exits 2.
  - A second `atlas docs --offline` prints `generated 0, cached 4`, and `atlas drift` still exits 2.
  - `buildModuleContext` drops the snippets silently, because `readIndexedSource` returns `source: null`.
- **Impact:**
  - A user who runs docs then drift is left with a doc grounded only in symbol names, written to `.atlas/docs`
    (which the CI workflow commits), and a drift failure with no remedy. Docs and drift are the two other
    surfaces that SG240 changed.
  - It heals: after `atlas index` the prompt holds the source again, so the doc is regenerated. CI runs
    `atlas index` first, so CI is unaffected. That is why this is low.
- **Test:** `A48-02`. As a plain `it`, it fails with `expected 'modules: generated 4, cached 0, skipp…' to
  match /src\/math\.ts[^\n]*(since indexing|atlas index)/`.
- **Location:**
  - `src/core/synth/context.ts:146` (`const { source } = readIndexedSource(root, file)`; `changed` is ignored);
  - `src/core/synth/synthesize.ts`;
  - `src/cli/commands/docsCmd.ts`.
- **Fix:** one of the following.
  - Skip such a file in `synthesizeDocs`, count it as `skipped` and name it with `changed since indexing; run
    \`atlas index\``. This matches `ask`.
  - Refuse `atlas docs` while any file is behind the index, with the same remedy.

**A48-03: the drift text report cuts the `unindexed` sentinel to `unindexe`.** Low.
- **Evidence:** `atlas drift`, `atlas_drift {formatted: true}` and `atlas ci-comment --in <drift.json>` (`| \`unindexe\` |`) all print
  `current unindexe`, because they slice `currentHash` to 8 characters. `missing` (7 characters) comes through
  whole. `--json` and the `atlas_drift` object carry `"unindexed"`.
- **Impact:**
  - The one word that tells the user the index is behind the file reaches the human-readable surfaces (the
    terminal and the PR comment) misspelt, with no remedy (A48-02).
  - The JSON surfaces are correct.
- **Test:** `A48-03`. As a plain `it`, it fails with `expected 'Stale docs:\n  - [file] src/math.ts  …' to match
  /current unindexed\b/`.
- **Location:**
  - `src/core/drift/detect.ts:211`;
  - `src/cli/commands/ciCommentCmd.ts:137`.
- **Fix:** slice only real hashes. For example, use `/^[0-9a-f]{64}$/.test(h) ? h.slice(0, 8) : h`, and say
  `run \`atlas index\`` next to `unindexed`.

**A48-04: `atlas_ask`'s note tells the MCP client to `run \`atlas index\``. Every other MCP message says to call
`atlas_index`.** Low.
- **Evidence:**
  - After the edit, `atlas_ask`'s `answer` ends with `… so its snippets were left out; run \`atlas index\`.`.
  - Other MCP messages use the MCP form: an empty index gives `index is empty: call atlas_index first`, which
    the README pins ("MCP: \"index is empty: call atlas_index first\"").
  - The SG240 row in PLAN asked for "a hint to run `atlas_index`".
  - The note comes from the core `ask`, which does not know which surface called it.
- **Impact:** an agent that follows the note shells out to a CLI it may not have, instead of calling the tool
  it does have. This is cosmetic for a human reader.
- **Test:** `A48-04`. As a plain `it`, it fails with `expected 'Based on the grounded snippets, here …' to match
  /atlas_index/`.
- **Location:**
  - `src/core/qa/ask.ts:89-92`;
  - `src/mcp/server.ts:handleAskTool`.
- **Fix:** take the remedy as a parameter. `requireIndexed(db, remedy)` already does this. Pass `call
  atlas_index` from `handleAskTool`.

**A48-05: `atlas_symbol` reports `truncated: true` for an excerpt that it withheld (`excerpt: null`).** Low.
- **Evidence:**
  - Index a sample with a 133-line `longFn`, then append one line to its file.
  - `atlas_symbol {name: "longFn"}` returns `excerpt: null, truncated: true`. `truncated` is computed from the
    symbol's span, whether or not an excerpt exists.
- **Impact:** a client that sees `truncated: true` concludes that it has a partial excerpt, and may page or ask
  for more. The two fields contradict each other. This also ties into the pending `stale` decision.
- **Test:** `A48-05`. As a plain `it`, it fails with `expected true to be false`.
- **Location:** `src/mcp/server.ts:234-235`.
- **Fix:** `truncated: lines !== null && end < s.end_line`.

**A48-06: the exported core API cannot tell a caller which files were left out. `retrieveForQuery` returns
fewer snippets with no signal, and `retrieve`, which returns `changed`, is not exported. `ask` reports the same
condition only as prose in `answer`.** Low.
- **Evidence:**
  - After the edit, `retrieveForQuery(db, root, "What does add do?")` returns no `src/math.ts` snippet and
    nothing else.
  - `src/core/qa/index.ts` exports `retrieveForQuery` and `DEFAULT_EXCERPT_LINES`, but not `retrieve`.
  - `AskResult`, `--json` and `atlas_ask` carry the condition only inside `answer`. The decision was "no new
    field in any result" (DECISIONS, SG240).
  - The other surfaces signal the condition in their own ways: `atlas_symbol` as `excerpt: null` and drift as
    `currentHash: "unindexed"`.
- **Impact:** this is three different signals for one condition. A library or JSON consumer has to parse
  English to learn it. Only the exported-function half is rated. The JSON shape belongs to the owner decision
  on `stale`.
- **Test:** `A48-06`. As a plain `it`, it fails with `expected false to be true` (`'retrieve' in qa || 'changed'
  in snippets`).
- **Location:** `src/core/qa/index.ts:3`.
- **Fix:** export `retrieve`. If the owner adopts `stale`, give `AskResult` (and `--json`/`atlas_ask`) the same
  `changed: string[]` in the same decision.

**A48-07: the `atlas_symbol` tool description and the README do not say that the excerpt is `null` for a file
changed since indexing, or that `ask` and `atlas_ask` append a note and drop that file's snippets.** Low.
- **Evidence:**
  - The `atlas_symbol` description is still "… Returns location, signature, docstring and source excerpt.".
  - `README.md` has no "changed since indexing" and no `unindexed`. The MCP section lists `atlas_symbol` with
    no shape.
  - Only DECISIONS (SG240) describes the behaviour.
- **Impact:** an MCP client sees a `null` excerpt and an extra paragraph in an answer, and neither is explained
  where it would look.
- **Test:** `A48-07`. As a plain `it`, it fails with `expected 'Look up symbols by name (case-insensi…' to match
  /null|changed since index/i`. The README assertion also fails on its own (`grep -c "changed since indexing"
  README.md` gives 0).
- **Location:**
  - `src/mcp/server.ts:370`;
  - `README.md:180-200` (the MCP server section) and `README.md:160-176` (command notes for `ask`).
- **Fix:**
  - Append "The excerpt is null when the file is unreadable or changed since indexing (call atlas_index)." to
    the description.
  - Add one sentence to the README's `ask` note and MCP section.

## Scope checks

- **SG240, `ask` across surfaces (pinned):** after the edit, these give byte-identical `answer` strings:
  - `atlas ask --offline` text;
  - `atlas ask --offline --json`;
  - `ask()` with the offline client;
  - `handleAskTool`;
  - `atlas_ask` through the SDK `Client`.

  Each answer ends with `\n\nNote: src/math.ts changed since indexing, so its snippets were left out; run
  \`atlas index\`.`.
  - Text mode prints the answer (note included) on stdout, then `Sources:`. Stderr is empty and the exit code
    is 0.
  - No citation or `Sources:` line names `src/math.ts`.
  - `atlas_ask` is not `isError`.
  - Citation checks run on the model's text before the note is appended, so the note never produces a
    `flagged` entry.
  - With the file unchanged, or after `atlas_index`, no surface adds the note, and `add` is cited again.
- **SG240, `atlas_symbol` (pinned):**
  - Only the edited file's excerpt is `null`; `circle` still has its source.
  - The handler and the SDK client return the same object.
  - After `atlas_index` the excerpt is `add`'s source again.
  - `startLine`, `endLine` and `signature` remain the indexed values (stale) next to `excerpt: null`. This is
    part of the pending `stale` decision, not a finding.
- **The dashboard (pinned):** `atlas serve` has no symbol or source view.
  - `/api/search` returns `{id, name, kind, file, line, score}`.
  - `/api/files` returns file rows (`content_hash` included).
  - No `/api/*` response contains source text, so there is no stale excerpt to show.
  - The doc browser shows docs as stored. A doc that is stale (A48-02) is not marked, which predates SG240 and
    matches `atlas docs --show`.
- **The CLI equivalent of `atlas_symbol`:** there is none. `atlas search`, `atlas_search` and `/api/search`
  return locations without excerpts, so they cannot serve shifted lines. After an unindexed edit, all three
  still return the indexed line numbers, which are now off by 12. This is unchanged since before SG240, has no
  excerpt, and belongs to the `stale` decision.
- **Drift (pinned):** after the edit, `atlas_drift`, `runDrift` and `atlas drift --json` report the same
  `stale` entry with `currentHash: "unindexed"`, and the CLI exits 2. The text forms cut it (A48-03).
- **Other surfaces:** no `src/` change outside SG240's files. The earlier API audit files pin streams, exit codes,
  option names and the JSON shapes of `search`, `graph`, `docs` and `drift`, and they pass (see below). Option
  names for `ask` (`-k/--k`, `--expand`, `--offline`, `--json`, `-m/--model`) match the README and
  `AskParamsSchema`, and `atlas_ask` uses `k` and `expand`.

## Re-verified

`audit-3`, `-7`, `-11`, `-15`, `-19`, `-23`, `-27`, `-31`, `-37`, `-41` and `-44` as they are: 11 files, 119
tests, green in 97 s. With `cc` present, every `it.fails` still fails.

| ID | Finding | Status | Evidence now |
| --- | --- | --- | --- |
| A44-01 | `atlas serve`/`atlas mcp` print the move-back offer at startup, then hold the index | open | `it.fails` still fails; `database.ts` unchanged since AUDIT-44 |
| A44-02 | a `cannot check` refusal can span two stderr lines | open | `it.fails` (with `cc`) still fails; `database.ts:273` still embeds the raw `integrity_check` text |
| A41-02 | `cannot check` thrown as `SqliteError`, Node `Error` (`EIO`) or a plain `Error` | open | `it.fails` (with `cc`) still fails |
| A41-04 | DECISIONS records only SG150's reminder half; the SG140 entry says any non-`ok` result means "does not fit" | open | `it.fails` still fails; the SG140 sentence (DECISIONS:669) is unchanged |
| A37-01 | the reminder cannot be followed; a write overtakes it; MCP and HTTP silent | open | `it.fails` still fails |
| A37-02 | an index renamed over a held one is refused with the foreign-WAL remedy | open | `it.fails` still fails |
| A37-03 | 60 s wait on `.open.lock`, then blames a writer | open | `it.fails` still fails (62 s); `OPEN_LOCK_MS` is still 60 000 |
| A37-04 | the README promises MCP `isError`/HTTP 500 for refusals at open | open | `it.fails` still fails; README:247 unchanged |
| A37-05 | the replaced-WAL refusal is a plain `Error`; `openDatabase` writes to the host's stderr | open | `it.fails` still fails |
| A31-03 | a replacement renamed in under a running `atlas mcp` | open | `it.fails` still fails |
| A31-04 | `atlas serve` on a 0-byte index: 500 `no such table`, `/api/health` ok | open | `it.fails` still fails |
| A27-01 | bare `disk I/O error` on a reset beside a writing `atlas mcp` | open | `it.fails` still fails |
| A27-02 | a server answers from, and writes to, a deleted or renamed-over file | open | `it.fails` still fails |
| A27-03 | `immediate()` blocks the MCP event loop while it waits | open | `it.fails` still fails |

## Notes

- **Pending owner decision, not rated:** should `atlas_symbol` carry `stale: true` (and a hint to call
  `atlas_index`)? A48-01, A48-05 and A48-06 would all be simpler to fix inside that decision. For example, a
  `stale` value of `"changed" | "missing"`, also reflected in `ask`'s JSON, would cover all three.
- A file whose re-parse fails keeps its old rows and hash (SG2), so `ask` would keep saying `run \`atlas
  index\`` after `atlas index` has run. `parseSource` does not throw (SG11), and I found no input that makes the
  indexer's parse fail, so this is not reproduced and not rated.
- `readIndexedSource` hashes the whole file on every call (once per file per `ask`/`atlas_symbol` call, and
  once per documented file in drift). Its cost is left to the performance audit (AUDIT-47).
- Scratch (`audit-48/`): `mcp1.mts` (handler driver) and three sample copies, deleted at the end.
