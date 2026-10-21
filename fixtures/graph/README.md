# Graph fixture

Golden fixture for the resolver. `expected-edges.json` lists every true edge as
`path::qualified_name` (`path::<module>` for a file's module symbol). Calls that
appear only in comments or strings (`web/decoys.ts`, `py/pkg/sub/service.py`) must
produce no edges.
