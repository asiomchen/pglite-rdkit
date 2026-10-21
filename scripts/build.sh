#!/bin/bash
# Full build: upstream sources -> PG headers -> RDKit static libs -> rdkit.so -> dist/rdkit.tar.gz,
# then checks the side module against the pinned npm @electric-sql/pglite and copies the tarball
# into the npm package. Run on the host; the compile steps run in the pglite builder image.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

./scripts/fetch-upstream.sh
./scripts/build-pg-headers.sh
./scripts/docker.sh ./scripts/build-rdkit-libs.sh
./scripts/docker.sh ./scripts/build-cartridge.sh

# the published pglite.wasm/pglite.js the extension must load into
(cd package && npm ci --no-audit --no-fund)
node scripts/check-imports.mjs build/cartridge-stage/lib/postgresql/rdkit.so

mkdir -p package/release
cp dist/rdkit.tar.gz package/release/
echo "built dist/rdkit.tar.gz; run 'cd package && npm test'"
