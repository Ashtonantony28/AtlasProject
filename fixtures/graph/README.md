# Graph fixture

Golden fixture for the resolver. `expected-edges.json` lists every true edge as
`path::qualified_name` (`path::<module>` for a file's module symbol). Calls that
appear only in comments or strings (`web/decoys.ts`, `py/pkg/sub/service.py`) must
produce no edges.

SG10 cases: TS barrels (`web/ui/index.ts`: named, aliased, `export *`, `export { default as … }`
and an `export *` cycle with `web/ui/cycle.ts`), default imports (`web/store.ts`, `web/ids.ts`),
JSX component use (`web/app.tsx`), CJS defaults and a CJS barrel (`web/cjs/`), a Python package
re-export through `__init__.py` (`py/pkg/api/`), star imports, function-local imports and
subscripted bases (`py/pkg/repo.py`, `py/pkg/star_use.py`).

SG18 cases: property-assigned functions (`web/handlers.js`: `C.prototype.m = function`,
anonymous `exports.x = function`), functions used as values (`web/routes.js`, `py/pkg/hooks.py`:
callbacks, arrays, object values, `module.exports = { f }`), TS namespaces (`web/geo.ts`) and an
anonymous `export default class extends …` (`web/shape.ts`, used by `web/measure.ts`).
