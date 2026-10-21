#!/bin/bash
# Checks the built extension against published @electric-sql/pglite releases.
#
#   scripts/compat-matrix.sh              every release matching package/package.json peerDependencies
#   scripts/compat-matrix.sh 0.5.3 0.5.10 just these
#
# For each release: check-imports.mjs against its pglite.wasm/pglite.js (missing imports only fail
# when first called, so a load test alone can't catch them), then the package's test suite with
# @electric-sql/pglite aliased to that release. Needs package/release/rdkit.tar.gz (scripts/build.sh)
# and package/node_modules (npm ci in package/).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SO_DIR=$ROOT/build/compat/rdkit
TARBALL=$ROOT/package/release/rdkit.tar.gz

if [ ! -f "$TARBALL" ]; then
  echo "missing $TARBALL; run scripts/build.sh first" >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  VERSIONS="$*"
else
  RANGE=$(node -p "require('$ROOT/package/package.json').peerDependencies['@electric-sql/pglite']")
  VERSIONS=$(npm view "@electric-sql/pglite@$RANGE" version --json | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"))
    console.log([].concat(v).join(" "))')
  echo "releases matching $RANGE: $VERSIONS"
fi

rm -rf "$SO_DIR" && mkdir -p "$SO_DIR"
tar -xzf "$TARBALL" -C "$SO_DIR"
SO=$SO_DIR/lib/postgresql/rdkit.so

FAILED=""
SUMMARY=""
for v in $VERSIONS; do
  dir=$ROOT/build/compat/pglite-$v
  if [ ! -f "$dir/package/dist/pglite.wasm" ]; then
    rm -rf "$dir" && mkdir -p "$dir"
    (cd "$dir" && npm pack --silent "@electric-sql/pglite@$v" > /dev/null && tar -xzf ./*.tgz)
  fi
  pkg=$dir/package

  echo "=== @electric-sql/pglite@$v"
  imports=ok
  node "$ROOT/scripts/check-imports.mjs" "$SO" "$pkg/dist/pglite.wasm" "$pkg/dist/pglite.js" || imports=FAIL
  tests=ok
  (cd "$ROOT/package" && PGLITE_DIR="$pkg/dist/index.js" npx vitest run) || tests=FAIL

  SUMMARY="$SUMMARY$(printf '%-8s imports: %-4s tests: %s' "$v" "$imports" "$tests")\n"
  if [ "$imports" != ok ] || [ "$tests" != ok ]; then FAILED="$FAILED $v"; fi
done

echo
printf "$SUMMARY"
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
echo "all compatible"
