#!/bin/bash
# Run a command inside the pinned pglite builder image (emsdk), with the repo
# mounted at the same absolute path (so DWARF/debug paths match the host) and
# the working directory set to the repo root.
#
#   scripts/docker.sh scripts/build-rdkit-libs.sh
#   scripts/docker.sh bash -lc 'emcc --version'
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../UPSTREAM.lock
source "$REPO_ROOT/UPSTREAM.lock"

if [ $# -eq 0 ]; then
  echo "usage: $0 <cmd...>" >&2
  exit 1
fi

TTY_FLAGS=()
if [ -t 0 ] && [ -t 1 ]; then TTY_FLAGS=(-it); fi

exec docker run --rm ${TTY_FLAGS[@]+"${TTY_FLAGS[@]}"} \
  -e DEBUG="${DEBUG:-false}" \
  -e JOBS="${JOBS:-}" \
  -e RDKIT_FEATURES="${RDKIT_FEATURES:-}" \
  --workdir="$REPO_ROOT" \
  -v "$REPO_ROOT:$REPO_ROOT:rw" \
  ${DOCKER_EXTRA_ARGS:-} \
  "$PGLITE_BUILDER_IMAGE" \
  "$@"
