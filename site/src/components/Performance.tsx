import { useEffect, useMemo, useRef, useState } from 'react'
import embed from 'vega-embed'
import type { TopLevelSpec } from 'vega-lite'
import { bootstrapCI, randomLCG, setRandom } from 'vega-statistics'
import data from '../data/benchmarks.json'

/*
 * Charts for the Performance page, drawn with Vega-Lite from src/data/benchmarks.json (written by
 * bench/site-data.mjs from the benchmark results). As in seaborn's lineplot, each line is the mean
 * of the replicas and the band its 95% bootstrap confidence interval. Every environment keeps its
 * color on every chart, and every chart has a table view.
 */

type Replica = {
  n: number
  replica: number
  peakMemoryMB: number | null
  setupMs: number
  queriesMs: Record<string, number>
  hits: Record<string, number>
}
type Environment = { id: string; label: string; replicas: Replica[] }

const ENVIRONMENTS = data.environments as unknown as Environment[]
const SIZES = [...new Set(ENVIRONMENTS.flatMap((e) => e.replicas.map((r) => r.n)))].sort((a, b) => a - b)
const REPLICAS = Math.max(...ENVIRONMENTS.map((e) => e.replicas.filter((r) => r.n === SIZES[0]).length))
const TILE_SIZE = 100000

// The dark steps of the categorical palette, in this fixed order, validated (CVD, contrast,
// lightness) against the chart surface
const COLORS: Record<string, string> = {
  'browser-memory': '#3987e5',
  'browser-idb': '#d95926',
  'node-memory': '#199e70',
  'node-file': '#c98500',
  server: '#d55181',
}
const SURFACE = '#202127'

const QUERIES = [
  {
    key: 'similarity aspirin top 10 (knn): index',
    label: 'Top 10 most similar',
    sql: "SELECT id FROM fps ORDER BY mfp2 <%> morganbv_fp('CC(=O)Oc1ccccc1C(=O)O'::mol) LIMIT 10",
  },
  {
    key: 'similarity aspirin tanimoto >= 0.5: index',
    label: 'Similarity ≥ 0.5',
    sql: "SELECT count(*) FROM fps WHERE mfp2 % morganbv_fp('CC(=O)Oc1ccccc1C(=O)O'::mol)",
  },
  {
    key: 'similarity aspirin tanimoto >= 0.5: no index',
    label: 'Similarity, no index',
    sql: "SELECT count(*) FROM fps WHERE mfp2 % morganbv_fp('CC(=O)Oc1ccccc1C(=O)O'::mol)  -- index scans off",
  },
  {
    key: 'exact match @=: index',
    label: 'Exact match',
    sql: "SELECT count(*) FROM mols WHERE m @= 'CC(=O)Oc1ccccc1C(=O)O'::mol",
  },
  {
    key: 'substructure quinoline (moderate): first 100, index',
    label: 'Substructure, first 100',
    sql: "SELECT id FROM mols WHERE m @> 'c1ccc2ncccc2c1'::mol LIMIT 100",
  },
  {
    key: 'substructure steroid core (rare): count, index',
    label: 'Substructure count, rare',
    sql: "SELECT count(*) FROM mols WHERE m @> 'C1CCC2C(C1)CCC1C2CCC2CCCC21'::mol",
  },
  {
    key: 'substructure benzene (common): count, index',
    label: 'Substructure count, common',
    sql: "SELECT count(*) FROM mols WHERE m @> 'c1ccccc1'::mol",
  },
  {
    key: 'substructure steroid core (rare): count, no index',
    label: 'Substructure, no index',
    sql: "SELECT count(*) FROM mols WHERE m @> 'C1CCC2C(C1)CCC1C2CCC2CCCC21'::mol  -- index scans off",
  },
  {
    key: 'mol_amw over all rows',
    label: 'Compute over all rows',
    sql: 'SELECT avg(mol_amw(m)) FROM mols',
  },
  {
    key: 'mol_to_svg 100 rows',
    label: 'Draw 100 molecules',
    sql: 'SELECT mol_to_svg(m) FROM mols LIMIT 100',
  },
]

// ---- statistics ----

type Stat = { mean: number; lo?: number; hi?: number }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

// The mean and its 95% confidence interval: vega-statistics' percentile bootstrap with 1,000
// resamples, the function behind Vega-Lite's "ci" extent and the same method as seaborn's
// errorbar=('ci', 95). Seeded, so the band and the table agree and don't change between loads.
function stat(xs: number[]): Stat | null {
  if (!xs.length) return null
  if (xs.length < 2) return { mean: xs[0] }
  setRandom(randomLCG(1))
  const [lo, hi] = bootstrapCI(xs, 1000, 0.05)
  return { mean: mean(xs), lo, hi }
}

type Row = { env: string; label: string; n: number } & Stat

/** One row per environment and size, from the replicas' values */
function summarize(value: (r: Replica) => number | null | undefined, scale = 1): Row[] {
  return ENVIRONMENTS.flatMap((e) =>
    SIZES.flatMap((n) => {
      const xs = e.replicas
        .filter((r) => r.n === n)
        .map(value)
        .filter((v): v is number => v != null)
        .map((v) => v / scale)
      const s = stat(xs)
      return s ? [{ env: e.id, label: e.label, n, ...s }] : []
    }),
  )
}

// ---- formatting ----

const fmtMs = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`
const fmtSeconds = (s: number) => `${s.toFixed(s >= 10 ? 0 : 1)} s`
const fmtGB = (gb: number) => (gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`)

// "0.3–0.4 ms" rather than "0.3 ms–0.4 ms"; nothing when both ends round the same, since it
// would only repeat the mean
function fmtRange(lo: number | undefined, hi: number | undefined, format: (v: number) => string) {
  if (lo == null || hi == null) return null
  const [a, b] = [format(lo), format(hi)]
  if (a === b) return null
  const unit = (v: string) => v.split(' ').at(-1)
  return unit(a) === unit(b) ? `${a.split(' ')[0]}–${b}` : `${a}–${b}`
}

// ---- chart ----

const KEY = '\u001f' // joins an environment and a statistic in the pivoted tooltip fields

function spec(title: string, rows: Row[], unit: string): TopLevelSpec {
  const color = {
    field: 'env',
    type: 'nominal' as const,
    scale: { domain: ENVIRONMENTS.map((e) => e.id), range: ENVIRONMENTS.map((e) => COLORS[e.id]) },
    // an HTML legend above the chart instead (Legend below): Vega's legends don't wrap on phones
    legend: null,
  }
  const y = { type: 'quantitative' as const, title: null, axis: { labelExpr: `datum.label + ' ${unit}'`, tickCount: 4 } }
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    description: `${title}. One line per environment, by number of molecules.`,
    width: 'container',
    height: 240,
    background: 'transparent',
    padding: { left: 0, right: 8, top: 4, bottom: 0 },
    data: { values: rows },
    encoding: {
      x: {
        field: 'n',
        type: 'quantitative',
        scale: { type: 'log', domain: [SIZES[0], SIZES.at(-1)!], nice: false },
        axis: { values: SIZES, format: ',', title: 'molecules (log scale)', grid: false },
      },
    },
    layer: [
      { mark: { type: 'area', opacity: 0.2 }, encoding: { y: { ...y, field: 'lo' }, y2: { field: 'hi' }, color } },
      { mark: { type: 'line', strokeWidth: 2 }, encoding: { y: { ...y, field: 'mean' }, color } },
      {
        mark: { type: 'point', filled: true, opacity: 1, size: 60, stroke: SURFACE, strokeWidth: 2 },
        encoding: { y: { ...y, field: 'mean' }, color },
      },
      // Vega-Lite's multi-series tooltip: a rule at the nearest size, carrying every environment
      {
        transform: [
          { fold: ['mean', 'lo', 'hi'], as: ['stat', 'v'] },
          { calculate: `datum.env + '${KEY}' + datum.stat`, as: 'key' },
          { pivot: 'key', value: 'v', groupby: ['n'] },
        ],
        mark: { type: 'rule', color: '#6b6b70', tooltip: { content: 'data' } },
        params: [{ name: 'hover', select: { type: 'point', fields: ['n'], nearest: true, on: 'pointerover', clear: 'pointerout' } }],
        encoding: { opacity: { condition: { param: 'hover', empty: false, value: 1 }, value: 0 } },
      },
    ],
    config: {
      font: 'Inter Variable, ui-sans-serif, system-ui, sans-serif',
      view: { stroke: null },
      axis: {
        labelColor: 'rgba(235, 235, 245, 0.55)',
        titleColor: 'rgba(235, 235, 245, 0.55)',
        titleFontWeight: 'normal',
        labelFontSize: 11,
        titleFontSize: 11,
        gridColor: '#2c2c30',
        domainColor: '#3c3f44',
        tickColor: '#3c3f44',
        labelFlush: true,
      },
      axisY: { domain: false, ticks: false, labelPadding: 8 },
    },
  }
}

/** The tooltip's HTML: every environment at the hovered size, the fastest (or smallest) first */
function tooltipFormatter(format: (v: number) => string) {
  return (value: Record<string, number>, sanitize: (v: unknown) => string) => {
    const rows = ENVIRONMENTS.map((e) => ({
      e,
      mean: value[`${e.id}${KEY}mean`],
      range: fmtRange(value[`${e.id}${KEY}lo`], value[`${e.id}${KEY}hi`], format),
    }))
      .filter((r) => r.mean != null)
      .sort((a, b) => a.mean - b.mean)
    return [
      `<div class="rdkit-tooltip-head">${sanitize(value.n.toLocaleString('en'))} molecules</div>`,
      ...rows.map(
        ({ e, mean, range }) =>
          `<div class="rdkit-tooltip-row"><span class="key" style="background:${COLORS[e.id]}"></span>` +
          `<strong>${sanitize(format(mean))}</strong><span>${sanitize(e.label)}` +
          `${range ? `<span class="rdkit-range">95% CI ${sanitize(range)}</span>` : ''}</span></div>`,
      ),
    ].join('')
  }
}

function Legend() {
  return (
    <ul className="rdkit-legend">
      {ENVIRONMENTS.map((e) => (
        <li key={e.id}>
          <span className="key" style={{ background: COLORS[e.id] }} />
          {e.label}
        </li>
      ))}
    </ul>
  )
}

function Chart({ title, rows, unit, format }: { title: string; rows: Row[]; unit: string; format: (v: number) => string }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!el.current) return
    let cancelled = false
    let finalize = () => {}
    embed(el.current, spec(title, rows, unit), {
      renderer: 'svg',
      actions: false,
      tooltip: { theme: 'custom', formatTooltip: tooltipFormatter(format) as never },
    }).then((result) => {
      if (cancelled) result.finalize()
      else finalize = () => result.finalize()
    })
    return () => {
      cancelled = true
      finalize()
    }
  }, [title, rows, unit, format])

  return (
    <figure className="rdkit-chart">
      <figcaption className="rdkit-chart-title">{title}</figcaption>
      <Legend />
      <div className="rdkit-vega" ref={el} />
      <details className="rdkit-chart-table">
        <summary>Show as table</summary>
        <div className="rdkit-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Molecules</th>
                {ENVIRONMENTS.map((e) => (
                  <th key={e.id} scope="col">
                    {e.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SIZES.map((n) => (
                <tr key={n}>
                  <th scope="row">{n.toLocaleString('en')}</th>
                  {ENVIRONMENTS.map((e) => {
                    const r = rows.find((x) => x.env === e.id && x.n === n)
                    const range = r && fmtRange(r.lo, r.hi, format)
                    return (
                      <td key={e.id}>
                        {r ? format(r.mean) : '—'}
                        {range && <span className="rdkit-range"> ({range})</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

// ---- page ----

function Tile({ label, value, native }: { label: string; value: string; native?: string }) {
  return (
    <div className="rdkit-tile">
      <div className="rdkit-tile-label">{label}</div>
      <div className="rdkit-tile-value">{value}</div>
      {native && <div className="rdkit-tile-note">PostgreSQL server: {native}</div>}
    </div>
  )
}

const at = (rows: Row[], env: string, n = TILE_SIZE) => rows.find((r) => r.env === env && r.n === n)?.mean

export default function Performance() {
  const [queryKey, setQueryKey] = useState(QUERIES[0].key)
  const query = QUERIES.find((q) => q.key === queryKey)!

  const searchRows = useMemo(() => summarize((r) => r.queriesMs[queryKey]), [queryKey])
  const setupRows = useMemo(() => summarize((r) => r.setupMs, 1000), [])
  const memoryRows = useMemo(() => summarize((r) => r.peakMemoryMB, 1024), [])
  const tileRows = useMemo(
    () => Object.fromEntries(QUERIES.slice(0, 5).map((q) => [q.key, summarize((r) => r.queriesMs[q.key])])),
    [],
  )
  const hits = ENVIRONMENTS[0].replicas.find((r) => r.n === TILE_SIZE)?.hits[queryKey]
  const tile = (rows: Row[], format: (v: number) => string) => {
    const [b, s] = [at(rows, 'browser-memory'), at(rows, 'server')]
    return { value: b == null ? '—' : format(b), native: s == null ? undefined : format(s) }
  }

  return (
    <div className="rdkit-perf not-content">
      <section aria-label={`At ${TILE_SIZE.toLocaleString('en')} molecules in the browser`}>
        <h2 className="rdkit-perf-h">At {TILE_SIZE.toLocaleString('en')} molecules, in the browser</h2>
        <div className="rdkit-tiles">
          {[
            ['Top 10 most similar', QUERIES[0].key],
            ['Similarity search', QUERIES[1].key],
            ['Substructure, first 100 hits', QUERIES[4].key],
          ].map(([label, key]) => (
            <Tile key={key} label={label} {...tile(tileRows[key], fmtMs)} />
          ))}
          <Tile label="Load and index from SMILES" {...tile(setupRows, fmtSeconds)} />
          <Tile label="Peak tab memory" {...tile(memoryRows, fmtGB)} />
        </div>
      </section>

      <section aria-label="Search time">
        <h2 className="rdkit-perf-h">Search time</h2>
        <div className="rdkit-query-picker" role="group" aria-label="Query">
          {QUERIES.map((q) => (
            <button key={q.key} type="button" aria-pressed={q.key === queryKey} onClick={() => setQueryKey(q.key)}>
              {q.label}
            </button>
          ))}
        </div>
        <pre className="rdkit-perf-sql">
          <code>{query.sql}</code>
        </pre>
        <Chart
          title={`${query.label}: mean of ${REPLICAS} fresh runs, with its 95% confidence interval`}
          rows={searchRows}
          unit="ms"
          format={fmtMs}
        />
        {hits != null && (
          <p className="rdkit-hint">
            {hits.toLocaleString('en')} matches at {TILE_SIZE.toLocaleString('en')} molecules.
          </p>
        )}
      </section>

      <section aria-label="Setup time">
        <h2 className="rdkit-perf-h">Load and index from SMILES</h2>
        <Chart
          title="Parse SMILES, compute Morgan fingerprints, build both GiST indexes, ANALYZE"
          rows={setupRows}
          unit="s"
          format={fmtSeconds}
        />
      </section>

      <section aria-label="Peak memory">
        <h2 className="rdkit-perf-h">Peak memory</h2>
        <Chart
          title="Browser tab or Node process; the whole container for the PostgreSQL server"
          rows={memoryRows}
          unit="GB"
          format={fmtGB}
        />
      </section>

      <section aria-label="Test setup">
        <h2 className="rdkit-perf-h">Test setup</h2>
        <dl className="rdkit-setup">
          <dt>Date</dt>
          <dd>{data.date}</dd>
          <dt>Machine</dt>
          <dd>{data.machine}</dd>
          <dt>Versions</dt>
          <dd>
            PGlite {data.versions.pglite}, PostgreSQL {data.versions.postgres}, RDKit {data.versions.rdkit},{' '}
            {data.versions.browser}, {data.versions.node}
          </dd>
          <dt>Server baseline</dt>
          <dd>
            <code>{data.versions.server}</code>
          </dd>
          <dt>Data</dt>
          <dd>
            {data.dataset.source}, shuffled (seed {data.dataset.seed}); the first <em>n</em> molecules of each run
          </dd>
        </dl>
      </section>
    </div>
  )
}
