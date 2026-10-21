#!/bin/bash
# Produces the configured wasm32 PostgreSQL server headers for the pinned
# postgres-pglite commit (UPSTREAM.lock) under build/pg/include/postgresql/server.
#
# Replicates the configure step of upstream/postgres-pglite/build-pglite.sh
# (same CFLAGS, CONFIGURE_PARAMS, env, --prefix) inside the same builder image
# used for the published @electric-sql/pglite release, but only generates and
# installs the headers instead of building the backend.
#
# The build is VPATH (out-of-tree) in build/pg-build so upstream/ stays pristine.
# Usage: scripts/build-pg-headers.sh           (host; runs itself in docker)
#        FORCE_CONFIGURE=1 scripts/build-pg-headers.sh  (re-run configure)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/UPSTREAM.lock"

if [ -z "${PGLITE_IN_DOCKER:-}" ]; then
  # same path inside the container as on the host (like build-with-docker.sh)
  exec docker run --rm \
    -e PGLITE_IN_DOCKER=1 \
    -e FORCE_CONFIGURE="${FORCE_CONFIGURE:-}" \
    -e PGLITE_VERSION="$PGLITE_NPM_VERSION" \
    --workdir="$ROOT" \
    -v "$ROOT:$ROOT:rw" \
    "$PGLITE_BUILDER_IMAGE" \
    "$ROOT/scripts/build-pg-headers.sh"
fi

# ---- inside the builder container ----
# configure embeds this in PG_VERSION_STR (build-with-docker.sh passes it too)
export PGLITE_VERSION="${PGLITE_VERSION:-$PGLITE_NPM_VERSION}"
SRC="$ROOT/upstream/postgres-pglite"
BLD="$ROOT/build/pg-build"
OUT="$ROOT/build/pg"
# same install prefix as the release build (INSTALL_FOLDER default in build-pglite.sh)
INSTALL_FOLDER=/pglite

[ -x "$SRC/configure" ] || { echo "missing $SRC; run scripts/fetch-upstream.sh" >&2; exit 1; }
if [ -f "$SRC/config.status" ]; then
  echo "error: $SRC is configured in-tree; VPATH build impossible (upstream must stay pristine)" >&2
  exit 1
fi

# --- verbatim from build-pglite.sh (release, DEBUG unset) ---
PGLITE_CFLAGS="-m32 -fpic -sSUPPORT_LONGJMP=emscripten -Wno-declaration-after-statement -Wno-macro-redefined -Wno-unused-function -Wno-missing-prototypes -Wno-incompatible-pointer-types"
PGLITE_CFLAGS="$PGLITE_CFLAGS -O2"
PGLITE_CFLAGS="$PGLITE_CFLAGS \
-D__PGLITE__ \
-Dsystem=pgl_system -Dpopen=pgl_popen -Dpclose=pgl_pclose \
-Dgeteuid=pgl_geteuid -Dgetuid=pgl_getuid -Dgetpwuid=pgl_getpwuid \
-Dexit=pgl_exit \
-Dmunmap=pgl_munmap \
-Dfcntl=pgl_fcntl \
-Datexit=pgl_atexit \
-Dsocket=pgl_socket -Dsetsockopt=pgl_setsockopt -Dgetsockopt=pgl_getsockopt -Dgetsockname=pgl_getsockname \
-Drecv=pgl_recv -Dsend=pgl_send -Dconnect=pgl_connect \
-Dpoll=pgl_poll \
-Dshmget=pgl_shmget -Dshmat=pgl_shmat -Dshmdt=pgl_shmdt -Dshmctl=pgl_shmctl \
-Dlongjmp=pgl_longjmp -Dsiglongjmp=pgl_siglongjmp"

PGLITE_LDFLAGS="-sUSE_PTHREADS=0 -sFAKE_DYLIBS=1 -sENVIRONMENT=node,web,worker -sDEFAULT_TO_CXX"
PGLITE_LDFLAGS_SL="-shared -sSIDE_MODULE=1 -Wno-unused-function -sFAKE_DYLIBS=1 -sENVIRONMENT=node,web,worker -sDEFAULT_TO_CXX"
EXPORTED_RUNTIME_METHODS="addFunction,removeFunction,MEMFS,FS,PROXYFS,callMain,ENV,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack,stackSave,stackRestore,HEAPU8"
# NOTE: pglitec.o / doNotSetExitCode.js paths only matter when linking executables,
# which we never do here; they point at the (unbuilt) source-tree locations.
PGLITE_LDFLAGS_EX="\
-sINITIAL_MEMORY=64MB \
-sSUPPORT_LONGJMP=emscripten \
-sENVIRONMENT=node,web,worker \
-sFORCE_FILESYSTEM=1 \
-sUSE_PTHREADS=0 \
-sEXIT_RUNTIME=1 \
-sFAKE_DYLIBS=1 \
-sDEFAULT_TO_CXX \
-sMAIN_MODULE=2 -sMODULARIZE=1 -sEXPORT_ES6=1 \
-sEXPORT_NAME=Module -sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH \
-sERROR_ON_UNDEFINED_SYMBOLS=0 \
-sEXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME_METHODS \
-sINVOKE_RUN=0 \
-sEXPORTED_FUNCTIONS=_main,_fgets,_fputs,_pclose,_fopen,_fclose,_fflush,___errno_location,_strerror \
$SRC/pglite/src/pglitec/pglitec.o \
-lproxyfs.js \
--post-js $SRC/pglite/scripts/doNotSetExitCode.js"

# the builder image sets this (prebuilt zlib, libxml2, openssl, ... for wasm)
INSTALL_PREFIX=${INSTALL_PREFIX:-/install/libs}

CONFIGURE_PARAMS="\
ac_cv_exeext=.js \
--host wasm32-unknown-emscripten \
--disable-spinlocks \
--without-llvm  \
--without-pam \
--disable-largefile \
--with-openssl=no \
--without-readline \
--with-icu \
--with-includes=$INSTALL_PREFIX/include:$INSTALL_PREFIX/include/libxml2 \
--with-libraries=$INSTALL_PREFIX/lib \
--with-uuid=ossp \
--with-zlib \
--with-libxml \
--with-libxslt \
--with-template=emscripten \
--prefix=$INSTALL_FOLDER"
# --- end verbatim ---

mkdir -p "$BLD"
cd "$BLD"
if [ ! -f config.status ] || [ -n "${FORCE_CONFIGURE:-}" ]; then
  LDFLAGS=$PGLITE_LDFLAGS \
  LDFLAGS_SL=$PGLITE_LDFLAGS_SL \
  LDFLAGS_EX=$PGLITE_LDFLAGS_EX \
  ICU_CFLAGS="-I/install/libs/include" \
  ICU_LIBS="-L/install/libs/lib -licui18n -licuuc -licudata" \
  CFLAGS=${PGLITE_CFLAGS} emconfigure "$SRC/configure" $CONFIGURE_PARAMS
fi

# generate catalog/*_d.h, fmgroids.h, errcodes.h, ... then install only headers
emmake make PORTNAME=emscripten -C src/backend generated-headers
DESTDIR="$BLD/destdir"
rm -rf "$DESTDIR"
emmake make PORTNAME=emscripten -C src/include install DESTDIR="$DESTDIR"
# plpgsql.h (installed by the full release build too)
emmake make PORTNAME=emscripten -C src/pl/plpgsql/src install-headers DESTDIR="$DESTDIR"
# syscache_info.h is backend-internal; an in-tree release build installs it as a
# side effect of globbing src/include/catalog/*.h. Copy it for parity.
cp "$BLD/src/include/catalog/syscache_info.h" "$DESTDIR$INSTALL_FOLDER/include/postgresql/server/catalog/"

rm -rf "$OUT/include"
mkdir -p "$OUT"
cp -a "$DESTDIR$INSTALL_FOLDER/include" "$OUT/include"
# keep the Makefile.global/pgxs-relevant config next to the headers for reference
cp "$BLD/src/Makefile.global" "$OUT/Makefile.global"
echo "headers installed to $OUT/include/postgresql/server"
