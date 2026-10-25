import { useCallback, useEffect, useRef, useState } from 'react'
import { EXAMPLES } from 'pglite-rdkit/examples'
import SqlEditor from './SqlEditor'
import ResultTable from './ResultTable'
import { track } from '../lib/analytics'
import { runSql, type RunOutcome } from '../lib/run'
import { statusText, useDb } from '../lib/useDb'

const FIRST_QUERY = EXAMPLES.find((e) => e.id === 'substructure')!.sql

/** A small editor for the landing page. Nothing loads until the visitor asks for it. */
export default function LiveDemo() {
  const [started, setStarted] = useState(false)
  const { pg, status } = useDb('playground', started)
  const [sql, setSql] = useState(FIRST_QUERY)
  const [outcome, setOutcome] = useState<RunOutcome>()
  const sqlRef = useRef(sql)
  sqlRef.current = sql

  const run = useCallback(
    async (query = sqlRef.current) => {
      if (!pg) return
      const result = await runSql(pg, query)
      track('demo-run', { ok: result.ok, ms: Math.round(result.ms) })
      setOutcome(result)
    },
    [pg],
  )

  useEffect(() => {
    if (pg) run()
  }, [pg, run])

  return (
    <div className="rdkit-demo not-content">
      <SqlEditor value={sql} onChange={setSql} onRun={(text) => run(text)} minHeight="6rem" />
      <div className="rdkit-toolbar">
        {started ? (
          <>
            <button type="button" className="rdkit-primary" onClick={() => run()} disabled={!pg}>
              Run
            </button>
            <span className={`rdkit-status ${status.state}`}>{statusText(status)}</span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="rdkit-primary"
              onClick={() => {
                track('demo-start')
                setStarted(true)
              }}
            >
              Start Postgres + RDKit
            </button>
            <span className="rdkit-hint">Downloads about 11 MB of WebAssembly, then runs in your browser.</span>
          </>
        )}
      </div>
      {outcome && (
        <div className="rdkit-results">
          <ResultTable outcome={outcome} sql={sql} cards />
        </div>
      )}
    </div>
  )
}
