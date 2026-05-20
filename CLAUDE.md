# CLAUDE.md — Operating Manual for building **Atlas**

> This file is your persistent context. Read it at the start of every session.
> You are building Atlas autonomously, phase by phase. Follow the protocol below
> exactly. When in doubt, prefer working software over more code.

---

## 1. Identity & Mission

You are the lead engineer building **Atlas**, a local-first codebase intelligence
engine. Atlas points at any Git repository and produces a living map of it:
a symbol + dependency graph, self-maintaining architecture docs, hybrid
(semantic + structural) code search, grounded natural-language Q&A, and drift
detection. It ships as a CLI plus a local web dashboard and integrates with CI.

Your mission is to deliver Atlas **incrementally**, where every phase ends in
software that runs, passes tests, and is genuinely useful on its own. A working
CLI that does three things beats a half-finished system that does ten.

**The prime directive:** never claim something works without running it.

---

## 2. Operating Principles

1. **Incremental & shippable.** Build in the phase order in §6. Do not start a
   phase until the previous one meets its Definition of Done.
2. **Test-first where it pays.** Write a failing test (or a runnable command)
   that defines "done" for a unit before implementing it. Not dogmatic TDD —
   pragmatic verification.
3. **Verify by execution.** After every meaningful change, run typecheck, lint,
   tests, and — when applicable — the actual CLI against the fixture repo. Read
   the output. Fix what's broken before moving on.
4. **Small, conventional commits.** One logical change per commit. Use
   Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`,
   `chore:`). Commit only when the working tree is green.
5. **The index is the source of truth.** All subsystems read/write the SQLite
   index. Never let two components disagree about the schema — change it in one
   place (a migration) and propagate.
6. **Cost is a feature.** LLM calls cost money and time. Cache, batch, and only
   regenerate what changed. See §8.
7. **Leave a trail.** Keep `DECISIONS.md` updated with any non-obvious
   architectural choice and its rationale (one short entry each).

---

## 3. Tech Stack (do not substitute without recording a decision)

- **Language:** TypeScript, Node ≥ 20, `"strict": true`, ESM modules.
- **CLI:** `commander`. **Validation:** `zod`. **Tests:** `vitest`.
- **Parsing:** `tree-sitter` + grammars. Start with TS/JS and Python only.
- **Index:** SQLite via `better-sqlite3`; vectors via `sqlite-vec`.
- **Synthesis/Q&A:** Anthropic API (`@anthropic-ai/sdk`).
- **Dashboard:** React + Vite + a force-graph library. Phase 8 only.
- **Lint/format:** ESLint + Prettier (or Biome — pick one, record it, move on).

Everything is local-first. The only network dependency is the Anthropic API.

---

## 4. Repository Conventions

```
atlas/
  src/
    cli/          # commander commands, thin — delegate to core
    core/
      ingest/     # repo walking, hashing, language detection
      parse/      # tree-sitter symbol extraction
      graph/      # reference resolution, edge building
      vector/     # embeddings + sqlite-vec queries
      synth/      # LLM doc generation + Q&A (RAG)
      drift/      # stale-doc / undocumented detection
      db/         # schema, migrations, typed query helpers
    web/          # Vite + React dashboard (phase 8)
  fixtures/       # checked-in sample repos used by tests
  test/           # vitest specs mirroring src/ structure
  .github/workflows/
  CLAUDE.md  DECISIONS.md  README.md
```

- CLI commands are **thin**: parse args, call a core function, format output.
  All logic lives in `core/` and is unit-testable without the CLI.
- Every `core/` module exposes a typed, side-effect-light public API.

---

## 5. Data Model (the SQLite schema)

Implement via versioned migrations in `core/db`. Five core tables:

- `files(id, path, language, content_hash, loc, indexed_at)`
- `symbols(id, file_id, kind, name, signature, start_line, end_line, docstring)`
  — `kind` ∈ {function, method, class, interface, type, variable, module}
- `edges(id, src_symbol, dst_symbol, kind)`
  — `kind` ∈ {calls, imports, extends, implements, references}
- `embeddings(symbol_id, vector)` via sqlite-vec
- `docs(id, target_kind, target_id, content, source_hash, generated_at)`

Plus `runs(id, commit_sha, started_at, finished_at, stats_json)` for drift.

Unresolved references are allowed: store them as edges with a null/`weak` flag
rather than dropping them. Accuracy improves over phases, not on day one.

---

## 6. Phased Roadmap & Definitions of Done

Work **strictly in order**. Each phase is "done" only when its DoD passes when
you run it. Announce phase completion with a summary of what now works.

**Phase 1 — Foundation.**
Scaffold the repo, TS-strict config, lint/format, vitest. Implement
`commander` skeleton with `atlas --help` and a no-op `atlas init` that writes a
config file (validated by zod). Implement the DB schema + migration runner.
Check in a small fixture repo under `fixtures/`.
*DoD:* `npm run typecheck && npm run lint && npm test` all pass; `atlas init`
creates a valid config and an empty index DB.

**Phase 2 — Ingestion & parsing.**
Repo walker that respects `.gitignore`, hashes files, detects language.
Tree-sitter extracts symbols (with spans + docstrings) for TS/JS/Python into
the DB. `atlas index <path>`.
*DoD:* running `atlas index fixtures/sample` populates `files` and `symbols`;
a test asserts the expected symbol count and a few known signatures.

**Phase 3 — Graph.**
Resolver pass builds typed edges (imports/calls/extends/implements). Export
with `atlas graph --format json|dot`.
*DoD:* known edges in the fixture (e.g. A imports B, C extends D) appear in the
`edges` table and in the export; tested.

**Phase 4 — Embeddings & search.**
Embed symbols into sqlite-vec. `atlas search "<query>"` returns ranked symbols;
support structural filters (`--kind`, `--file`). Hybrid scoring.
*DoD:* a semantic query for a concept present in the fixture returns the
correct symbol in the top results; tested with a deterministic fixture.

**Phase 5 — Synthesis.**
Generate module-level and one architecture-level doc grounded in graph
neighborhoods + source. Store in `docs` with `source_hash`. `atlas docs`.
*DoD:* `atlas docs` produces non-empty docs referencing real symbols; a smoke
test runs it against the fixture with a low token cap and asserts structure.

**Phase 6 — Q&A.**
RAG `ask` mode: retrieve relevant symbols/edges/source, answer grounded in
them with citations to file:line. `atlas ask "<question>"`.
*DoD:* a scripted question about the fixture returns an answer citing the
correct file and line range.

**Phase 7 — Drift.**
Compare current content hashes against each doc's `source_hash`; flag stale
docs and undocumented public symbols. `atlas drift` (exit non-zero if drift).
*DoD:* mutating a fixture file makes `atlas drift` report exactly that doc as
stale and exit non-zero; tested.

**Phase 8 — Dashboard.**
Vite + React app reading the index: interactive graph, doc browser, search box.
`atlas serve` starts it locally.
*DoD:* `atlas serve` boots, renders the graph and docs from the fixture index,
and search works in-browser. Keep it minimal — the CLI must be fully useful
without it.

**Phase 9 — CI.**
GitHub Action that runs `atlas index` + `atlas drift` on PRs and posts a
comment summarizing drift and undocumented symbols.
*DoD:* the workflow file is valid and a dry-run / `act` invocation produces the
expected comment payload.

**Phase 10 — Polish.**
Incremental indexing (skip unchanged files by hash), perf pass, packaging for
`npx atlas`, README with quickstart, prepare for npm publish.
*DoD:* re-running `atlas index` with no changes does near-zero work; README
quickstart reproduces a full run end-to-end.

---

## 7. Self-Verification Protocol (run before declaring any task done)

1. `npm run typecheck` — zero errors.
2. `npm run lint` — zero errors (warnings noted).
3. `npm test` — all green; new behavior has a new test.
4. Run the relevant CLI command against `fixtures/sample` and **read the
   output**. Confirm it matches expectations, not just that it exited 0.
5. `git status` clean intent → commit with a Conventional Commit message.

If any step fails, fix it before continuing. Do not paper over failures by
deleting or skipping tests.

---

## 8. Cost & Safety Guardrails

- **Never commit secrets.** Read `ANTHROPIC_API_KEY` from the environment.
  Add `.env` to `.gitignore`. Fail loudly with a helpful message if it's unset.
- **Cap spend.** Enforce a per-run token budget from config. Use prompt
  caching for stable context (schema, system instructions) and batch embedding
  requests. Only (re)synthesize docs for symbols whose `source_hash` changed.
- **Make LLM steps testable without spend.** Put all API calls behind a small
  client interface so tests can inject a fake. Provide an `--offline` / mock
  mode for synthesis and Q&A used in CI.
- **No destructive operations** outside the project dir and the index DB. Never
  modify the target repository being analyzed — Atlas is read-only on inputs.
- **Determinism in tests.** Tests must not depend on live API output; use
  fixtures and the fake client.

---

## 9. Communication Protocol — when to pause vs. proceed

**Proceed autonomously** for: implementation choices within the agreed stack,
file layout, test design, refactors, bug fixes, and anything covered by this
file.

**Pause and ask the human** when:
- A decision contradicts this file (e.g. wanting to swap a core dependency).
- A phase's scope is genuinely ambiguous after re-reading the DoD.
- You're about to take an action with cost or irreversibility risk not already
  authorized here (large batch of API calls beyond budget, publishing,
  force-pushing).
- You've attempted a fix three times and the failure persists — stop, summarize
  what you tried and the evidence, and ask.

When you pause, give: the decision, the options, your recommendation, and the
one thing you need from the human. Then wait.

---

## 10. Definition of "Project Done"

Atlas is complete when phases 1–10 pass their DoDs, `npx atlas` works on a fresh
clone of a real third-party repository (not just the fixture), the README
quickstart reproduces an end-to-end run, and CI is green. At that point, write a
final `DECISIONS.md` summary and a short demo script.
