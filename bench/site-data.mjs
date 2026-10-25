#!/usr/bin/env node
// Writes site/src/data/benchmarks.json, the data behind the site's Performance page, from the
// newest browser, Node and Docker result files (or the ones given). Rerun after benchmarking a
// new release, then rebuild the site.
//
// usage: node site-data.mjs [--browser results/a.json] [--node results/b.json] [--docker results/c.json]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HERE, parseArgs } from './lib.mjs'

const newest = (kind) => {
  const file = readdirSync(join(HERE, 'results'))
    .filter((f) => f.includes(`-${kind}-`) && f.endsWith('.json'))
    .sort()
    .at(-1)
  if (!file) throw new Error(`no ${kind} result in results/`)
  return join(HERE, 'results', file)
}
const args = parseArgs(process.argv.slice(2), { browser: '', node: '', docker: '' })
const files = {
  browser: resolve(args.browser || newest('chromium')),
  node: resolve(args.node || newest('node')),
  docker: resolve(args.docker || newest('docker')),
}
const results = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, JSON.parse(readFileSync(f, 'utf8'))]))

// series in their fixed color order on the page
const ENVIRONMENTS = [
  { id: 'browser-memory', label: 'Browser, in memory', from: 'browser', storage: 'memory' },
  { id: 'browser-idb', label: 'Browser, IndexedDB', from: 'browser', storage: 'idb' },
  { id: 'node-memory', label: 'Node, in memory', from: 'node', storage: 'memory' },
  { id: 'node-file', label: 'Node, file storage', from: 'node', storage: 'file' },
  { id: 'server', label: 'PostgreSQL server, 1 core', from: 'docker', storage: 'server' },
]

const SETUP_PHASES = ['parseMols', 'morganFp', 'gistMol', 'gistFp', 'analyze']

// The raw value of every replica (a fresh browser, process or container each); the page computes
// the means and confidence intervals from these
const replica = (run) => ({
  n: run.n,
  replica: run.replica ?? 1,
  peakMemoryMB: run.peakTabRssMB ?? run.peakRssMB ?? run.peakContainerMB ?? null,
  setupMs: SETUP_PHASES.reduce((sum, p) => sum + (run.phases?.[p] ?? 0), 0),
  queriesMs: Object.fromEntries(Object.entries(run.queries ?? {}).map(([k, v]) => [k, v.ms])),
  hits: Object.fromEntries(
    Object.entries(run.queries ?? {}).filter(([, v]) => typeof v.result === 'number').map(([k, v]) => [k, v.result]),
  ),
})

const environments = ENVIRONMENTS.map(({ from, storage, ...e }) => ({
  ...e,
  replicas: results[from].runs.filter((r) => r.storage === storage && !r.error).map(replica),
}))

const { env } = results.browser
const any = results.browser.runs.find((r) => r.rdkitVersion)
const data = {
  date: env.date.slice(0, 10),
  machine: `${env.machine.cpu}, ${env.machine.memoryGB} GB, ${env.machine.platform}`,
  versions: {
    pglite: env.pglite.version,
    pgliteRdkit: env.pgliteRdkit.source === 'npm' ? env.pgliteRdkit.version : env.pgliteRdkit.source,
    rdkit: any?.rdkitVersion,
    postgres: any?.postgresVersion,
    browser: env.browser,
    node: results.node.env.runtime ?? results.node.env.node,
    server: `${results.docker.env.server.image} (${results.docker.env.server.cpus} CPU)`,
  },
  dataset: env.dataset,
  environments,
}
const out = resolve(HERE, '../site/src/data/benchmarks.json')
writeFileSync(out, JSON.stringify(data, null, 2) + '\n')
console.log(`wrote ${out} from\n  ${Object.values(files).join('\n  ')}`)
