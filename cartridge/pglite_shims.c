/*
 * Postgres symbols the cartridge references but which the published pglite.wasm does not export.
 * pglite.wasm is linked with MAIN_MODULE=2, so it only keeps the symbols listed by the extensions
 * that were in-tree when it was built, and the list differs between releases (0.5.10, the first
 * built with emsdk 6, exports ~8,400 more than 0.5.9). Defining them here makes one rdkit.so
 * loadable by every stock @electric-sql/pglite 0.5.x. libc symbols are in libc_shims.c, which
 * must not see the Postgres headers (port.h renames the printf family to pg_*).
 *
 * These definitions bind inside rdkit.so even when pglite.wasm does export the same name, so each
 * one must behave correctly on its own, not just exist. check-imports.mjs (run per release by
 * scripts/compat-matrix.sh) fails if a release needs something that isn't covered here.
 */
#include "postgres.h"

#include "fmgr.h"
#include "utils/fmgroids.h"

/* rdkit_io.c: DirectFunctionCall1(byteain/byteaout, ...). Call the builtins by OID instead,
 * since fmgr_info() can find any builtin even when its symbol isn't exported. */
Datum
byteain(PG_FUNCTION_ARGS)
{
	return OidFunctionCall1Coll(F_BYTEAIN, PG_GET_COLLATION(), PG_GETARG_DATUM(0));
}

Datum
byteaout(PG_FUNCTION_ARGS)
{
	return OidFunctionCall1Coll(F_BYTEAOUT, PG_GET_COLLATION(), PG_GETARG_DATUM(0));
}
