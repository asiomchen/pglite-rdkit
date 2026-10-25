// The benchmark itself, shared by the Node runner (node.mjs) and the browser page (index.html).
// It loads n molecules (the dataset repeated when n is larger, so hit counts grow with n), builds
// Morgan fingerprints and GiST indexes, then times common searches. Every step reports the wasm
// heap through `memory()`; process-level memory is sampled from outside by the runners.

export const SUBSTRUCTURE = {
  'benzene (common)': `'c1ccccc1'::mol`,
  'carboxylic acid (SMARTS)': `'C(=O)[OX2H1]'::qmol`,
  'quinoline (moderate)': `'c1ccc2ncccc2c1'::mol`,
  'steroid core (rare)': `'C1CCC2C(C1)CCC1C2CCC2CCCC21'::mol`,
}

export const SIMILARITY = {
  aspirin: `morganbv_fp('CC(=O)Oc1ccccc1C(=O)O'::mol)`,
  caffeine: `morganbv_fp('Cn1cnc2c1c(=O)n(C)c(=O)n2C'::mol)`,
}

const MB = (b) => Math.round(b / 2 ** 20)
const now = () => globalThis.performance.now()

export function wasmHeapMB(pg) {
  return pg?.mod?.HEAPU8 ? MB(pg.mod.HEAPU8.buffer.byteLength) : null
}

/**
 * @param {object} o
 * @param {typeof import('@electric-sql/pglite').PGlite} o.PGlite
 * @param {object} o.rdkit                the pglite-rdkit extension
 * @param {() => AsyncIterable<string>} o.smiles  reads the dataset once, one SMILES per item; read
 *                                        again while more than n rows are needed, so the measured
 *                                        process holds one chunk of it at a time, not all of it
 * @param {number} o.n                    rows to load
 * @param {string} [o.dataDir]            PGlite dataDir (memory when omitted)
 * @param {boolean} [o.queries=true]      false: load and index only (for finding the size limit)
 * @param {number} [o.runs=3]             runs per query; the median is reported
 * @param {(msg: string) => void} [o.log]
 * @param {() => object} [o.memory]       extra memory figures from the environment
 */
export async function runBenchmark({ PGlite, rdkit, smiles, n, dataDir, queries = true, runs = 3, log = () => {}, memory = () => ({}) }) {
  const out = { n, unique: 0, dataDir: dataDir ?? 'memory', phases: {}, queries: {}, memory: {} }
  let pg
  const snapshot = (label) => {
    out.memory[label] = { wasmHeapMB: wasmHeapMB(pg), ...memory() }
  }
  const phase = async (name, fn) => {
    log(`${name}...`)
    const t = now()
    const r = await fn()
    out.phases[name] = Math.round(now() - t)
    snapshot(name)
    log(`${name}: ${out.phases[name]} ms, wasm heap ${out.memory[name].wasmHeapMB} MB`)
    return r
  }
  const query = async (name, sql, { noIndex = false, times = runs } = {}) => {
    if (noIndex) await pg.exec('SET enable_indexscan = off; SET enable_bitmapscan = off;')
    const ms = []
    let rows
    for (let i = 0; i < times; i++) {
      const t = now()
      const r = await pg.query(sql)
      ms.push(now() - t)
      rows ??= r.rows
    }
    if (noIndex) await pg.exec('RESET enable_indexscan; RESET enable_bitmapscan;')
    ms.sort((a, b) => a - b)
    const single = rows.length === 1 && Object.keys(rows[0]).length === 1
    out.queries[name] = {
      ms: Math.round(ms[Math.floor(ms.length / 2)] * 10) / 10,
      result: single ? Object.values(rows[0])[0] : `${rows.length} rows`,
    }
    log(`${name}: ${out.queries[name].ms} ms (${out.queries[name].result})`)
  }

  try {
    snapshot('start')
    // assigned inside the phase, so its snapshot already sees the new instance's heap
    await phase('startup', async () => (pg = await PGlite.create({ dataDir, extensions: { rdkit } })))
    await phase('createExtension', () => pg.exec('CREATE EXTENSION IF NOT EXISTS rdkit'))
    out.rdkitVersion = (await pg.query('SELECT rdkit_toolkit_version() AS v')).rows[0].v
    out.postgresVersion = (await pg.query('SHOW server_version')).rows[0].server_version
    out.settings = Object.fromEntries(
      (await pg.query(`SELECT name, setting || coalesce(' ' || unit, '') AS v FROM pg_settings
        WHERE name IN ('shared_buffers', 'work_mem', 'maintenance_work_mem')`)).rows.map((r) => [r.name, r.v]),
    )

    await pg.exec('CREATE TABLE raw (id int, smi text)')
    await phase('insertSmiles', async () => {
      let i = 0
      let chunk = []
      const flush = async () => {
        await pg.query('INSERT INTO raw SELECT i + $2, s FROM unnest($1::text[]) WITH ORDINALITY AS t(s, i)', [chunk, i])
        i += chunk.length
        chunk = []
      }
      // the dataset repeated when n is larger
      while (i + chunk.length < n) {
        let read = 0
        for await (const s of smiles()) {
          chunk.push(s)
          read++
          if (chunk.length === 20000) await flush()
          if (i + chunk.length === n) break
        }
        if (!read) throw new Error('the dataset is empty')
        out.unique ||= read
      }
      if (chunk.length) await flush()
    })
    await phase('parseMols', () => pg.exec('CREATE TABLE mols AS SELECT id, mol_from_smiles(smi::cstring) AS m FROM raw'))
    out.parseFailures = (await pg.query('SELECT count(*)::int AS c FROM mols WHERE m IS NULL')).rows[0].c
    await pg.exec('DROP TABLE raw')
    await phase('morganFp', () => pg.exec('CREATE TABLE fps AS SELECT id, morganbv_fp(m) AS mfp2 FROM mols WHERE m IS NOT NULL'))
    await phase('gistMol', () => pg.exec('CREATE INDEX molidx ON mols USING gist (m)'))
    await phase('gistFp', () => pg.exec('CREATE INDEX fpidx ON fps USING gist (mfp2)'))
    await phase('analyze', () => pg.exec('ANALYZE'))
    const sizes = (await pg.query(`SELECT
      pg_database_size(current_database()) AS db, pg_table_size('mols') AS mols, pg_table_size('fps') AS fps,
      pg_relation_size('molidx') AS molidx, pg_relation_size('fpidx') AS fpidx`)).rows[0]
    out.sizesMB = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, MB(Number(v))]))

    if (queries) {
      for (const [label, q] of Object.entries(SUBSTRUCTURE)) {
        await query(`substructure ${label}: count, index`, `SELECT count(*)::int FROM mols WHERE m @> ${q}`)
        await query(`substructure ${label}: count, no index`, `SELECT count(*)::int FROM mols WHERE m @> ${q}`, { noIndex: true })
        await query(`substructure ${label}: first 100, index`, `SELECT id FROM mols WHERE m @> ${q} LIMIT 100`)
      }
      for (const [label, fp] of Object.entries(SIMILARITY)) {
        await query(`similarity ${label} tanimoto >= 0.5: index`, `SELECT count(*)::int FROM fps WHERE mfp2 % ${fp}`)
        await query(`similarity ${label} tanimoto >= 0.5: no index`, `SELECT count(*)::int FROM fps WHERE mfp2 % ${fp}`, { noIndex: true })
        await query(`similarity ${label} top 10 (knn): index`, `SELECT id FROM fps ORDER BY mfp2 <%> ${fp} LIMIT 10`)
      }
      await query('exact match @=: index', `SELECT count(*)::int FROM mols WHERE m @= 'CC(=O)Oc1ccccc1C(=O)O'::mol`)
      await query('mol_amw over all rows', 'SELECT round(avg(mol_amw(m))::numeric, 1) FROM mols', { times: 1 })
      await query('mol_to_svg 100 rows', 'SELECT mol_to_svg(m) FROM mols LIMIT 100', { times: 1 })
    }
    snapshot('end')
    // flushes to the backing store for idb:// before the reopen test
    await phase('close', () => pg.close())
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 500)
    snapshot('error')
    log(`error: ${out.error}`)
  }
  return out
}

/** Opens an existing database (dataDir) and times the first searches, as a page reload would. */
export async function runReopen({ PGlite, rdkit, dataDir, log = () => {}, memory = () => ({}) }) {
  const out = { phases: {}, queries: {}, memory: {} }
  let pg
  try {
    let t = now()
    pg = await PGlite.create({ dataDir, extensions: { rdkit } })
    out.phases.startup = Math.round(now() - t)
    t = now()
    out.rows = (await pg.query('SELECT count(*)::int AS c FROM mols')).rows[0].c
    out.phases.firstQuery = Math.round(now() - t)
    t = now()
    await pg.query(`SELECT id FROM fps ORDER BY mfp2 <%> ${SIMILARITY.aspirin} LIMIT 10`)
    out.queries['similarity aspirin top 10 (knn): index'] = { ms: Math.round((now() - t) * 10) / 10 }
    t = now()
    await pg.query(`SELECT id FROM mols WHERE m @> ${SUBSTRUCTURE['steroid core (rare)']} LIMIT 100`)
    out.queries['substructure steroid core (rare): first 100, index'] = { ms: Math.round((now() - t) * 10) / 10 }
    out.memory.end = { wasmHeapMB: wasmHeapMB(pg), ...memory() }
    log(`reopen: startup ${out.phases.startup} ms, ${out.rows} rows`)
    await pg.close()
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 500)
    log(`reopen error: ${out.error}`)
  }
  return out
}
