#!/usr/bin/env bash
# Atlas: end-to-end verification on a real, third-party repo.
#
# Clones a small/mid-sized public repo into a temp dir, runs the full Atlas
# pipeline (init → index → search → docs → ask → drift → ci-comment), and
# asserts that known symbols, edges, and search results are present.
#
# Usage:
#   scripts/verify-external.sh                   # got (default, ESM/TS)
#   scripts/verify-external.sh express           # express (CommonJS/JS)
#
# Requires: git, a built Atlas (`npm run build`), Node ≥ 20.

set -euo pipefail

TARGET="${1:-got}"
ATLAS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ATLAS="node ${ATLAS_DIR}/dist/cli/index.js"
WORK="$(mktemp -d -t atlas-verify-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

case "$TARGET" in
  got)
    REPO_URL="https://github.com/sindresorhus/got.git"
    REPO_DIR="$WORK/got"
    # Assertions
    ASSERT_FILE="source/index.ts"
    ASSERT_SYMBOL="got"
    ASSERT_KIND="variable"
    SEARCH_QUERY="retry delay"
    SEARCH_EXPECT="source/core/options.ts"
    MIN_FILES=70
    MIN_SYMBOLS=2000
    MIN_EDGES=900
    ;;
  express)
    REPO_URL="https://github.com/expressjs/express.git"
    REPO_DIR="$WORK/express"
    ASSERT_FILE="lib/express.js"
    ASSERT_SYMBOL="createApplication"
    ASSERT_KIND="function"
    SEARCH_QUERY="create application"
    SEARCH_EXPECT="lib/express.js"
    MIN_FILES=100
    MIN_SYMBOLS=1500
    MIN_EDGES=300
    ;;
  *)
    echo "unknown target: $TARGET" >&2
    echo "usage: $0 [got|express]" >&2
    exit 2
    ;;
esac

if [ ! -f "${ATLAS_DIR}/dist/cli/index.js" ]; then
  echo "atlas: dist/ missing — run \`npm run build\` first" >&2
  exit 1
fi

echo "== cloning $TARGET (shallow) =="
git clone --depth 1 --quiet "$REPO_URL" "$REPO_DIR"

echo
echo "== atlas init =="
$ATLAS init --cwd "$REPO_DIR"

echo
echo "== atlas index =="
INDEX_OUT="$($ATLAS index "$REPO_DIR")"
echo "$INDEX_OUT"

# Parse totals out of the index output.
FILES=$(echo "$INDEX_OUT" | sed -n 's/^totals: files=\([0-9]*\).*/\1/p')
SYMBOLS=$(echo "$INDEX_OUT" | sed -n 's/^totals:.*symbols=\([0-9]*\).*/\1/p')
EDGES=$(echo "$INDEX_OUT" | sed -n 's/^totals:.*edges=\([0-9]*\).*/\1/p')

echo
echo "== assertions =="
fail=0
require_at_least() {
  local name="$1" actual="$2" min="$3"
  if [ "$actual" -ge "$min" ]; then
    echo "  ok   ${name}: ${actual} (>= ${min})"
  else
    echo "  FAIL ${name}: ${actual} (< ${min})"
    fail=1
  fi
}
require_at_least "files"   "${FILES:-0}"   "$MIN_FILES"
require_at_least "symbols" "${SYMBOLS:-0}" "$MIN_SYMBOLS"
require_at_least "edges"   "${EDGES:-0}"   "$MIN_EDGES"

# Known-symbol assertion via the SQLite index.
SYM_OUT=$(node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('$REPO_DIR/.atlas/index.db', { readonly: true });
const row = db.prepare(\"SELECT s.kind FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path='$ASSERT_FILE' AND s.name='$ASSERT_SYMBOL'\").get();
process.stdout.write(row ? row.kind : 'MISSING');
db.close();
")
if [ "$SYM_OUT" = "$ASSERT_KIND" ]; then
  echo "  ok   known symbol: $ASSERT_FILE :: $ASSERT_SYMBOL = $ASSERT_KIND"
else
  echo "  FAIL known symbol: $ASSERT_FILE :: $ASSERT_SYMBOL expected $ASSERT_KIND, got $SYM_OUT"
  fail=1
fi

# Search must surface the expected file in the top 5 results for the query.
SEARCH_OUT=$($ATLAS search "$SEARCH_QUERY" --cwd "$REPO_DIR" --limit 5 --json | python3 -c "import json,sys; r=json.load(sys.stdin); print('\n'.join(h['file'] for h in r))")
if echo "$SEARCH_OUT" | grep -q "$SEARCH_EXPECT"; then
  echo "  ok   search '$SEARCH_QUERY' surfaces $SEARCH_EXPECT in top 5"
else
  echo "  FAIL search '$SEARCH_QUERY' missed $SEARCH_EXPECT (top 5: $SEARCH_OUT)"
  fail=1
fi

echo
echo "== atlas docs (offline) =="
$ATLAS docs --offline --cwd "$REPO_DIR" | tail -3

echo
echo "== atlas drift =="
set +e
$ATLAS drift --cwd "$REPO_DIR" --json > "$REPO_DIR/.atlas/drift.json"
DRIFT_RC=$?
set -e
echo "drift exit: $DRIFT_RC (0 = clean, 2 = drift detected, 1 = error)"
test "$DRIFT_RC" -eq 0 -o "$DRIFT_RC" -eq 2

echo
echo "== ci-comment payload (first 15 lines) =="
$ATLAS ci-comment --in "$REPO_DIR/.atlas/drift.json" | head -15

echo
echo "== incremental re-index =="
$ATLAS index "$REPO_DIR" | head -3

echo
echo "== target untouched outside .atlas/ =="
DIRTY=$(git -C "$REPO_DIR" status --porcelain --untracked-files=all | grep -v '^?? \.atlas/' || true)
if [ -z "$DIRTY" ]; then
  echo "  ok   git status shows only .atlas/"
else
  echo "  FAIL target modified outside .atlas/:"
  echo "$DIRTY"
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "verify-external: FAILED"
  exit 1
fi
echo "verify-external: ok ($TARGET)"
