// One Node benchmark run, started by node.mjs with a JSON job as its argument. Progress goes to
// stderr; the result is the last line of stdout.
import { PGlite } from '@electric-sql/pglite'
import { rdkit } from 'pglite-rdkit'
import { runBenchmark, runReopen } from './src/core.js'
import { footprintMB, readSmiles } from './lib.mjs'

const job = JSON.parse(process.argv[2])
const log = (msg) => process.stderr.write(`[bench] ${msg}\n`)
// arrayBuffers holds PGlite's in-memory files (memory storage) outside the wasm heap
const memory = () => {
  const m = process.memoryUsage()
  const fp = footprintMB(process.pid)
  return {
    rssMB: Math.round(m.rss / 2 ** 20),
    ...(fp && { footprintMB: fp.current }),
    arrayBuffersMB: Math.round(m.arrayBuffers / 2 ** 20),
  }
}

const result = job.reopen
  ? await runReopen({ PGlite, rdkit, dataDir: job.dataDir, log, memory })
  : await runBenchmark({ PGlite, rdkit, smiles: readSmiles, ...job, log, memory })
// read from inside just before exiting, when the parent can no longer see the process
const fp = footprintMB(process.pid)
if (fp) result.peakFootprintMB = fp.peak
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(0)
