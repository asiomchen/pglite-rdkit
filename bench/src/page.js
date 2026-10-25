// Browser side of the benchmark. Query parameters:
//   n=10000           rows to load
//   dataDir=idb://x   PGlite dataDir (memory when omitted)
//   queries=0         load and index only
//   runs=3            runs per query
//   reopen=1          open an existing dataDir instead (run after a run with the same dataDir)
// The result is left in window.__bench for browser.mjs; progress goes to the console and the page.
import { PGlite } from '@electric-sql/pglite'
import { rdkit } from 'pglite-rdkit'
import { runBenchmark, runReopen } from './core.js'

const params = new URLSearchParams(location.search)
const pre = document.getElementById('log')
const log = (msg) => {
  console.log(`[bench] ${msg}`)
  pre.textContent += `${msg}\n`
}
// Chromium only; the JS heap, without ArrayBuffer backing stores (PGlite's in-memory files)
const memory = () =>
  performance.memory ? { jsHeapMB: Math.round(performance.memory.usedJSHeapSize / 2 ** 20) } : {}

// streams /mols.smi line by line, so the tab never holds the whole dataset
async function* readSmiles() {
  const reader = (await fetch('/mols.smi')).body.pipeThrough(new TextDecoderStream()).getReader()
  let rest = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = (rest + value).split('\n')
      rest = lines.pop()
      for (const line of lines) if (line) yield line
    }
    if (rest) yield rest
  } finally {
    // stops the download when the benchmark has read enough rows
    reader.cancel().catch(() => {})
  }
}

window.__bench = { done: false }
try {
  const dataDir = params.get('dataDir') || undefined
  let result
  if (params.get('reopen') === '1') {
    result = await runReopen({ PGlite, rdkit, dataDir, log, memory })
  } else {
    result = await runBenchmark({
      PGlite,
      rdkit,
      smiles: readSmiles,
      n: Number(params.get('n') ?? 10000),
      dataDir,
      queries: params.get('queries') !== '0',
      runs: Number(params.get('runs') ?? 3),
      log,
      memory,
    })
  }
  window.__bench = { done: true, result }
} catch (e) {
  window.__bench = { done: true, result: { error: String(e?.message ?? e) } }
}
log('done')
