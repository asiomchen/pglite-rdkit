# Integration plan: merging pglite-rdkit into PGlite

A living document. It describes how the RDKit extension could move from this repository into the
PGlite monorepo ([electric-sql/pglite](https://github.com/electric-sql/pglite) plus its backend
[electric-sql/postgres-pglite](https://github.com/electric-sql/postgres-pglite)), what that would
gain, and what has to be true first. Keep the [status](#status) and [log](#log) sections current;
the rest changes when the plan does.

## Status

| | |
|---|---|
| Stage | **Proposal, not yet discussed with PGlite maintainers** |
| Standalone package | Builds and passes the [compatibility matrix](ARCHITECTURE.md#compatibility-model) on all published 0.5.x releases (0.5.0–0.5.11) |
| Monorepo prototype | Exists, uncommitted, on branch `asiomchen/rdkit` of a local `pglite` checkout. It uses the older JS-exceptions approach, see [prototype](#the-monorepo-prototype) |
| Next step | Open a discussion upstream (see [steps](#steps)) |

## Why merge

PGlite's [extension development guide](https://pglite.dev/extensions/development) only describes
extensions built inside the monorepo, and every compiled extension it lists lives there. This
repository exists because that path didn't support RDKit as-is. Merging would move the extension
onto the supported path.

### For users

- **One install, versioned with PGlite.** `@electric-sql/pglite-rdkit` would be built from the same
  commit as `pglite.wasm`, released together, so there is no version range to get wrong.
- **Discoverable.** Listed on [pglite.dev/extensions](https://pglite.dev/extensions/) and usable in
  the [REPL](https://pglite.dev/repl/) next to pgvector and PostGIS.
- **Fixed when PGlite changes.** A PGlite change that breaks the extension would fail PGlite's own
  CI before release, instead of being found afterwards by this repository's daily matrix.

### For PGlite

- **Cheminformatics in the browser.** RDKit is the most widely used open-source cheminformatics
  toolkit, and its cartridge is the standard way to store and search molecules in Postgres. No
  other WebAssembly Postgres offers it.
- **A tested pattern for C++ extensions.** PGlite's PostGIS issue
  ([#916](https://github.com/electric-sql/pglite/issues/916)) states "no C++ exception handling (any
  thrown exception will hang or terminate the PGlite instance)". This extension handles C++
  exceptions with native wasm exceptions and its own C++ runtime, with no change to the main module
  ([details](ARCHITECTURE.md#c-exceptions)). The same build pattern might fix exception handling
  in PostGIS/GEOS. That is untested and would be its own piece of work, but RDKit would be the
  reference implementation.
- **No cost to the core, if built this repository's way.** `rdkit.so` imports 190 symbols from
  the main module, and every published 0.5.x `pglite.wasm` already exports all of them, which
  `check-imports.mjs` verifies per release. A merge built the same way should therefore add
  **nothing** to `pglite.wasm` and need no change to its link flags. This is expected from the import
  check, not yet measured with a monorepo build ([open question 1](#open-questions)).
- **Out-of-tree extension lessons.** The analysis behind this repository (the export list depends on
  the toolchain, a missing function fails only when it's called, the 0.5.10 → 0.5.11 export swing) is
  useful to PGlite whether or not RDKit merges ([upstream asks](#independent-upstream-asks)).

### For this project

- No compatibility matrix to run against releases it doesn't control, no shims for symbols a future
  release might drop, no separate npm package to keep alive.
- The cost moves rather than disappears: someone still has to update RDKit and fix the build when
  PGlite changes. See [maintenance and ownership](#maintenance-and-ownership).

## What merging means

### Mapping

| This repository | Monorepo location | Notes |
|---|---|---|
| `scripts/build-rdkit-libs.sh`, `scripts/build-cartridge.sh` | `postgres-pglite/pglite/build-rdkit.sh` | One script, called from `build-pglite.sh` after PostGIS (step 4.2 in the prototype), like `build-postgis.sh` |
| `cartridge/CMakeLists.txt` | `postgres-pglite/pglite/rdkit/CMakeLists.txt` | Same wrapper; `RDKIT_SRC_DIR` points at the submodule |
| `cartridge/pglite_shims.c`, `cartridge/libc_shims.c` | Same directory, or dropped | See [shims](#shims-keep-or-drop) |
| `upstream/rdkit` (`UPSTREAM.lock`) | Submodule `postgres-pglite/pglite/other_extensions/rdkit` | Pinned to the same RDKit tag |
| `upstream/boost`, InChI zip | Downloaded by `build-rdkit.sh` into `other_extensions/.deps/`, or added to the builder image | See [open question 3](#open-questions) |
| `scripts/build-pg-headers.sh` | Not needed | The monorepo build has the headers |
| `scripts/check-imports.mjs` | Optional CI check | Same imports file the build already writes (`rdkit.imports`) |
| `scripts/compat-matrix.sh`, `.github/workflows/compat.yml` | Not needed | The extension ships with exactly one `pglite.wasm` |
| `.github/workflows/release.yml`, `docs.yml`, `site/` | Not needed | PGlite's changesets release and VitePress docs take over |
| Packaging in `build-cartridge.sh` | `rdkit.tar.gz` rule in `pglite/other_extensions/Makefile` | Copies the staged files, like the prototype |
| `package/` | `packages/pglite-rdkit/` | Name `@electric-sql/pglite-rdkit`; `bundle-wasm.ts` instead of the custom tsup step |
| `package/tests/rdkit.test.ts` | `packages/pglite-rdkit/tests/` | Unchanged; uses `PGlite` from the workspace |
| `examples/playground` | `examples/rdkit-playground` | Optional |
| `README.md`, `ARCHITECTURE.md` | Package `README.md`, `docs/extensions/` entry | `ARCHITECTURE.md` shrinks, since compatibility and shims no longer apply |
| CI | `build_and_test.yml`: cache, upload and download steps next to PostGIS's | Plus `wasm:cp-ext:rdkit` in the root `package.json` |
| `package/LICENSE` | `packages/pglite-rdkit/LICENSE` | BSD-3-Clause, BSL-1.0, Apache-2.0 WITH LLVM-exception, MIT. All compatible with PGlite's Apache-2.0 |

### Shims: keep or drop

Inside the monorepo, the main module's export list is generated from the in-tree extensions'
`*.imports` files. So the missing symbols (`byteain`, `sinf`, `islower`, `vsprintf`, …) could simply
be exported, and the shims deleted. The trade-off:

| | Keep the shims | Drop them and export the symbols |
|---|---|---|
| `pglite.wasm` | unchanged | grows by the libc functions it would otherwise drop, a few KB |
| Code to maintain | two small C files in the extension | none in the extension |
| Matches how other extensions do it | no | yes |

Recommendation: drop the Postgres shims (`byteain`, `byteaout`), since exporting builtins is what
other extensions do. For the libc shims, ask the maintainers whether a few KB in `pglite.wasm` or
two files in the extension is preferred.

### Exceptions: use this repository's approach, not the prototype's

The [monorepo prototype](#the-monorepo-prototype) predates this repository. It uses JS-based
exceptions, which only work after adding `-sDISABLE_EXCEPTION_CATCHING=0` to the main module's
link. That costs **+95.6 KB in `pglite.wasm` for every PGlite user**, whether or not they use RDKit.
This repository's native wasm exceptions need no main-module change. They also produce a smaller
extension (6.87 MB vs 8.4 MB for `rdkit.so` before InChI). Before opening upstream PRs, port the
prototype to the native approach.

What native wasm exceptions require (unchanged from this repository):

- Every C++ object in `rdkit.so` built with `-fwasm-exceptions`, without
  `-sSUPPORT_LONGJMP=emscripten`.
- `-lc++ -lc++abi -lunwind` linked into the side module. emcc picks the `*-legacyexcept` variants.
- Runtimes with legacy wasm exceptions: Node 17+, Deno, Bun, current browsers.

## Preconditions

Things that should be true before upstream PRs make sense:

1. **Maintainer interest.** RDKit is a large C++ dependency. The maintainers need to agree they
   want it in the monorepo, under their release process. Ask first ([steps](#steps)).
2. **A stable backend toolchain.** 0.5.10 shipped an emsdk 6 backend from an unmerged branch,
   and 0.5.11 went back to emsdk 3.1.74 ([details](ARCHITECTURE.md#compatibility-model)).
   Integration should target whichever toolchain the maintainers settle on (backend PR #95), and
   be re-verified if that changes.
3. **CI time budget.** The RDKit libraries take about 2–3 minutes on 10 cores; a 4-core GitHub
   runner will be slower. They change only when RDKit or the toolchain changes, so they cache
   well (key: RDKit commit + builder image + flags).
4. **Ownership.** A named maintainer for RDKit updates (two RDKit releases a year, plus patch
   releases) and for build breakages.

## Steps

1. **Discuss.** Open a GitHub discussion or issue on `electric-sql/pglite`:
   - what the extension does, with a link to this repository and the playground;
   - the measurements: sizes, zero core cost, the compatibility matrix;
   - the exception approach as a possible fix for #916;
   - the [open questions](#open-questions).
2. **Port the prototype to native wasm exceptions** on the `asiomchen/rdkit` branch:
   - remove `-sDISABLE_EXCEPTION_CATCHING=0` from `build-pglite.sh`;
   - use this repository's flags, feature set (InChI on), link line and shims;
   - verify that `pglite.wasm` is byte-for-byte the size it is without RDKit
     ([open question 1](#open-questions));
   - run the 11 tests plus the existing extension suites (PostGIS, pgvector, AGE, …).
3. **Backend PR** to `electric-sql/postgres-pglite`: the submodule, `build-rdkit.sh`, the wrapper
   CMake, the `Makefile` packaging rule, and the `build-pglite.sh` step. This has to merge first,
   because the monorepo pins the backend by commit.
4. **Monorepo PR** to `electric-sql/pglite`:
   - the `postgres-pglite` gitlink bump;
   - `packages/pglite-rdkit`;
   - the CI steps;
   - the docs entries (`extensions.data.ts`, `allExtensions.ts`);
   - a changeset.
5. **Release** `@electric-sql/pglite-rdkit` with the next PGlite release.
6. **Wind down this package.**
   - Publish a last `pglite-rdkit` version whose README points to `@electric-sql/pglite-rdkit`,
     then `npm deprecate` it with the same message.
   - Keep this repository's daily matrix running for the 0.5.x line until users have moved.
   - Archive the repository after that.

## Open questions

1. **Is the core cost really zero?** Build PGlite with and without the merged extension, built the
   native way, and compare `pglite.wasm` sizes. The import check says every symbol `rdkit.so` needs
   is already exported, but the in-tree build adds `rdkit.imports` to the export list, which could
   still change link decisions.
2. **Shims or exports?** See [shims](#shims-keep-or-drop).
3. **Where do Boost and InChI come from?** Download them in `build-rdkit.sh` (as the prototype does
   for Boost), or add them to `pglite/builder/Dockerfile` (as PostGIS's dependencies are). The
   builder-image route means rebuilding and republishing the image.
4. **Which features?** This repository ships InChI and leaves out Avalon (its file I/O needs
   functions no release exports). Inside the monorepo those functions could be exported, which
   would make Avalon possible too. Is +0.13 MB worth it?
5. **Release cadence.** Should RDKit updates ship in any PGlite release, or only in minor ones?
6. **Does the wasm-exceptions pattern fix PostGIS?** Out of scope here, but the answer affects how
   much the merge is worth to PGlite.

## Independent upstream asks

Useful to PGlite whether or not RDKit merges, and worth raising in the same discussion:

- **Document which symbols out-of-tree extensions may rely on.** Today the export list is a side
  effect of the in-tree extensions and the toolchain, and it moved by about 8,400 symbols between two
  patch releases (0.5.9 → 0.5.10) and back (0.5.11).
- **Make toolchain changes explicit.** The 0.5.10 emsdk switch reached a release through a gitlink
  bump in an unrelated PR (#1140) and isn't in the changelog.
- **Fail loudly on missing symbols.** A missing function currently becomes a lazy stub that fails
  only when called. On 0.5.9 that showed up as a query silently returning no rows, and as a hang.

## The monorepo prototype

Built earlier in this project, kept for reference. Uncommitted on branch `asiomchen/rdkit` of the
`pglite` checkout:

- **`postgres-pglite`:**
  - the `rdkit` submodule;
  - `pglite/build-rdkit.sh`;
  - `pglite/rdkit/CMakeLists.txt`;
  - an `rdkit.tar.gz` rule in `pglite/other_extensions/Makefile`;
  - step 4.2 in `build-pglite.sh`;
  - `-sDISABLE_EXCEPTION_CATCHING=0` in the main module's link flags.
- **`pglite`:**
  - `packages/pglite-rdkit` (with its own `ARCHITECTURE.md`);
  - `examples/rdkit-playground`;
  - CI steps in `build_and_test.yml`;
  - docs entries;
  - a changeset.
- **Status:** 8 tests passed, as did the PostGIS, pgvector, AGE, plpgsql_check and core suites. It
  has no InChI, and it uses JS-based exceptions, hence [step 2](#steps).

## Maintenance and ownership

After a merge:

| Event | Who | What |
|---|---|---|
| New RDKit release | extension owner | Bump the submodule. Check `RDKITVER`, the cartridge source list and the InChI pin. Run the tests |
| PGlite toolchain change | PGlite maintainers, with the extension owner | Rebuild; check that all objects still use wasm exceptions |
| PGlite release | PGlite CI | Builds and tests the extension like any other |
| New Postgres major | PGlite maintainers | Same as other extensions; the cartridge already supports PG 17 and 18 |

## Log

Add an entry for every decision, discussion or change of plan.

| Date | Entry |
|---|---|
| 2026-10-21 | Plan written. The standalone package covers 0.5.0–0.5.11 with InChI. The monorepo prototype exists but uses JS exceptions. No upstream contact yet. |
| 2026-10-21 | Added `release.yml` (semver tag → CI, `npm stage publish`, draft GitHub release; docs deploy when the release is published) and `docs.yml` (manual docs deploy from an npm version). `compat.yml` no longer deploys. None of these move into the monorepo. Not yet published to npm. |
