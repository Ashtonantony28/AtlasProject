# DECISIONS

A running log of non-obvious architectural choices and their rationale. Append
one short entry per decision (newest at the bottom).

---

## 2026-05-20 — Lint/format: ESLint + Prettier (not Biome)
ESLint v9 flat config + Prettier. Mature TS plugin ecosystem, easier to debug
when CI fails. CLAUDE.md said "pick one and move on".

## 2026-05-20 — Embeddings stored as raw BLOB (not sqlite-vec virtual table) in Phase 1
sqlite-vec is added in Phase 4; for Phase 1 the table is a plain BLOB so the
schema works on any SQLite build. We can switch to a virtual table in a later
migration without breaking earlier phases.

## 2026-05-20 — Tree-sitter pin: 0.21.x line, tree-sitter-python pinned to 0.23.2
tree-sitter-python@0.23.6 requires tree-sitter@^0.22, but tree-sitter-javascript
and tree-sitter-typescript still target 0.21. Pinning python to 0.23.2 (which
accepts ^0.21.0) keeps the native bindings on a single tree-sitter version. Re-
visit when JS/TS grammars publish 0.22-compatible builds.

## 2026-05-20 — Synthesis model default: claude-sonnet-4-6
Sonnet 4.6 is the right default for doc synthesis: cheaper than Opus, strong
enough for grounded summaries. Users can override per-run.

## 2026-05-20 — Imports table separate from edges
Imports are recorded as their own table during ingestion (raw module strings,
aliases) and *also* materialized into the edges table during the Phase 3
resolver pass. Keeping the raw form lets the resolver re-run as the graph
algorithm improves without re-parsing every file.

## 2026-05-20 — Weak edges, not dropped edges
Unresolved references are stored with `weak = 1` rather than discarded. This
makes precision/recall tradeoffs visible and lets later passes upgrade them.

## 2026-05-20 — Local embedding fallback
Phase 4 will ship with a deterministic, dependency-free "local-hash-v1"
embedding so semantic search works offline and in CI without API spend. A real
provider (Voyage / Anthropic) can be wired in behind the same interface later.
