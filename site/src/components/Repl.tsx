import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SqlEditor from './SqlEditor'
import ResultTable from './ResultTable'
import SchemaPanel from './SchemaPanel'
import { resetDb } from '../lib/client'
import { changesSchema, isDescribe, runDescribe, runSql, type RunOutcome } from '../lib/run'
import { toNamespace } from '../lib/schema'
import { statusText, useDb } from '../lib/useDb'

const HISTORY_KEY = 'pglite-rdkit-repl-history'
const HISTORY_MAX = 100

interface Entry {
  id: number
  sql: string
  outcome: RunOutcome
}

// history is a per-viewer convenience: an unavailable localStorage just means no history
function loadHistory(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)))
  } catch {
    // ignore
  }
}

export default function Repl() {
  const { pg, status, schema, refreshSchema } = useDb('repl')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [running, setRunning] = useState(false)
  const history = useRef<string[]>(loadHistory())
  // position while browsing history; history.length means "the line being typed"
  const cursor = useRef(history.current.length)
  const draft = useRef('')
  const nextId = useRef(0)
  const outputEnd = useRef<HTMLDivElement>(null)
  const inputRef = useRef(input)
  inputRef.current = input

  const execute = useCallback(
    async (query: string) => {
      if (!pg || !query.trim()) return
      setRunning(true)
      const outcome = isDescribe(query) ? await runDescribe(pg, query) : await runSql(pg, query)
      setEntries((list) => [...list, { id: nextId.current++, sql: query, outcome }])
      setRunning(false)
      if (history.current.at(-1) !== query) {
        history.current = [...history.current, query].slice(-HISTORY_MAX)
        saveHistory(history.current)
      }
      cursor.current = history.current.length
      if (changesSchema(query)) await refreshSchema()
    },
    [pg, refreshSchema],
  )

  const browse = useCallback((direction: -1 | 1) => {
    const list = history.current
    const next = cursor.current + direction
    if (next < 0 || next > list.length) return undefined
    if (cursor.current === list.length) draft.current = inputRef.current
    cursor.current = next
    return next === list.length ? draft.current : list[next]
  }, [])

  useEffect(() => {
    outputEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [entries])

  const reset = async () => {
    if (!confirm('Drop every table in the REPL database and restore the sample data?')) return
    setRunning(true)
    await resetDb('repl')
    await refreshSchema()
    setEntries([])
    setRunning(false)
  }

  const namespace = useMemo(() => toNamespace(schema), [schema])
  const ready = status.state === 'ready'

  return (
    <div className="rdkit-app rdkit-repl not-content">
      <section className="rdkit-main">
        <div className="rdkit-toolbar">
          <span className={`rdkit-status ${status.state}`}>{statusText(status)}</span>
          <span className="rdkit-hint">
            Saved in this browser · Enter runs · Shift+Enter for a new line · ↑/↓ history
          </span>
          <button type="button" onClick={() => setEntries([])} disabled={entries.length === 0}>
            Clear output
          </button>
          <button type="button" onClick={reset} disabled={!ready || running}>
            Reset database
          </button>
        </div>
        <div className="rdkit-output" aria-live="polite">
          {entries.length === 0 && ready && (
            <p className="rdkit-hint">
              The <code>molecules</code> table is ready. Try{' '}
              <code>SELECT name, mol_to_svg(m) FROM molecules WHERE m @&gt; 'c1ccccc1O';</code>
            </p>
          )}
          {entries.map((e) => (
            <div key={e.id} className="rdkit-entry">
              <pre className="rdkit-input-echo">
                <span aria-hidden="true">rdkit=# </span>
                {e.sql}
              </pre>
              <ResultTable outcome={e.outcome} sql={e.sql} />
              <div className="rdkit-timing">{e.outcome.ms.toFixed(1)} ms</div>
            </div>
          ))}
          <div ref={outputEnd} />
        </div>
        <div className="rdkit-prompt">
          <span aria-hidden="true">rdkit=#</span>
          <SqlEditor
            value={input}
            onChange={setInput}
            onRun={(query) => !running && execute(query)}
            onHistory={browse}
            enterRuns
            schema={namespace}
            functions={schema.rdkitFunctions}
            autoFocus
          />
        </div>
      </section>
      <SchemaPanel schema={schema} onPick={(sql) => execute(sql)} />
    </div>
  )
}
