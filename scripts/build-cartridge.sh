#!/bin/bash
# Links the RDKit cartridge as a PGlite side module and packages dist/rdkit.tar.gz.
# Runs inside the builder container (scripts/docker.sh), after build-pg-headers.sh and
# build-rdkit-libs.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/UPSTREAM.lock"

BUILD_TYPE=Release
OPT="-O2"
if [ "${DEBUG:-false}" = "true" ]; then BUILD_TYPE=Debug; OPT="-g"; fi
# keep in sync with build-rdkit-libs.sh: every C++ object in rdkit.so must use native wasm EH
CFLAGS="-m32 -fpic -fwasm-exceptions -sWASM_BIGINT $OPT"

PG_INCLUDE=$ROOT/build/pg/include/postgresql/server
source "$ROOT/scripts/features.sh"
RDKIT_PREFIX=$ROOT/build/rdkit-install$FEATURES_SUFFIX
BUILD_DIR=$ROOT/build/cartridge-build$FEATURES_SUFFIX
STAGE_DIR=$ROOT/build/cartridge-stage$FEATURES_SUFFIX
TARBALL=$ROOT/dist/rdkit$FEATURES_SUFFIX.tar.gz

emcmake cmake -S "$ROOT/cartridge" -B "$BUILD_DIR" -Wno-dev \
    -DCMAKE_BUILD_TYPE=$BUILD_TYPE \
    -DCMAKE_C_FLAGS="$CFLAGS" \
    -DCMAKE_CXX_FLAGS="$CFLAGS" \
    -DCMAKE_EXE_LINKER_FLAGS="$CFLAGS" \
    -DCMAKE_INSTALL_PREFIX="$STAGE_DIR" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
    -DPG_INCLUDE_DIR_SERVER="$PG_INCLUDE" \
    -DRDKit_DIR="$RDKIT_PREFIX/lib/cmake/rdkit" \
    -DBoost_DIR="$ROOT/build/boost-cmake" \
    -DRDK_BUILD_INCHI_SUPPORT=$RDK_INCHI \
    -DRDK_BUILD_AVALON_SUPPORT=$RDK_AVALON
cmake --build "$BUILD_DIR" -j

rm -rf "$STAGE_DIR"
cmake --install "$BUILD_DIR"
emstrip --strip-debug "$STAGE_DIR/lib/postgresql/rdkit.so"

mkdir -p "$ROOT/dist"
(cd "$STAGE_DIR" && tar -czf "$TARBALL" $(find . -type f | sed 's|^\./||' | sort))
ls -l "$STAGE_DIR/lib/postgresql/rdkit.so" "$TARBALL"
