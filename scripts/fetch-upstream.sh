#!/bin/bash
# Checks out the pinned upstream sources from UPSTREAM.lock into ./upstream/.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/UPSTREAM.lock"
UP="$ROOT/upstream"
mkdir -p "$UP"

# fetch_commit <dir> <repo> <commit>: shallow checkout of one commit
fetch_commit() {
  local dir=$1 repo=$2 commit=$3
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" = "$commit" ]; then
    echo "$dir already at $commit"
    return
  fi
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "$repo"
  git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
}

fetch_commit "$UP/postgres-pglite" "$PGLITE_BACKEND_REPO" "$PGLITE_BACKEND_COMMIT"
fetch_commit "$UP/rdkit" "$RDKIT_REPO" "$RDKIT_COMMIT"

if [ ! -f "$UP/boost/boost/version.hpp" ]; then
  rm -rf "$UP/boost" && mkdir -p "$UP/boost"
  curl -fsSL "$BOOST_URL" | tar -xz -C "$UP/boost" --strip-components=1
fi
# InChI: RDKit's CMake would download this at configure time; fetch it here instead so builds
# need no network (CI caches upstream/), and hand it over with -DINCHI_URL=file://...
INCHI_ZIP="$UP/downloads/$(basename "$INCHI_URL")"
md5_of() { if command -v md5sum >/dev/null; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi; }
if [ ! -f "$INCHI_ZIP" ] || [ "$(md5_of "$INCHI_ZIP")" != "$INCHI_MD5" ]; then
  mkdir -p "$UP/downloads"
  curl -fsSL "$INCHI_URL" -o "$INCHI_ZIP"
  if [ "$(md5_of "$INCHI_ZIP")" != "$INCHI_MD5" ]; then
    echo "checksum mismatch for $INCHI_ZIP" >&2
    exit 1
  fi
fi
echo "upstream ready in $UP"
