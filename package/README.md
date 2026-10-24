<!-- Generated from the repository root README.md by scripts/sync-readme.sh. Edit that file instead. -->

# pglite-rdkit

[![CI](https://github.com/asiomchen/pglite-rdkit/actions/workflows/compat.yml/badge.svg)](https://github.com/asiomchen/pglite-rdkit/actions/workflows/compat.yml) [![npm](https://img.shields.io/npm/v/pglite-rdkit)](https://www.npmjs.com/package/pglite-rdkit) [![PGlite](https://img.shields.io/badge/%40electric--sql%2Fpglite-0.5.x%20(PostgreSQL%2018)-blue)](https://www.npmjs.com/package/@electric-sql/pglite) [![RDKit](https://img.shields.io/badge/RDKit-2026.09.1-blue)](https://github.com/rdkit/rdkit/releases/tag/Release_2026_09_1) [![License](https://img.shields.io/badge/license-BSD--3--Clause%20%2B%20others-blue)](https://github.com/asiomchen/pglite-rdkit/blob/main/package/LICENSE)

The [RDKit](https://www.rdkit.org/) PostgreSQL cartridge for
[PGlite](https://pglite.dev), Postgres in WebAssembly. It adds the `mol`, `qmol`, `bfp`,
`sfp` and `reaction` types, substructure and similarity search with GiST indexes,
fingerprints and molecular descriptors, in the browser and in Node.js.

Try it in the browser at [pglite-rdkit.cheminfo.dev](https://pglite-rdkit.cheminfo.dev).

It works with the stock [`@electric-sql/pglite`](https://www.npmjs.com/package/@electric-sql/pglite)
from npm: no fork and no changes to PGlite.

## Install

```bash
npm install @electric-sql/pglite pglite-rdkit
```

## Usage

```ts
import { PGlite } from '@electric-sql/pglite'
import { rdkit } from 'pglite-rdkit'

const pg = await PGlite.create({ extensions: { rdkit } })
await pg.exec('CREATE EXTENSION IF NOT EXISTS rdkit')

const res = await pg.query(`
  SELECT mol_to_smiles('C1=CC=CC=C1O'::mol) AS canonical,  -- Oc1ccccc1
         mol_amw('c1ccccc1O'::mol) AS mw,
         'c1ccccc1O'::mol @> 'O'::qmol AS has_oxygen
`)
```

### Substructure search with a GiST index

```sql
CREATE TABLE molecules (id serial PRIMARY KEY, name text, smiles text, m mol);
INSERT INTO molecules (name, smiles) VALUES
  ('aspirin', 'CC(=O)Oc1ccccc1C(=O)O'),
  ('phenol', 'Oc1ccccc1'),
  ('ethanol', 'CCO');
UPDATE molecules SET m = mol_from_smiles(smiles::cstring);
CREATE INDEX molecules_m_idx ON molecules USING gist (m);

SELECT name FROM molecules WHERE m @> 'c1ccccc1'::mol;  -- aspirin, phenol
```

### Similarity search

Morgan fingerprints, the `%` operator (Tanimoto, filtered by `rdkit.tanimoto_threshold`)
and a GiST index:

```sql
ALTER TABLE molecules ADD COLUMN fp bfp;
UPDATE molecules SET fp = morganbv_fp(m);
CREATE INDEX molecules_fp_idx ON molecules USING gist (fp);

SET rdkit.tanimoto_threshold = 0.3;
SELECT name, tanimoto_sml(fp, morganbv_fp('Oc1ccccc1C(=O)O'::mol)) AS sim
FROM molecules
WHERE fp % morganbv_fp('Oc1ccccc1C(=O)O'::mol)
ORDER BY sim DESC;  -- aspirin 0.46, phenol 0.40
```

### InChI and InChIKey

```sql
SELECT mol_inchi('CC(=O)Oc1ccccc1C(=O)O'::mol);
-- InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)
SELECT mol_inchikey('CC(=O)Oc1ccccc1C(=O)O'::mol);  -- BSYNRYMUTXBXSQ-UHFFFAOYSA-N
SELECT mol_inchi('CC(=O)O'::mol, '/FixedH');        -- InChI options as the second argument
```

### Drawing

`mol_to_svg` returns an SVG document as `cstring`; cast it to `text` to use text functions:

```sql
SELECT mol_to_svg('CCO'::mol)::text AS svg;
```

Invalid input raises a normal Postgres error (`could not create molecule from SMILES`),
and the database stays usable.

See the [RDKit cartridge documentation](https://www.rdkit.org/docs/Cartridge.html) for the
full list of functions and operators.

## Supported versions

This release ships RDKit 2026.09.1
([`Release_2026_09_1`](https://github.com/rdkit/rdkit/releases/tag/Release_2026_09_1)), with
cartridge extension version 4.8.0. `SELECT rdkit_toolkit_version()` returns the RDKit version at
runtime.

| Target | Status |
| --- | --- |
| `@electric-sql/pglite` 0.5.x (PostgreSQL 18) | Supported. Every published release in `>=0.5.0 <0.6.0` is tested in CI, and the run repeats daily to pick up new releases |
| `@electric-sql/pglite` 0.4.x (PostgreSQL 17) | Not supported: Postgres rejects the library (`PG_MODULE_MAGIC` mismatch) |
| Node.js 17+, Deno, Bun, current browsers | Should work: the extension needs legacy wasm exceptions, which these support. CI is set up for Node 22 and local runs used Node 24; the others are untested |

An extension like this depends on more than PGlite's JavaScript API, so each release is
tested rather than assumed. See the
[compatibility model](https://github.com/asiomchen/pglite-rdkit/blob/main/ARCHITECTURE.md#compatibility-model).

## Not included

The build leaves out Avalon, Coordgen and FreeType: `avalon_fp` raises an error, 2D
coordinates use RDKit's default depiction, and SVG text is drawn as paths. InChI is
included (`mol_inchi`, `mol_inchikey`).

## Bundle size

The extension tarball is about 2.2 MB gzipped (the wasm side module is 8.1 MB
uncompressed; InChI accounts for about 0.4 MB of the download). It is downloaded only when you pass `rdkit` to `extensions`.

## How it works

PGlite loads extensions as WebAssembly side modules, and its main module only exports the
symbols that the extensions built alongside it needed. An extension built elsewhere has to
work with whatever a given release already exports:

- **Its own C++ runtime.** RDKit uses exceptions for normal control flow, but the published
  `pglite.js` aborts on `__cxa_throw`. The extension is built with native wasm exceptions
  and its own libc++/libc++abi/libunwind, so throw and catch stay inside the module
  ([details](https://github.com/asiomchen/pglite-rdkit/blob/main/ARCHITECTURE.md#c-exceptions)).
- **Shims** cover the few symbols some releases don't export, without patching RDKit
  ([details](https://github.com/asiomchen/pglite-rdkit/blob/main/ARCHITECTURE.md#symbol-resolution-and-shims)).
- **A tested range.** Headers come from one reference release, and CI checks every published
  release in the supported range
  ([details](https://github.com/asiomchen/pglite-rdkit/blob/main/ARCHITECTURE.md#compatibility-model)).

The full design is in [ARCHITECTURE.md](https://github.com/asiomchen/pglite-rdkit/blob/main/ARCHITECTURE.md).
A possible future merge into PGlite itself is tracked in
[INTEGRATION_PLAN.md](https://github.com/asiomchen/pglite-rdkit/blob/main/INTEGRATION_PLAN.md).

### Limitations

- `statement_timeout` doesn't interrupt a long RDKit query. PGlite has no signals, so this
  applies to any extension.
- One build per PostgreSQL major version.

## How to build pglite-rdkit and contribute

The repository is at [github.com/asiomchen/pglite-rdkit](https://github.com/asiomchen/pglite-rdkit).
Building needs Docker (the compile steps run in PGlite's builder image) and Node.js.

```bash
./scripts/build.sh                    # fetch sources, build, package; about 3 min clean on 10 cores
(cd package && npm ci && npm test)    # test suite against the reference PGlite release
./scripts/compat-matrix.sh            # import check + tests against every release in the range
```

`build.sh` produces `dist/rdkit.tar.gz` and copies it to `package/release/`. The stages
are described in the
[build pipeline](https://github.com/asiomchen/pglite-rdkit/blob/main/ARCHITECTURE.md#build-pipeline).

### Playground

`examples/playground` is an in-browser SQL playground on stock PGlite, with a small table
of well-known drugs, fingerprints and GiST indexes:

```bash
./scripts/build.sh && (cd package && npm run build)
cd examples/playground && npm install && npm run dev
```

### Repository layout

| Path | What |
| --- | --- |
| `UPSTREAM.lock` | Pinned inputs: reference PGlite version, its `postgres-pglite` commit and builder image, RDKit tag, Boost |
| `scripts/build.sh` | Runs the whole pipeline |
| `scripts/fetch-upstream.sh` | Checks the pinned sources out into `upstream/` (gitignored) |
| `scripts/build-pg-headers.sh` | Installs only the wasm32 PostgreSQL server headers (`build/pg/`) |
| `scripts/build-rdkit-libs.sh` | RDKit static libraries, minimal feature set (`build/rdkit-install/`) |
| `scripts/build-cartridge.sh` | Links `rdkit.so`, generates the extension SQL, packages `dist/rdkit.tar.gz` |
| `scripts/check-imports.mjs` | Fails if `rdkit.so` imports anything a published `pglite.wasm`/`pglite.js` doesn't provide |
| `scripts/compat-matrix.sh` | Import check + test suite against every published release in the supported range |
| `scripts/docker.sh` | Runs a command in the pinned builder image |
| `scripts/sync-readme.sh` | Copies this README into `package/` for npm (`--check` in CI) |
| `cartridge/` | Wrapper CMake for the upstream cartridge sources, plus the shims (`pglite_shims.c` for Postgres symbols, `libc_shims.c` for libc) |
| `scripts/features.sh` | Optional extras for a separate variant build (`RDKIT_FEATURES=avalon`) |
| `package/` | The npm package (`pglite-rdkit`), its tests, and the example queries (`pglite-rdkit/examples`) |
| `examples/playground/` | Browser playground |
| `site/` | The website, [pglite-rdkit.cheminfo.dev](https://pglite-rdkit.cheminfo.dev): landing page, playground and REPL ([details](https://github.com/asiomchen/pglite-rdkit/blob/main/site/README.md)) |
| `.github/workflows/compat.yml` | CI: build once, then test each release and check the site builds; daily schedule |
| `.github/workflows/release.yml` | On a `v*` semver tag: CI, then stage on npm and draft a GitHub release |
| `.github/workflows/docs.yml` | Deploys the site against a version from npm; manual or on a published release |

### README

This file is the only README. Edit it here at the repository root; `package/README.md` is a
generated copy for npm. Run `./scripts/sync-readme.sh` after editing (`npm pack` and
`npm publish` also run it). CI fails if the copy is out of date. Links to repository files
are absolute GitHub URLs so they also work on npmjs.com.

### Releasing

Every version goes through `release.yml`; nothing is published by hand. Push a semver tag, for
example `git tag v0.1.0 && git push origin v0.1.0`. The workflow runs the build and the full
compatibility matrix, then stages `pglite-rdkit` on npm with the tag's version
(`package/package.json` stays at `0.0.0`) and creates a draft GitHub release with the same npm
tarball and `rdkit.tar.gz`. Nothing is public yet. To finish:

1. Approve the staged version: `npm stage approve <stage-id>` (asks for 2FA). The stage id is in
   the workflow's job summary and the draft release notes; `npm stage list pglite-rdkit` also
   shows it.
2. Publish the draft GitHub release. For a stable version this deploys the docs.

Test a release with a prerelease tag first, such as `v0.2.0-rc.1`. It goes to the `next`
dist-tag, so `npm install pglite-rdkit` keeps the stable version, and it doesn't deploy the docs.
Try it with `npm install pglite-rdkit@next`, then push the stable tag. Until the first stable
release, `latest` points at `0.0.1-rc.1`.

To redeploy the docs on their own, run the **Deploy docs** workflow from the Actions tab with a
version, or leave it empty for the `latest` release on npm.

npm authentication uses a [trusted publisher](https://docs.npmjs.com/trusted-publishers/)
(OIDC), not a token. It is configured on npmjs.com for this repository, the `release.yml`
workflow and the `npm` environment; all three must match, so renaming the workflow file or the
environment needs the same change on npm (`npm trust list pglite-rdkit` shows the current
setting). The OIDC token can only stage, so approval always needs a maintainer with 2FA. The
docs workflow needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.

### Updating

- **New PGlite release in the range:** the daily matrix tests it. If it fails, add a shim
  or narrow the range. Moving the reference release (`PGLITE_*` in `UPSTREAM.lock` and the
  devDependency in `package/package.json`) is optional.
- **New PostgreSQL major (PGlite 0.6.x?):** a new reference in `UPSTREAM.lock`, a new
  range, and a new major version of this package.
- **New RDKit release:** update `RDKIT_TAG` and `RDKIT_COMMIT` (and `INCHI_URL`/`INCHI_MD5` if
  RDKit's `Code/cmake/Modules/FindInchi.cmake` pins a new InChI), then check `RDKITVER` in
  `cartridge/CMakeLists.txt` and the cartridge source list against
  `Code/PgSQL/rdkit/CMakeLists.txt` upstream. Update the RDKit version in the badge, under
  [Supported versions](#supported-versions), and on the site
  (`site/src/content/docs/index.mdx`).

## License

The wrapper, the RDKit cartridge, RingDecomposerLib and Novartis-contributed RDKit code are
BSD-3-Clause. The bundle also includes Boost headers and static serialization/iostreams
libraries (BSL-1.0), the LLVM libc++/libc++abi/libunwind runtime (Apache-2.0 WITH
LLVM-exception) and the InChI library (MIT). See [LICENSE](https://github.com/asiomchen/pglite-rdkit/blob/main/package/LICENSE).

The extension archive also includes the complete license file at `share/doc/rdkit/LICENSE`.
