#!/bin/bash
# The root README.md is the only README. This copies it to package/README.md, which npm shows
# on the package page. Runs on `npm pack`/`npm publish` (package.json prepack).
#
#   scripts/sync-readme.sh          update the copy
#   scripts/sync-readme.sh --check  exit 1 if the copy is out of date (CI)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=$ROOT/README.md
DST=$ROOT/package/README.md
NOTE='<!-- Generated from the repository root README.md by scripts/sync-readme.sh. Edit that file instead. -->'

expected() {
  echo "$NOTE"
  echo
  cat "$SRC"
}

if [ "${1:-}" = "--check" ]; then
  if ! expected | cmp -s - "$DST"; then
    echo "package/README.md is out of date; run scripts/sync-readme.sh" >&2
    exit 1
  fi
  echo "package/README.md is in sync"
else
  expected > "$DST"
fi
