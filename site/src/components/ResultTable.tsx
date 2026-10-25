import { Fragment, useState } from 'react'
import { MAX_TEXT, count, formatValue, isSvg, svgDataUrl } from '../lib/format'
import type { RunError, RunOutcome, StatementResult } from '../lib/run'

const PAGE = 100

/** RDKit's drawing size, so the row height is reserved before the image decodes */
function svgSize(svg: string): { width?: number; height?: number } {
  const size = (attr: string) => {
    const m = new RegExp(`<svg[^>]*\\s${attr}=['"](\\d+)`).exec(svg)
    return m ? Number(m[1]) : undefined
  }
  return { width: size('width'), height: size('height') }
}

/** Alt text for drawings: the row's name or id column when there is one */
function rowLabel(columns: string[], row: unknown[], index: number): string {
  for (const key of ['name', 'id']) {
    const i = columns.findIndex((c) => c.toLowerCase() === key)
    if (i !== -1 && row[i] !== null && row[i] !== undefined) return `Structure of ${formatValue(row[i])}`
  }
  return `Structure, row ${index + 1}`
}

function Cell({ value, label }: { value: unknown; label: string }) {
  const [expanded, setExpanded] = useState(false)
  if (value === null || value === undefined) return <span className="rdkit-null">NULL</span>
  if (isSvg(value)) {
    return <img className="rdkit-mol" src={svgDataUrl(value)} alt={label} loading="lazy" {...svgSize(value)} />
  }
  const text = formatValue(value)
  if (text.length <= MAX_TEXT || expanded) return <>{text}</>
  return (
    <>
      {text.slice(0, MAX_TEXT)}
      <button type="button" className="rdkit-more" onClick={() => setExpanded(true)}>
        … +{text.length - MAX_TEXT}
      </button>
    </>
  )
}

function Grid({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((v, c) => (
              <td key={c}>
                <Cell value={v} label={rowLabel(columns, row, r)} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Rows with a drawing as cards that wrap across the width: the structure on top, the other
 * columns under it. A table row per molecule fits one or two drawings on screen; this fits a few
 * rows of them.
 */
function Cards({ columns, rows, drawn }: { columns: string[]; rows: unknown[][]; drawn: boolean[] }) {
  return (
    <ul className="rdkit-cards">
      {rows.map((row, r) => (
        <li key={r} className="rdkit-card">
          {row.map((v, c) => drawn[c] && <Cell key={c} value={v} label={rowLabel(columns, row, r)} />)}
          <dl>
            {row.map(
              (v, c) =>
                !drawn[c] && (
                  <Fragment key={c}>
                    <dt>{columns[c]}</dt>
                    <dd>
                      <Cell value={v} label={rowLabel(columns, row, r)} />
                    </dd>
                  </Fragment>
                ),
            )}
          </dl>
        </li>
      ))}
    </ul>
  )
}

/** psql's expanded mode (\x): one name/value block per row, for wide rows */
function Records({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <table className="rdkit-records">
      {rows.map((row, r) => (
        <tbody key={r}>
          <tr className="rdkit-record">
            <th colSpan={2}>-[ RECORD {r + 1} ]-</th>
          </tr>
          {row.map((v, c) => (
            <tr key={c}>
              <th scope="row">{columns[c]}</th>
              <td>
                <Cell value={v} label={rowLabel(columns, row, r)} />
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  )
}

interface StatementProps {
  result: StatementResult
  label?: string
  expanded?: boolean
  cards?: boolean
}

function Statement({ result, label, expanded, cards }: StatementProps) {
  const [limit, setLimit] = useState(PAGE)
  const [view, setView] = useState<'cards' | 'table'>('cards')
  if (result.columns.length === 0) {
    return (
      <div className="rdkit-result">
        {label && <div className="rdkit-hint">{label}</div>}
        <p className="rdkit-hint">
          {result.affectedRows ? `${count(result.affectedRows, 'row')} affected` : 'OK'}
        </p>
      </div>
    )
  }
  const { columns, rows, rowCount } = result
  const shown = rows.slice(0, limit)
  // columns holding RDKit drawings; with any, cards are offered (and the default)
  const drawn = columns.map((_, c) => rows.some((row) => isSvg(row[c])))
  const canCards = cards && !expanded && drawn.some(Boolean)
  const asCards = canCards && view === 'cards'
  return (
    <div className="rdkit-result">
      {label && <div className="rdkit-hint">{label}</div>}
      {/* above the results, so it's in view without scrolling through them */}
      {canCards && (
        <div className="rdkit-view" role="group" aria-label="Show results as">
          {(['cards', 'table'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'cards' ? 'Cards' : 'Table'}
            </button>
          ))}
        </div>
      )}
      {/* an empty grid still shows the column names; psql's \x prints nothing but the count */}
      {(!expanded || rows.length > 0) && (
        asCards ? (
          <Cards columns={columns} rows={shown} drawn={drawn} />
        ) : (
          <div className="rdkit-table-wrap">
            {expanded ? <Records columns={columns} rows={shown} /> : <Grid columns={columns} rows={shown} />}
          </div>
        )
      )}
      <div className="rdkit-hint">
        {count(rowCount ?? rows.length, 'row')}
        {rowCount !== undefined && rowCount > rows.length && ` · first ${rows.length.toLocaleString()} kept`}
        {rows.length > limit && (
          <>
            {' · '}
            <button type="button" className="rdkit-more" onClick={() => setLimit(limit + PAGE)}>
              show {Math.min(PAGE, rows.length - limit)} more
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** NOTICE / WARNING / INFO lines Postgres sent while the query ran, as psql prints them */
function Notices({ notices }: { notices?: string[] }) {
  if (!notices?.length) return null
  return (
    <div className="rdkit-notices">
      {notices.map((n, i) => (
        <pre key={i} className={/^WARNING:/.test(n) ? 'rdkit-notice warning' : 'rdkit-notice'}>
          {n}
        </pre>
      ))}
    </div>
  )
}

export function ErrorBox({ error, sql }: { error: RunError; sql?: string }) {
  // point at the offending character the way psql does
  let pointer: string | undefined
  if (sql && error.position) {
    const before = sql.slice(0, error.position - 1)
    const lineStart = before.lastIndexOf('\n') + 1
    const lineEnd = sql.indexOf('\n', lineStart)
    const line = sql.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    pointer = `${line}\n${' '.repeat(before.length - lineStart)}^`
  }
  return (
    <pre className="rdkit-error">
      ERROR: {error.message}
      {pointer && `\n${pointer}`}
      {error.detail && `\nDETAIL: ${error.detail}`}
      {error.hint && `\nHINT: ${error.hint}`}
    </pre>
  )
}

/** A one-line result for screen readers, which shouldn't have whole tables read out */
export function summarizeOutcome(outcome: RunOutcome): string {
  const ms = `${Math.round(outcome.ms)} ms`
  if (!outcome.ok) return `Error: ${outcome.error.message}`
  const tables = outcome.results.filter((r) => r.columns.length > 0)
  if (tables.length === 0) return `Done, ${ms}`
  const rows = tables.map((r) => count(r.rowCount ?? r.rows.length, 'row')).join(', ')
  return `${tables.length > 1 ? `${tables.length} results: ` : ''}${rows}, ${ms}`
}

export default function ResultTable({
  outcome,
  sql,
  expanded = false,
  cards = false,
}: {
  outcome: RunOutcome
  sql?: string
  expanded?: boolean
  /** offer (and default to) cards for results with drawings; the REPL keeps psql's table */
  cards?: boolean
}) {
  if (!outcome.ok) {
    return (
      <>
        <Notices notices={outcome.notices} />
        <ErrorBox error={outcome.error} sql={sql} />
      </>
    )
  }
  const many = outcome.results.length > 1
  return (
    <>
      <Notices notices={outcome.notices} />
      {outcome.text && <pre className="rdkit-text">{outcome.text}</pre>}
      {outcome.results.map((r, i) => (
        <Statement key={i} result={r} label={many ? `Statement ${i + 1}` : undefined} expanded={expanded} cards={cards} />
      ))}
    </>
  )
}
