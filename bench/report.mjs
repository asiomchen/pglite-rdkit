#!/usr/bin/env node
// Prints result files as one markdown table, a column per run, to compare sizes, storage modes,
// browsers or releases side by side.
//
// usage: node report.mjs [results/a.json results/b.json ...]   (default: the newest result)
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HERE } from './lib.mjs'

const PHASES = ['startup', 'createExtension', 'insertSmiles', 'parseMols', 'morganFp', 'gistMol', 'gistFp', 'analyze']
const count = (n) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : `${n}`)
const seconds = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)} s`)
const millis = (q) => (q == null ? '' : `${q.ms} ms${typeof q.result === 'number' ? ` (${q.result})` : ''}`)

export function summarize(files) {
  const results = files.map((f) => ({ file: basename(f), ...JSON.parse(readFileSync(f, 'utf8')) }))
  const cols = results.flatMap((r, i) =>
    r.runs.map((run) => ({ run, label: `${results.length > 1 ? `#${i + 1} ` : ''}${run.storage} ${count(run.n)}${r.runs.some((x) => x.replica > 1) ? ` r${run.replica}` : ''}` })),
  )
  const rows = []
  const row = (name, fn) => {
    const cells = cols.map(({ run }) => fn(run) ?? '')
    if (cells.some((c) => c !== '')) rows.push([name, ...cells])
  }
  row('**error**', (r) => r.error ?? r.reopen?.error)
  row('peak process memory', (r) => {
    const mb = r.peakTabRssMB ?? r.peakRssMB ?? r.peakContainerMB
    return mb && `${mb} MB${r.peakContainerMB ? ' (container)' : ''}`
  })
  row('wasm heap at end', (r) => r.memory?.end?.wasmHeapMB && `${r.memory.end.wasmHeapMB} MB`)
  row('database size', (r) => r.sizesMB && `${r.sizesMB.db} MB`)
  row('SMILES that failed to parse', (r) => r.parseFailures)
  for (const p of PHASES) row(p, (r) => seconds(r.phases?.[p]))
  const queries = [...new Set(cols.flatMap(({ run }) => Object.keys(run.queries ?? {})))]
  for (const q of queries) row(q, (r) => millis(r.queries?.[q]))
  row('reopen: startup', (r) => seconds(r.reopen?.phases?.startup))
  row('reopen: first query', (r) => seconds(r.reopen?.phases?.firstQuery))
  for (const q of Object.keys(cols.find(({ run }) => run.reopen?.queries)?.run.reopen.queries ?? {})) {
    row(`reopen: ${q}`, (r) => millis(r.reopen?.queries?.[q]))
  }
  row('reopen: peak process memory', (r) => {
    const mb = r.reopen?.peakTabRssMB ?? r.reopen?.peakRssMB
    return mb && `${mb} MB`
  })

  const header = results.map((r, i) => {
    const e = r.env
    return [
      `${results.length > 1 ? `#${i + 1} ` : ''}\`${r.file}\`: ${e.browser ?? e.runtime ?? `node ${e.node}`}, pglite ${e.pglite.version},`,
      `pglite-rdkit ${e.pgliteRdkit.version} (${e.pgliteRdkit.source}), RDKit ${r.runs.find((x) => x.rdkitVersion)?.rdkitVersion ?? '?'},`,
      `${e.machine.cpu} ${e.machine.memoryGB} GB, ${e.machine.platform}; ${e.dataset.source}`,
    ].join(' ')
  })
  const table = [['', ...cols.map((c) => c.label)], cols.map(() => '---').concat('---'), ...rows]
  return [...header, '', ...table.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let files = process.argv.slice(2)
  if (!files.length) {
    const dir = join(HERE, 'results')
    const newest = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1)
    if (!newest) throw new Error('no results yet')
    files = [join(dir, newest)]
  }
  console.log(summarize(files))
}
