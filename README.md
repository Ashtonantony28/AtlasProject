# Atlas

> Local-first codebase intelligence engine.

Atlas points at any Git repository and produces a living map of it: a symbol +
dependency graph, self-maintaining architecture docs, hybrid (semantic +
structural) search, grounded natural-language Q&A, and drift detection.

This README will grow with the project. Today, Phase 1 (Foundation) is
complete.

## Status

| Phase | Title                  | Status |
| ----- | ---------------------- | ------ |
| 1     | Foundation             | done   |
| 2     | Ingestion & parsing    | done   |
| 3     | Graph                  | done   |
| 4     | Embeddings & search    | done   |
| 5     | Synthesis              | in progress |
| 6     | Q&A                    | -      |
| 7     | Drift                  | -      |
| 8     | Dashboard              | -      |
| 9     | CI                     | -      |
| 10    | Polish                 | -      |

## Quick start (dev)

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
node ./dist/cli/index.js --help
node ./dist/cli/index.js init --cwd ./fixtures/sample
```

## Layout

See `CLAUDE.md` for the operating manual and `DECISIONS.md` for the rationale
log.
