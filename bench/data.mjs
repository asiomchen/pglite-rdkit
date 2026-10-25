#!/usr/bin/env node
// Builds data/mols.smi from a MolPILE subset (https://huggingface.co/datasets/scikit-fingerprints/MolPILE,
// arXiv:2509.18353): RDKit-canonical SMILES compiled from PubChem, UniChem, Mcule, ChemSpace,
// SuperNatural3 and COCONUT. The subset is downloaded from a pinned dataset revision and checked
// against its sha256, then shuffled with a fixed seed, so the first n rows of mols.smi are the same
// mixed sample on every machine. Prints the molecule count and the sha256 every result records.
//
// usage: node data.mjs [--subset 1M]   (100k, 1M, 5M or 10M; 1M covers sizes up to 1,000,000)
//
// MolPILE has no single license: each source keeps its own (CC0, CC-BY-4.0, CC-BY-NC-4.0, ...).
// The data is downloaded for local benchmarking only and is never committed or redistributed.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { zstdDecompressSync } from 'node:zlib'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { HERE, parseArgs } from './lib.mjs'

const REVISION = 'efc4515a7d10259d026a08ba0c1e5fe2b2a76416'
const SUBSETS = {
  '100k': { file: 'molpile_subset_100k.parquet', sha256: 'c48358454a2e619447346abb4b3a9e06368b7c5de2320a4a5725791dc140ab7c' },
  '1M': { file: 'molpile_subset_1M.parquet', sha256: '6e2052f61b5a208d77d2b1ba0e0444a6369483ca69ada22fe9409563f636fcbf' },
  '5M': { file: 'molpile_subset_5M.parquet', sha256: '241c4706925d94d97ad12a2268aa4d00f7c7bd21b23809dcc561fc33fd83de5f' },
  '10M': { file: 'molpile_subset_10M.parquet', sha256: 'fdd03a021a2c843a6479f005b17512aaa4baac16a296233bed0ab9b720ec6ed8' },
}
const SEED = 20260924

const { subset } = parseArgs(process.argv.slice(2), { subset: '1M' })
const spec = SUBSETS[subset]
if (!spec) throw new Error(`unknown subset ${subset} (${Object.keys(SUBSETS).join(', ')})`)

const dir = join(HERE, 'data')
mkdirSync(dir, { recursive: true })
const parquet = join(dir, spec.file)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

if (!existsSync(parquet) || sha256(readFileSync(parquet)) !== spec.sha256) {
  const url = `https://huggingface.co/datasets/scikit-fingerprints/MolPILE/resolve/${REVISION}/${spec.file}`
  console.error(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${parquet}.part`))
  const got = sha256(readFileSync(`${parquet}.part`))
  if (got !== spec.sha256) throw new Error(`${spec.file}: sha256 ${got}, expected ${spec.sha256}`)
  renameSync(`${parquet}.part`, parquet)
}

// the subsets are ZSTD-compressed; Node has zstd built in since 22.15
const rows = await parquetReadObjects({
  file: await asyncBufferFromFile(parquet),
  columns: ['SMILES'],
  compressors: { ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)) },
})
const smiles = rows.map((r) => r.SMILES).filter(Boolean)

// Fisher-Yates with mulberry32, so the order doesn't depend on the platform
let state = SEED
const random = () => {
  state = (state + 0x6d2b79f5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
for (let i = smiles.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1))
  ;[smiles[i], smiles[j]] = [smiles[j], smiles[i]]
}

const text = smiles.join('\n') + '\n'
writeFileSync(join(dir, 'mols.smi'), text)
writeFileSync(join(dir, 'mols.json'), JSON.stringify({ source: `MolPILE ${spec.file} @ ${REVISION.slice(0, 7)}`, seed: SEED }) + '\n')
console.log(`data/mols.smi: ${smiles.length} molecules from MolPILE ${subset} (shuffled, seed ${SEED}), sha256 ${sha256(text)}`)
