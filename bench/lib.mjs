// Helpers shared by the runners (node.mjs, browser.mjs) and data.mjs.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// --key value / --key=value / --flag, typed after the defaults
export function parseArgs(argv, defaults) {
  const args = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i])
    if (!m) throw new Error(`unexpected argument ${argv[i]}`)
    const [, key, inline] = m
    if (!(key in defaults)) throw new Error(`unknown option --${key}`)
    const type = typeof defaults[key]
    // a boolean flag takes a following true/false (`--queries false`), or is true on its own
    const value = inline ?? (type !== 'boolean' ? argv[++i] : /^(true|false)$/.test(argv[i + 1]) ? argv[++i] : 'true')
    args[key] = type === 'boolean' ? value !== 'false' : type === 'number' ? Number(value) : value
  }
  return args
}

// "10k,50k,1M" -> [10000, 50000, 1000000]
export function sizes(list) {
  return String(list)
    .split(',')
    .map((s) => Math.round(Number(s.trim().replace(/k$/i, 'e3').replace(/m$/i, 'e6'))))
}

const DATASET = join(HERE, 'data/mols.smi')

// the whole dataset, for the runner process; measured processes stream it with readSmiles()
export function readDataset() {
  const path = DATASET
  if (!existsSync(path)) throw new Error('data/mols.smi is missing: run `npm run data` first')
  const text = readFileSync(path, 'utf8')
  const meta = JSON.parse(readFileSync(join(HERE, 'data/mols.json'), 'utf8'))
  return { smiles: text.trim().split('\n'), ...meta, sha256: createHash('sha256').update(text).digest('hex') }
}

/** Streams data/mols.smi line by line, so the reading process never holds all of it. */
export async function* readSmiles() {
  for await (const line of createInterface({ input: createReadStream(DATASET), crlfDelay: Infinity })) if (line) yield line
}

function packageInfo(name) {
  const dir = join(HERE, 'node_modules', name)
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const real = realpathSync(dir)
  // linked to this repository's package/ (the default): record the commit, the version is 0.0.0
  if (!relative(ROOT, real).startsWith('..')) {
    let commit = 'unknown commit'
    try {
      commit = execFileSync('git', ['-C', ROOT, 'describe', '--tags', '--always', '--dirty'], { encoding: 'utf8' }).trim()
    } catch {}
    return { version, source: `${relative(ROOT, real)}/ @ ${commit}` }
  }
  return { version, source: 'npm' }
}

export function environment(dataset) {
  return {
    date: new Date().toISOString(),
    pglite: packageInfo('@electric-sql/pglite'),
    pgliteRdkit: packageInfo('pglite-rdkit'),
    dataset: { source: dataset.source, seed: dataset.seed, molecules: dataset.smiles.length, sha256: dataset.sha256 },
    machine: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 2 ** 30),
    },
    node: process.version,
  }
}

/** Resident memory in MB of the given processes (macOS and Linux), keyed by pid. */
export function rssMB(pids) {
  if (!pids.length || process.platform === 'win32') return {}
  try {
    const out = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8' })
    return Object.fromEntries(
      out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [pid, kb] = l.trim().split(/\s+/).map(Number)
          return [pid, Math.round(kb / 1024)]
        }),
    )
  } catch {
    return {} // exited
  }
}

/**
 * Physical footprint of a process in MB (macOS only, else null): the dirty memory it is charged
 * for, which Activity Monitor shows and the OS kills on. Unlike RSS it leaves out clean, shared
 * pages. `peak` is the kernel's exact high watermark, which sampling from outside can miss.
 */
export function footprintMB(pid) {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('footprint', ['--noCategories', '-f', 'bytes', String(pid)], { encoding: 'utf8' })
    const get = (key) => Math.round(Number(new RegExp(`${key}: (\\d+) B`).exec(out)[1]) / 2 ** 20)
    return { current: get('phys_footprint'), peak: get('phys_footprint_peak') }
  } catch {
    return null
  }
}

/**
 * Polls the processes from `getPids()` and keeps the peak RSS of the largest one. Sampled from
 * outside, since a long synchronous wasm call blocks timers inside the measured process.
 */
export function peakSampler(getPids, intervalMs = 250) {
  let peak = null
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const values = Object.values(rssMB(await getPids()))
      if (values.length) peak = Math.max(peak ?? 0, ...values)
    } catch {}
    busy = false
  }, intervalMs)
  return {
    stop() {
      clearInterval(timer)
      return peak
    },
  }
}

export function resultPath(out, env, label) {
  if (out) return resolve(out)
  const stamp = env.date.slice(0, 16).replace(/[:T]/g, '-')
  return join(HERE, 'results', `${stamp}-${label}-pglite${env.pglite.version}-rdkit${env.pgliteRdkit.version}.json`)
}

export function save(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}
