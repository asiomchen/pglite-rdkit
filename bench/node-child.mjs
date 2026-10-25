// One Node benchmark run, started by node.mjs with a JSON job as its argument. Progress goes to
// stderr; the result is the last line of stdout.
import { PGlite } from '@electric-sql/pglite'
import { rdkit } from 'pglite-rdkit'
import { runBenchmark, runReopen } from './src/core.js'
import { readDataset } from './lib.mjs'

const job = JSON.parse(process.argv[2])
const log = (msg) => process.stderr.write(`[bench] ${msg}\n`)
// arrayBuffers holds PGlite's in-memory files (memory storage) outside the wasm heap
const memory = () => {
  const m = process.memoryUsage()
  return { rssMB: Math.round(m.rss / 2 ** 20), arrayBuffersMB: Math.round(m.arrayBuffers / 2 ** 20) }
}

const result = job.reopen
  ? await runReopen({ PGlite, rdkit, dataDir: job.dataDir, log, memory })
  : await runBenchmark({ PGlite, rdkit, smiles: readDataset().smiles, ...job, log, memory })
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(0)
