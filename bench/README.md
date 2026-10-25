# Benchmark

Measures how many molecules pglite-rdkit can hold, how long loading and indexing take, how fast
common searches are, and how much memory it uses, in a real browser (Playwright) and in Node. Every
result file records the PGlite, pglite-rdkit, RDKit, browser and machine versions and the dataset
checksum, so a run on a later release can be compared with an earlier one.

## Running

Needs Node 22.15 or newer (for built-in zstd, used to read the dataset). By default the benchmark
uses this repository's `package/`, so build it first (`./scripts/build.sh`, see the main README).

```bash
cd bench
npm install
npx playwright install chromium
npm run data                          # downloads the MolPILE subset, writes data/mols.smi

npm run browser                       # 10k, 50k, 100k molecules; in-memory and IndexedDB
npm run browser -- --sizes 250k --timeout 120
npm run node                          # the same in Node; in-memory and file storage
npm run node -- --runtime bun         # the same in Bun (needs `bun` on the PATH)
npm run docker                        # native PostgreSQL + RDKit in Docker on one CPU core
npm run report -- results/a.json results/b.json   # side-by-side table
```

Each run writes `results/<date>-<browser>-pglite<version>-rdkit<version>.json` (updated after every
size, so a crash or timeout keeps what finished) and prints a markdown table.

| Option | Default | |
|---|---|---|
| `--sizes` | `10k,50k,100k` | rows to load; up to the dataset size (1M by default) |
| `--runtime` | `node` | Node runner only: `bun` runs each size under Bun instead |
| `--image`, `--cpus` | see below | Docker runner only |
| `--storage` | `memory,idb` (browser), `memory,file` (Node) | `idb` and `file` also time reopening the saved database |
| `--queries false` | | load and index only, to find the size limit faster |
| `--runs` | `3` | runs per query; the median is reported |
| `--timeout` | `60` | minutes per size |
| `--browser` | `chromium` | `firefox` or `webkit` work too (after `npx playwright install`), without memory figures |
| `--channel chrome` | | the installed Google Chrome instead of Playwright's headless shell |
| `--headed` | | show the browser window |
| `--out` | | result file path |

The browser runner serves a production build (`vite build` + `vite preview`); the dev server's
client reloads the page when its websocket drops, which restarted long runs. A second page load
is recorded as an error. The page can also be opened by hand: `npx vite`, then `/?n=10000` (`&dataDir=idb://bench`,
`&queries=0`, `&reopen=1`).

## Benchmarking a release

Install the versions to compare over the defaults, run, and compare the result files:

```bash
npm install --no-save @electric-sql/pglite@0.5.11 pglite-rdkit@0.0.1
npm run browser
npm run report -- results/<earlier>.json results/<new>.json
npm install                           # back to package/ and the reference PGlite
```

## Native PostgreSQL baseline

`docker.mjs` runs the same steps against native PostgreSQL with the RDKit cartridge, from the
[cheminfo_db_images](https://github.com/asiomchen/cheminfo_db_images) images. The default
`ghcr.io/asiomchen/rdkit-postgres:postgres18.6-rdkit2026.09.1` matches the PostgreSQL and RDKit
versions of the reference build; pass `--image` with the matching tag after an update. Each size
gets a fresh container limited to one core (`--cpus 1 --cpuset-cpus 0`, since PGlite never uses
more) and started with PGlite's settings: `fsync=off`, `io_method=sync`, no parallel or background
workers, `shared_buffers=128MB`, `work_mem=4MB`, `maintenance_work_mem=64MB`, and `autovacuum` and
`jit` off, as PGlite's single-user mode has neither. Queries go through node-postgres, so each
timing includes a local round trip that PGlite doesn't have. Memory is the container's cgroup
peak. On macOS, Docker runs in a Linux VM, so this is native code in a VM against wasm on the host.

## What it measures

`src/core.js` runs the same steps in Node and in the browser:

1. Start PGlite and `CREATE EXTENSION rdkit`.
2. Insert n SMILES, parse them with `mol_from_smiles`, compute `morganbv_fp` fingerprints, build
   GiST indexes on both, `ANALYZE`.
3. Substructure searches (`@>`) for four patterns from very common (benzene) to rare (a steroid
   core), each as a count with and without the index and as a `LIMIT 100`.
4. Similarity searches (`%`, Tanimoto ≥ 0.5) with and without the index, and top-10 nearest
   neighbours (`<%>`), for aspirin and caffeine.
5. An exact match (`@=`), `mol_amw` over every row, and `mol_to_svg` for 100 rows.
6. For `idb`/`file` storage: reopen the saved database in a new tab or process and time the first
   searches.

Memory:

- **Peak process memory**: the browser tab's renderer process (Chromium) or the Node process,
  sampled from outside every 250 ms. This is the number that ends in an out-of-memory tab crash.
- **Peak footprint** (Node on macOS): the kernel's exact peak of the process's physical footprint,
  read by the process itself with `footprint` before it exits, plus `footprintMB` at every step.
  It is the figure Activity Monitor shows, without the clean, shared pages RSS includes. It still
  counts memory that macOS malloc keeps cached after it is freed.
- **wasm heap**: PGlite's WebAssembly memory, which can't grow past 2 GB. With in-memory storage
  the database files live outside it, in JS `ArrayBuffer`s.

A crashed tab or a killed process is recorded as an error for that size, and the remaining sizes
still run.

## Dataset

`data.mjs` downloads a subset of [MolPILE](https://huggingface.co/datasets/scikit-fingerprints/MolPILE)
([arXiv:2509.18353](https://arxiv.org/abs/2509.18353)), about 222M RDKit-standardized molecules
from PubChem, UniChem, Mcule, ChemSpace, SuperNatural3 and COCONUT. The 1M subset is pinned to
a dataset revision and checked against its sha256, then shuffled with a fixed seed, so the first
n rows are the same mixed sample on every machine. `--subset 100k|5M|10M` selects another
subset. Sizes above the subset size repeat it.

MolPILE has no single license; each source keeps its own (CC0, CC-BY-4.0, CC-BY-NC-4.0, ...).
The data is downloaded for local benchmarking and isn't committed (`data/` is ignored).
