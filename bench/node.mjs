#!/usr/bin/env node
// Runs the benchmark in Node (or Bun): one child process (node-child.mjs) per size and storage
// mode, with its peak resident memory sampled from here. With file storage, the saved database is
// then reopened in another child process.
//
// usage: node node.mjs [--runtime node|bun] [--sizes 10k,50k,100k] [--storage memory,file]
//                      [--queries false] [--runs 3] [--replicas 1] [--timeout 60] [--out results/x.json]
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HERE, environment, parseArgs, peakSampler, readDataset, resultPath, save, sizes } from './lib.mjs'
import { summarize } from './report.mjs'

const args = parseArgs(process.argv.slice(2), {
  runtime: 'node',
  sizes: '10k,50k,100k',
  storage: 'memory,file',
  queries: true,
  runs: 3,
  timeout: 60,
  replicas: 1,
  out: '',
})
// the children run under this runtime; the runner itself always stays in Node
const runtime = { node: process.execPath, bun: 'bun' }[args.runtime]
if (!runtime) throw new Error(`unknown runtime ${args.runtime} (node or bun)`)
const env = environment(readDataset())
env.runtime = `${args.runtime} ${execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim()}`
const path = resultPath(args.out, env, args.runtime)
const result = { env, runs: [] }
console.log(`${env.runtime}, pglite ${env.pglite.version}, pglite-rdkit ${env.pgliteRdkit.version} (${env.pgliteRdkit.source})`)
console.log(`writing ${path}`)

// Runs node-child.mjs with a JSON job; resolves with its result, or { error } if it dies
function runChild(job, label) {
  return new Promise((resolve) => {
    const child = spawn(runtime, [join(HERE, 'node-child.mjs'), JSON.stringify(job)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const sampler = peakSampler(async () => [child.pid])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => {
      stderr += d
      for (const line of String(d).split('\n')) if (line.startsWith('[bench] ')) console.log(`  ${label} ${line.slice(8)}`)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), args.timeout * 60_000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      let out
      try {
        out = JSON.parse(stdout.trim().split('\n').at(-1))
      } catch {
        const tail = stderr.trim().split('\n').filter((l) => !l.startsWith('[bench] ')).slice(-3).join(' ')
        out = { error: `process exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`.slice(0, 500) }
      }
      out.peakRssMB = sampler.stop()
      resolve(out)
    })
  })
}

// each replica is a full pass over the sizes, so repeats of a size are spread out in time
for (const storage of args.storage.split(',')) {
  for (let replica = 1; replica <= args.replicas; replica++) for (const n of sizes(args.sizes)) {
    const label = `[${storage} ${n}${args.replicas > 1 ? ` #${replica}` : ''}]`
    const dir = storage === 'file' ? mkdtempSync(join(tmpdir(), 'pglite-rdkit-bench-')) : undefined
    const run = { storage, n, replica, ...(await runChild({ n, dataDir: dir, queries: args.queries, runs: args.runs }, label)) }
    if (dir && !run.error) run.reopen = await runChild({ reopen: true, dataDir: dir }, `${label} reopen`)
    if (dir) rmSync(dir, { recursive: true, force: true })
    result.runs.push(run)
    save(path, result)
    console.log(`${label} ${run.error ? `failed: ${run.error}` : 'ok'}, peak memory ${run.peakRssMB ?? '?'} MB`)
  }
}
console.log(`\n${summarize([path])}`)
