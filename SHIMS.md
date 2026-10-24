# Shims

The shims are small replacement functions compiled into `rdkit.so`. They exist because
`pglite.wasm` only exports some of the functions it contains, and which ones it exports changes
from release to release. With the shims, one build of `rdkit.so` loads and works on every
`@electric-sql/pglite` 0.5.x release.

They live in two files:

- [`cartridge/pglite_shims.c`](cartridge/pglite_shims.c) for PostgreSQL symbols
- [`cartridge/libc_shims.c`](cartridge/libc_shims.c) for libc symbols

See also [ARCHITECTURE.md](ARCHITECTURE.md#symbol-resolution-and-shims).

## 1. How the extension loads

- PGlite is PostgreSQL compiled to WebAssembly. The core is `pglite.wasm`, the **main module**.
- The RDKit extension is a separate wasm file, `rdkit.so`, a **side module**. It's built in
  [`cartridge/CMakeLists.txt`](cartridge/CMakeLists.txt) with `-sSIDE_MODULE=1`.
- When you run `CREATE EXTENSION rdkit`, Emscripten's loader (in `pglite.js`) instantiates
  `rdkit.so`. It has to give `rdkit.so` every function it imports from outside itself, such as
  `byteain`, `islower` or `vsprintf`.
- The loader looks each name up in one JS object, `wasmImports`. That object holds:
  - the functions `pglite.wasm` exports, and
  - the JS library functions in `pglite.js`.

## 2. Why some functions are missing

- `pglite.wasm` is linked with `MAIN_MODULE=2`. That setting exports only an explicit list of
  symbols and deletes everything else as dead code.
- That list is built from the extensions that were in PGlite's own source tree at build time
  (their `*.imports` files). RDKit isn't one of them.
- So a function can be in PostgreSQL or in libc and still not be callable from outside, because no
  in-tree extension needed it. `byteain`, `sinf` and `islower` are examples.
- The list also varies by release:

| Release | Exports |
|---|---|
| 0.5.0 | 2,094 |
| 0.5.9 | 2,238 |
| 0.5.10 (emsdk 6) | 10,672 |
| 0.5.11 (back to emsdk 3.1.74) | 2,238 |

A build checked only against 0.5.10 would have broken on 0.5.11.

## 3. Why a missing function fails silently

What the loader does depends on the kind of import:

| Missing import | What happens |
|---|---|
| `GOT.mem.*` / `GOT.func.*` | `CREATE EXTENSION` fails right away with a load error. This is the easy case. |
| A plain function (`env.*`) | The loader puts in a **lazy stub**. The extension loads, and the stub only fails when the function is first called. |

The second case caused real bugs before the shims existed:

- On 0.5.9, `mol_to_svg(...)` returned **zero rows** without any error, because
  `islower`/`isupper` were missing.
- `mol_inchi` hung forever on 0.5.9 and returned no rows on 0.5.0, because of the missing InChI
  libc functions.

## 4. The fix

Instead of patching RDKit or depending on PGlite's export list, the build defines the missing
functions inside `rdkit.so`. Both shim files are compiled with the 13 upstream cartridge sources.

With those definitions inside, the wasm linker resolves the calls inside `rdkit.so`. They never
become imports, so the loader never has to find them in `pglite.wasm`.

That leads to the main rule: **a shim is used on every release, even when `pglite.wasm` does
export the real function.** So a placeholder isn't enough. Each shim has to be a correct
implementation.

## 5. The two files

### `cartridge/pglite_shims.c` (PostgreSQL symbols)

```c
Datum
byteain(PG_FUNCTION_ARGS)
{
	return OidFunctionCall1Coll(F_BYTEAIN, PG_GET_COLLATION(), PG_GETARG_DATUM(0));
}
```

- **Needed by:** `rdkit_io.c`, which calls `DirectFunctionCall1(byteain, …)` for bfp/sfp text
  input and output. `DirectFunctionCall1` needs the C symbol.
- **How it works:** the built-in still exists inside PostgreSQL's `fmgr_builtins` table, even
  though its symbol isn't exported. So the shim calls it through the function manager by OID
  (`F_BYTEAIN` = 1244, `F_BYTEAOUT` = 31), which never needs the symbol. `byteaout` works the same
  way.

### `cartridge/libc_shims.c` (libc symbols)

This file deliberately includes **no PostgreSQL headers**. PostgreSQL's `port.h` has
`#define vsprintf pg_vsprintf` (and the same for the rest of the printf family). If it were
included, the `vsprintf` shim would quietly be compiled as `pg_vsprintf`, and RDKit's `vsprintf`
import would stay missing. That's the only reason for the second file.

Every shim here is built only on functions that every 0.5.x release exports (`sin`, `cos`,
`vsnprintf`, `fread`, `strlen`, `memcpy`, `strcspn`):

| Shim | Used by | Implementation | Why it's correct |
|---|---|---|---|
| `sinf`, `cosf` | MolDraw2D (angles) | `(float) sin(x)` | Double precision, then rounded to float |
| `islower`, `isupper`, `ispunct` | MolDraw2D text, parsers | ASCII range checks | Musl is ASCII-only in the C locale too, so results are identical |
| `signal` | RDKit `ControlCHandler` (used by `CIPLabeler`) | returns `SIG_ERR` | Wasm has no signals, so the handler could never run. `getGotSignal()` stays false. |
| `setbuf` | stdio setup | does nothing | Changing buffering is optional, so keeping the default is valid |
| `setenv` | RDKit's settings stored in environment variables (`setUseLegacyStereoPerception`, …) | `errno = ENOMEM; return -1` | Before 0.5.10 none of `setenv`, `putenv` or `environ` are exported, so a side module can't change what `getenv()` sees. The cartridge never calls these setters, so the shim fails openly instead of pretending to succeed. |
| `stpcpy`, `strpbrk` | InChI | textbook versions on `strlen`/`memcpy`/`strcspn` | Standard behaviour |
| `vsprintf` | InChI | `vsnprintf(s, INT_MAX, fmt, ap)` | This is exactly how musl implements it |
| `__small_sprintf` | InChI | same as `vsprintf`, with variable arguments | The compiler swaps `sprintf` for this when no floats are formatted |
| `fgetc`, `fgets` | InChI | built on `fread` | `fread` uses the main module's `FILE` buffer (including `ungetc` pushback), so mixing them with real stdio calls stays consistent |

Libc definitions are written as `(islower)(int c)`. The parentheses stop musl's `ctype.h` macros
from expanding the function name.

## 6. How missing symbols get caught

Tests passing doesn't prove much, because of the lazy stubs from section 3. So there's a separate
check:

- `node scripts/check-imports.mjs <rdkit.so> <pglite.wasm> <pglite.js>` reads every import of
  `rdkit.so`.
- It sorts each one by where it comes from: the loader, `rdkit.so` itself, the main module's
  exports, the JS library, or an `invoke_*` wrapper.
- It fails if anything is unresolved, or if a function supplied by JS just calls `abort()`.
- `scripts/compat-matrix.sh` runs this check, plus the test suite, against every PGlite release in
  the range, daily in CI.
- Current result, the same on 0.5.0, 0.5.10 and 0.5.11: 6,209 imports and nothing missing.

When a new PGlite release fails this check, the fix is to add another shim, or to narrow the
supported version range.

## 7. If this moves into PGlite itself

If the extension is built inside the PGlite monorepo, `rdkit.imports` would feed the export list
directly, so the missing symbols could just be exported.
[INTEGRATION_PLAN.md](INTEGRATION_PLAN.md#shims-keep-or-drop) recommends:

- dropping the PostgreSQL shims (`byteain`/`byteaout`), since exporting built-ins is what other
  extensions do;
- asking the PGlite maintainers whether they'd rather keep the libc shims or grow `pglite.wasm` by
  a few KB.

## Summary

`pglite.wasm` exports a different, incomplete set of functions in each release, and a missing
function fails silently on first call. So `rdkit.so` carries its own correct versions of the few
functions it needs, built only on functions every release exports, and `check-imports.mjs` checks
every release to confirm nothing is still missing.
