#!/usr/bin/env bash
# Atlas end-to-end demo. Runs every CLI command against the fixture repo,
# with the offline mock LLM so it works without an API key.

set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURE="fixtures/sample"

echo "== build =="
npm run --silent build

ATLAS="node ./dist/cli/index.js"

echo
echo "== init =="
rm -rf "$FIXTURE/.atlas" "$FIXTURE/atlas.config.json"
$ATLAS init --cwd "$FIXTURE"

echo
echo "== index =="
$ATLAS index "$FIXTURE"

echo
echo "== search: 'circle area' =="
$ATLAS search "circle area" --limit 5 --cwd "$FIXTURE"

echo
echo "== search: --kind class =="
$ATLAS search "shape" --kind class --cwd "$FIXTURE"

echo
echo "== graph (json head) =="
$ATLAS graph --format json --cwd "$FIXTURE" | head -20
echo "..."

echo
echo "== docs (offline) =="
$ATLAS docs --offline --cwd "$FIXTURE"

echo
echo "== docs --show src/shapes.ts =="
$ATLAS docs --show src/shapes.ts --cwd "$FIXTURE"

echo
echo "== ask (offline) =="
$ATLAS ask --offline --cwd "$FIXTURE" "How is the area of a circle computed?"

echo
echo "== drift (expects exit 2 in this demo) =="
set +e
$ATLAS drift --cwd "$FIXTURE"
DRIFT_RC=$?
set -e
echo "drift exit code: $DRIFT_RC"

echo
echo "== ci-comment =="
$ATLAS drift --json --cwd "$FIXTURE" > /tmp/atlas-demo-drift.json || true
$ATLAS ci-comment --in /tmp/atlas-demo-drift.json | head -20
echo "..."

echo
echo "== second index run (incremental) =="
$ATLAS index "$FIXTURE"

echo
echo "== done. To open the dashboard:"
echo "    node ./dist/cli/index.js serve --cwd $FIXTURE"
