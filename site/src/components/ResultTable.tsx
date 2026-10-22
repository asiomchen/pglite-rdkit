import { useState } from 'react'
import { MAX_TEXT, count, formatValue, isSvg, svgDataUrl } from '../lib/format'
import type { RunError, RunOutcome, StatementResult } from '../lib/run'

const PAGE = 100

function Cell({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false)
  if (value === null || value === undefined) return <span className="rdkit-null">NULL</span>
  if (isSvg(value)) {
    return <img className="rdkit-mol" src={svgDataUrl(value)} alt="molecule" loading="lazy" />
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
                <Cell value={v} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
                <Cell value={v} />
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
}

function Statement({ result, label, expanded }: StatementProps) {
  const [limit, setLimit] = useState(PAGE)
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
  return (
    <div className="rdkit-result">
      {label && <div className="rdkit-hint">{label}</div>}
      {/* an empty grid still shows the column names; psql's \x prints nothing but the count */}
      {(!expanded || rows.length > 0) && (
        <div className="rdkit-table-wrap">
          {expanded ? <Records columns={columns} rows={shown} /> : <Grid columns={columns} rows={shown} />}
        </div>
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

export default function ResultTable({
  outcome,
  sql,
  expanded = false,
}: {
  outcome: RunOutcome
  sql?: string
  expanded?: boolean
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
        <Statement key={i} result={r} label={many ? `Statement ${i + 1}` : undefined} expanded={expanded} />
      ))}
    </>
  )
}
