import { useState } from 'react'
import { MAX_TEXT, formatValue, isSvg, svgDataUrl } from '../lib/format'
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

function Statement({ result, label }: { result: StatementResult; label?: string }) {
  const [limit, setLimit] = useState(PAGE)
  if (result.columns.length === 0) {
    return (
      <div className="rdkit-result">
        {label && <div className="rdkit-hint">{label}</div>}
        <p className="rdkit-hint">
          {result.affectedRows ? `${result.affectedRows} row(s) affected` : 'OK'}
        </p>
      </div>
    )
  }
  return (
    <div className="rdkit-result">
      {label && <div className="rdkit-hint">{label}</div>}
      <div className="rdkit-table-wrap">
        <table>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, limit).map((row, r) => (
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
      </div>
      <div className="rdkit-hint">
        {result.rows.length} row(s)
        {result.rows.length > limit && (
          <>
            {' · '}
            <button type="button" className="rdkit-more" onClick={() => setLimit(limit + PAGE)}>
              show {Math.min(PAGE, result.rows.length - limit)} more
            </button>
          </>
        )}
      </div>
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

export default function ResultTable({ outcome, sql }: { outcome: RunOutcome; sql?: string }) {
  if (!outcome.ok) return <ErrorBox error={outcome.error} sql={sql} />
  const many = outcome.results.length > 1
  return (
    <>
      {outcome.text && <pre className="rdkit-text">{outcome.text}</pre>}
      {outcome.results.map((r, i) => (
        <Statement key={i} result={r} label={many ? `Statement ${i + 1}` : undefined} />
      ))}
    </>
  )
}
