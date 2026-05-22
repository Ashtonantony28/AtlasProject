#!/usr/bin/env bash
# Verify Atlas CJS require() detection against an npm package and its dependencies.
# Usage: scripts/verify-external.sh [package-name]   (default: express)
#
# Strategy: npm-installs the package, then copies its full node_modules tree into
# a flat "packages/" directory (no node_modules nesting) so our walker can index
# the whole dependency graph without the built-in node_modules exclusion.
# Expected ballpark for express@4: ~150–160 imports, ~340–360 edges from ~100 JS files.

set -euo pipefail
cd "$(dirname "$0")/.."

PKG="${1:-express}"
INSTALL_DIR="/tmp/atlas-verify-install-${PKG}"
FLAT_DIR="/tmp/atlas-verify-flat-${PKG}"
ATLAS="node ./dist/cli/index.js"

echo "== build =="
npm run --silent build

echo
echo "== install ${PKG} and deps =="
if [[ ! -d "${INSTALL_DIR}/node_modules" ]]; then
  mkdir -p "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
  npm init -y > /dev/null
  npm install "${PKG}" 2>&1 | tail -3
  cd -
  echo "Installed ${PKG} in ${INSTALL_DIR}"
else
  echo "Reusing existing ${INSTALL_DIR}"
fi

echo
echo "== flatten dependency tree (bypass node_modules exclusion) =="
if [[ ! -d "${FLAT_DIR}/packages" ]]; then
  mkdir -p "${FLAT_DIR}"
  find "${INSTALL_DIR}/node_modules" -maxdepth 2 -name "*.js" | while read -r f; do
    rel="${f#${INSTALL_DIR}/node_modules/}"
    pkg_name=$(echo "$rel" | cut -d/ -f1)
    rest="${rel#${pkg_name}/}"
    target_dir="${FLAT_DIR}/packages/${pkg_name}/$(dirname "$rest")"
    mkdir -p "$target_dir"
    cp "$f" "${target_dir}/" 2>/dev/null || true
  done
  echo "Flattened $(find "${FLAT_DIR}" -name '*.js' | wc -l) JS files into ${FLAT_DIR}/packages/"
else
  echo "Reusing existing flat tree ($(find "${FLAT_DIR}" -name '*.js' | wc -l) JS files)"
fi

echo
echo "== init =="
rm -rf "${FLAT_DIR}/.atlas" "${FLAT_DIR}/atlas.config.json"
$ATLAS init --cwd "${FLAT_DIR}"

echo
echo "== index =="
$ATLAS index "${FLAT_DIR}"

echo
echo "== stats =="
DB="${FLAT_DIR}/.atlas/index.db"
node --input-type=module <<EOF
import { openDatabase } from '/home/user/AtlasProject/dist/core/db/index.js';
const db = openDatabase('${DB}');
const files   = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
const symbols = db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;
const imports = db.prepare('SELECT COUNT(*) AS n FROM imports').get().n;
const edges   = db.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
console.log('  files:  ', files);
console.log('  symbols:', symbols);
console.log('  imports:', imports);
console.log('  edges:  ', edges);
db.close();
EOF

echo
echo "== done =="
