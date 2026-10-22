import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EXAMPLES } from 'pglite-rdkit/examples'
import SqlEditor from './SqlEditor'
import ResultTable from './ResultTable'
import { track } from '../lib/analytics'
import { resetDb } from '../lib/client'
import { decodeShare, encodeShare } from '../lib/format'
import { changesSchema, runSql, type RunOutcome } from '../lib/run'
import { toNamespace } from '../lib/schema'
import { statusText, useDb } from '../lib/useDb'

/** Reads the query to start with from #<example-id> or #sql=<base64>. */
function initialQuery(): { id?: string; sql: string } {
  const hash = decodeURIComponent(location.hash.slice(1))
  if (hash.startsWith('sql=')) {
    const sql = decodeShare(hash.slice(4))
    if (sql !== undefined) return { sql }
  }
  const example = EXAMPLES.find((e) => e.id === hash) ?? EXAMPLES[0]
  return { id: example.id, sql: example.sql }
}

export default function Playground() {
  const { pg, status, schema, refreshSchema } = useDb('playground')
  const [start] = useState(initialQuery)
  const [activeId, setActiveId] = useState(start.id)
  const [sql, setSql] = useState(start.sql)
  const [outcome, setOutcome] = useState<{ result: RunOutcome; sql: string }>()
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const sqlRef = useRef(sql)
  sqlRef.current = sql
  // which example the next run belongs to; 'custom' once the query is edited
  const exampleRef = useRef<string>(start.id ?? 'shared')

  const run = useCallback(
    async (query = sqlRef.current) => {
      if (!pg) return
      setRunning(true)
      const result = await runSql(pg, query)
      track('playground-run', { example: exampleRef.current, ok: result.ok, ms: Math.round(result.ms) })
      setOutcome({ result, sql: query })
      setRunning(false)
      if (changesSchema(query)) await refreshSchema()
    },
    [pg, refreshSchema],
  )

  // run the starting query as soon as the database is up
  const ranFirst = useRef(false)
  useEffect(() => {
    if (pg && !ranFirst.current) {
      ranFirst.current = true
      run()
    }
  }, [pg, run])

  const pick = (id: string) => {
    const example = EXAMPLES.find((e) => e.id === id)!
    history.replaceState(null, '', `#${id}`)
    exampleRef.current = id
    setActiveId(id)
    setSql(example.sql)
    run(example.sql)
  }

  const share = async () => {
    const url = new URL(location.href)
    url.hash = `sql=${encodeShare(sql)}`
    history.replaceState(null, '', url)
    await navigator.clipboard?.writeText(url.href)
    track('playground-share', { example: exampleRef.current })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const reset = async () => {
    track('playground-reset')
    setRunning(true)
    await resetDb('playground')
    await refreshSchema()
    setRunning(false)
    run()
  }

  const namespace = useMemo(() => toNamespace(schema), [schema])
  const ready = status.state === 'ready'

  return (
    <div className="rdkit-app rdkit-playground not-content">
      <nav className="rdkit-examples" aria-label="Examples">
        <h2>Examples</h2>
        <ul>
          {EXAMPLES.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-current={e.id === activeId ? 'true' : undefined}
                onClick={() => pick(e.id)}
                disabled={!ready}
              >
                {e.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="rdkit-main">
        <SqlEditor
          value={sql}
          onChange={(v) => {
            setSql(v)
            setActiveId(undefined)
            exampleRef.current = 'custom'
          }}
          onRun={(text) => run(text)}
          schema={namespace}
          functions={schema.rdkitFunctions}
          minHeight="10rem"
        />
        <div className="rdkit-toolbar">
          <button type="button" className="rdkit-primary" onClick={() => run()} disabled={!ready || running}>
            {running ? 'Running…' : 'Run'}
          </button>
          <kbd>⌘/Ctrl + Enter</kbd>
          <button type="button" onClick={reset} disabled={!ready || running}>
            Reset data
          </button>
          <button type="button" onClick={share} disabled={!sql}>
            {copied ? 'Link copied' : 'Share'}
          </button>
          <span className={`rdkit-status ${status.state}`}>{statusText(status)}</span>
          {outcome && <span className="rdkit-timing">{outcome.result.ms.toFixed(1)} ms</span>}
        </div>
        <div className="rdkit-results" aria-live="polite">
          {outcome && <ResultTable outcome={outcome.result} sql={outcome.sql} />}
        </div>
      </section>
    </div>
  )
}
