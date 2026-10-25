#!/usr/bin/env node
// Runs the benchmark in a real browser through Playwright: a fresh browser per size and storage
// mode, so every run starts with empty storage and a new tab process. For Chromium it also
// records the tab's peak resident memory (the figure that ends in an out-of-memory tab crash).
// With idb storage, the saved database is then reopened in a new tab, as a returning visitor would.
//
// usage: node browser.mjs [--sizes 10k,50k,100k] [--storage memory,idb] [--browser chromium]
//                         [--channel chrome] [--queries false] [--runs 3] [--replicas 1] [--timeout 60]
//                         [--headed] [--out results/x.json]
import { build, preview } from 'vite'
import { HERE, environment, parseArgs, peakSampler, readDataset, resultPath, save, sizes } from './lib.mjs'
import { summarize } from './report.mjs'

const args = parseArgs(process.argv.slice(2), {
  sizes: '10k,50k,100k',
  storage: 'memory,idb',
  browser: 'chromium',
  channel: '',
  queries: true,
  runs: 3,
  timeout: 60,
  replicas: 1,
  headed: false,
  out: '',
})
const browserType = (await import('playwright'))[args.browser]
if (!browserType) throw new Error(`unknown browser ${args.browser} (chromium, firefox or webkit)`)
const launch = () => browserType.launch({ headless: !args.headed, ...(args.channel && { channel: args.channel }) })

const env = environment(readDataset())
{
  const b = await launch()
  env.browser = `${args.channel || args.browser} ${b.version()}`
  await b.close()
}
const path = resultPath(args.out, env, args.channel || args.browser)
const result = { env, runs: [] }
console.log(`${env.browser}, pglite ${env.pglite.version}, pglite-rdkit ${env.pgliteRdkit.version} (${env.pgliteRdkit.source})`)
console.log(`writing ${path}`)

// A production build served statically: the dev server's client reloads the page when its
// websocket drops, which restarted long runs against a half-built database
const vite = { root: HERE, configFile: `${HERE}/vite.config.mjs`, logLevel: 'warn' }
await build({ ...vite, logLevel: 'error' }) // PGlite's Node-only code paths warn
const server = await preview({ ...vite, preview: { port: 0 } })
const base = server.resolvedUrls.local[0]

// Loads one page and waits for window.__bench; a crash or timeout becomes { error }
async function runPage(browser, page, url, label) {
  page.on('console', (m) => m.text().startsWith('[bench] ') && console.log(`  ${label} ${m.text().slice(8)}`))
  let pids = async () => []
  if (args.browser === 'chromium') {
    const cdp = await browser.newBrowserCDPSession()
    pids = async () => {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
      return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id)
    }
  }
  const sampler = peakSampler(pids)
  let out
  try {
    const crashed = new Promise((_, reject) => {
      page.on('crash', () => reject(new Error('tab crashed (out of memory?)')))
      // a second load would silently restart the run against the half-built database
      let loads = 0
      page.on('load', () => ++loads > 1 && reject(new Error('page reloaded during the run')))
    })
    crashed.catch(() => {})
    await page.goto(url)
    await Promise.race([
      page.waitForFunction(() => window.__bench?.done, null, { timeout: args.timeout * 60_000, polling: 1000 }),
      crashed,
    ])
    out = await page.evaluate(() => window.__bench.result)
  } catch (e) {
    out = { error: String(e?.message ?? e).split('\n')[0] }
  }
  out.peakTabRssMB = sampler.stop()
  return out
}

// each replica is a full pass over the sizes, so repeats of a size are spread out in time
for (const storage of args.storage.split(',')) {
  for (let replica = 1; replica <= args.replicas; replica++) for (const n of sizes(args.sizes)) {
    const label = `[${storage} ${n}${args.replicas > 1 ? ` #${replica}` : ''}]`
    const dataDir = storage === 'idb' ? `idb://bench-${n}` : ''
    const params = new URLSearchParams({ n, queries: args.queries ? '1' : '0', runs: args.runs })
    if (dataDir) params.set('dataDir', dataDir)
    const browser = await launch()
    const context = await browser.newContext()
    const run = { storage, n, replica, ...(await runPage(browser, await context.newPage(), `${base}?${params}`, label)) }
    if (dataDir && !run.error) {
      const reopen = new URLSearchParams({ reopen: '1', dataDir })
      run.reopen = await runPage(browser, await context.newPage(), `${base}?${reopen}`, `${label} reopen`)
    }
    await browser.close()
    result.runs.push(run)
    save(path, result)
    console.log(`${label} ${run.error ? `failed: ${run.error}` : 'ok'}, peak tab memory ${run.peakTabRssMB ?? '?'} MB`)
  }
}
await server.close()
console.log(`\n${summarize([path])}`)
