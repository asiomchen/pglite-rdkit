#!/usr/bin/env node
// Runs the same benchmark (src/core.js) against native PostgreSQL with the RDKit cartridge, in a
// Docker container limited to one CPU core and configured like PGlite, as a server-side baseline.
// One fresh container per size; queries go through node-postgres over a local port, so each
// timing includes a client round trip that PGlite doesn't have (well under a millisecond).
// Peak memory is the container's cgroup peak (Postgres processes plus their page cache).
//
// usage: node docker.mjs [--image ghcr.io/asiomchen/rdkit-postgres:postgres18.6-rdkit2026.09.1]
//                        [--sizes 10k,50k,100k] [--cpus 1] [--queries false] [--runs 3]
//                        [--replicas 1] [--timeout 60] [--out results/x.json]
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { runBenchmark } from './src/core.js'
import { environment, parseArgs, readDataset, resultPath, save, sizes } from './lib.mjs'
import { summarize } from './report.mjs'

// Images from https://github.com/asiomchen/cheminfo_db_images; this tag matches the PostgreSQL
// (18.6) and RDKit (2026.09.1) versions of the pglite 0.5.10 reference build
const args = parseArgs(process.argv.slice(2), {
  image: 'ghcr.io/asiomchen/rdkit-postgres:postgres18.6-rdkit2026.09.1',
  sizes: '10k,50k,100k',
  cpus: 1,
  queries: true,
  runs: 3,
  timeout: 60,
  replicas: 1,
  out: '',
})

// PGlite's non-default settings (SELECT ... FROM pg_settings WHERE source <> 'default'), plus
// what single-user mode implies: no autovacuum, and no JIT (PGlite has no LLVM)
const SETTINGS = {
  fsync: 'off',
  io_method: 'sync',
  max_worker_processes: '0',
  max_parallel_workers: '0',
  max_parallel_workers_per_gather: '0',
  max_parallel_maintenance_workers: '0',
  shared_buffers: '128MB',
  work_mem: '4MB',
  maintenance_work_mem: '64MB',
  autovacuum: 'off',
  jit: 'off',
}

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dataset = readDataset()
const env = environment(dataset)
docker('pull', '-q', args.image)
env.runtime = `native PostgreSQL in Docker (${args.cpus} CPU)`
env.server = {
  image: args.image,
  digest: JSON.parse(docker('image', 'inspect', args.image, '--format', '{{json .RepoDigests}}'))[0],
  cpus: args.cpus,
  docker: docker('version', '--format', '{{.Server.Version}}'),
  vm: docker('info', '--format', '{{.OperatingSystem}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes'),
  settings: SETTINGS,
}
const path = resultPath(args.out, env, 'docker')
const result = { env, runs: [] }
console.log(`${env.server.image} (${args.cpus} CPU), pglite-rdkit dataset ${dataset.source}`)
console.log(`writing ${path}`)

// cgroup v2 memory of the container, in MB
const cgroupMB = (name, file) => Math.round(Number(docker('exec', name, 'cat', `/sys/fs/cgroup/${file}`)) / 2 ** 20)

async function connect(port) {
  for (let i = 0; i < 120; i++) {
    const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' })
    try {
      await client.connect()
      return client
    } catch {
      await sleep(500)
    }
  }
  throw new Error('PostgreSQL did not start')
}

// each replica is a full pass over the sizes, so repeats of a size are spread out in time
for (let replica = 1; replica <= args.replicas; replica++) for (const n of sizes(args.sizes)) {
  const label = `[server ${n}${args.replicas > 1 ? ` #${replica}` : ''}]`
  const name = `pglite-rdkit-bench-${process.pid}-${n}-${replica}`
  const flags = Object.entries(SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])
  docker('run', '-d', '--rm', '--name', name, '--cpus', String(args.cpus), '--cpuset-cpus', '0',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', args.image, 'postgres', ...flags)
  let run
  try {
    const port = Number(docker('port', name, '5432/tcp').split('\n')[0].split(':').at(-1))
    const client = await connect(port)
    // the PGlite interface core.js uses
    const Server = {
      create: async () => ({
        query: (sql, params) => client.query(sql, params),
        exec: (sql) => client.query(sql),
        close: () => client.end(),
      }),
    }
    const timer = setTimeout(() => docker('kill', name), args.timeout * 60_000)
    run = await runBenchmark({
      PGlite: Server,
      rdkit: null,
      // the client isn't measured, so it keeps the whole dataset
      smiles: async function* () {
        yield* dataset.smiles
      },
      n,
      queries: args.queries,
      runs: args.runs,
      log: (msg) => console.log(`  ${label} ${msg}`),
      memory: () => ({ containerMB: cgroupMB(name, 'memory.current') }),
    })
    clearTimeout(timer)
    run.peakContainerMB = cgroupMB(name, 'memory.peak')
  } catch (e) {
    run = { error: String(e?.message ?? e).split('\n')[0] }
  } finally {
    try {
      docker('stop', name)
    } catch {}
  }
  result.runs.push({ storage: 'server', n, replica, ...run })
  save(path, result)
  console.log(`${label} ${run.error ? `failed: ${run.error}` : 'ok'}, peak container memory ${run.peakContainerMB ?? '?'} MB`)
}
console.log(`\n${summarize([path])}`)
