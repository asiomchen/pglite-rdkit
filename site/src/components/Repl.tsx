import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SqlEditor from './SqlEditor'
import ResultTable from './ResultTable'
import SchemaPanel from './SchemaPanel'
import { track, trackVisibleTime } from '../lib/analytics'
import { resetDb } from '../lib/client'
import {
  changesSchema,
  isDescribe,
  runDescribe,
  runSql,
  type RunOutcome,
  type TxStatus,
} from '../lib/run'
import { toNamespace } from '../lib/schema'
import { statusText, useDb } from '../lib/useDb'

const HISTORY_KEY = 'pglite-rdkit-repl-history'
const HISTORY_MAX = 100
const SETTINGS_KEY = 'pglite-rdkit-repl-settings'

// psql's prompt: * inside a transaction, ! once it has failed
const PROMPTS: Record<TxStatus, string> = {
  idle: 'rdkit=#',
  transaction: 'rdkit=*#',
  failed: 'rdkit=!#',
}

/** \x and \timing, as psql has them */
interface Settings {
  expanded: boolean
  timing: boolean
}

interface Entry {
  id: number
  sql: string
  /** the prompt as it was when the command was submitted */
  prompt: string
  /** settings at submit time, so \x and \timing only affect later results, like psql */
  settings: Settings
  outcome?: RunOutcome
  /** plain output: meta-commands and cancellation */
  note?: string
}

type Pending = Omit<Entry, 'outcome' | 'note'> & { started: number }

// history and settings are per-viewer conveniences: an unavailable localStorage just means none
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

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return { expanded: stored?.expanded === true, timing: stored?.timing !== false }
  } catch {
    return { expanded: false, timing: true }
  }
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // ignore
  }
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since)
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 100)
    return () => clearInterval(timer)
  }, [])
  // hidden from screen readers: a ticking number inside an aria-live region is noise
  return <span aria-hidden="true">{((now - since) / 1000).toFixed(1)} s</span>
}

export default function Repl() {
  const { pg, status, schema, refreshSchema, restart } = useDb('repl')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  // resetting or restarting the database
  const [working, setWorking] = useState(false)
  const [tx, setTx] = useState<TxStatus>('idle')
  const [settings, setSettings] = useState(loadSettings)
  const running = pending !== null || working
  // set synchronously, so two quick Enters can't both start before React re-renders
  const busy = useRef(false)
  // bumped by cancel: a run whose token is stale was cancelled and must not add an entry
  const runToken = useRef(0)
  const history = useRef<string[]>(loadHistory())
  // position while browsing history; history.length means "the line being typed"
  const cursor = useRef(history.current.length)
  const draft = useRef('')
  const nextId = useRef(0)
  const outputEnd = useRef<HTMLDivElement>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  // queries run during the current visible stretch, reported with repl-time
  const queries = useRef(0)

  useEffect(
    () =>
      trackVisibleTime('repl-time', () => {
        const count = queries.current
        queries.current = 0
        return { queries: count }
      }),
    [],
  )

  // another tab may have changed the shared database while this one was hidden
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !busy.current) refreshSchema().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refreshSchema])

  const remember = (query: string) => {
    // moving a repeat to the end keeps ↑ from walking through the same command again
    history.current = [...history.current.filter((h) => h !== query), query].slice(-HISTORY_MAX)
    saveHistory(history.current)
    cursor.current = history.current.length
  }

  /** \x, \timing and \q are psql's own, not describe commands; returns their output */
  const runMeta = (command: string): string | undefined => {
    const match = /^\\(x|timing|q)(?:\s+(on|off|auto))?$/.exec(command)
    if (!match) return undefined
    const [, name, arg] = match
    if (name === 'q') return 'This REPL runs in your browser — close the tab to quit.'
    const key = name === 'x' ? 'expanded' : 'timing'
    // auto would pick per result in psql; on is the closer fit for a wide browser table
    const next = { ...settings, [key]: arg ? arg !== 'off' : !settings[key] }
    setSettings(next)
    saveSettings(next)
    return `${name === 'x' ? 'Expanded display' : 'Timing'} is ${next[key] ? 'on' : 'off'}.`
  }

  const execute = async (query: string) => {
    if (!pg) return
    const token = ++runToken.current
    busy.current = true
    const base = { id: nextId.current++, sql: query, prompt: PROMPTS[tx], settings }
    setPending({ ...base, started: performance.now() })
    const describe = isDescribe(query)
    const started = performance.now()
    let outcome: RunOutcome
    try {
      outcome = describe ? await runDescribe(pg, query) : await runSql(pg, query)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      outcome = { ok: false, error: { message }, ms: performance.now() - started }
    }
    // cancelled meanwhile: cancel has written the entry and restarted the database
    if (token !== runToken.current) return
    queries.current++
    track('repl-run', { ok: outcome.ok, describe, ms: Math.round(outcome.ms) })
    if (outcome.txStatus) setTx(outcome.txStatus)
    setEntries((list) => [...list, { ...base, outcome }])
    setPending(null)
    busy.current = false
    if (changesSchema(query)) await refreshSchema()
  }

  /** Returns whether the command was taken; if not, the editor keeps it. */
  const submit = (query: string): boolean => {
    if (busy.current || !pg) return false
    const command = query.trim()
    if (!command) return true
    remember(query)
    const note = runMeta(command)
    if (note === undefined) {
      execute(query)
    } else {
      const entry = { id: nextId.current++, sql: query, prompt: PROMPTS[tx], settings, note }
      setEntries((list) => [...list, entry])
    }
    return true
  }

  // the only way to stop a query in a wasm Postgres is to kill its worker
  const cancel = async () => {
    if (!pending) return
    track('repl-cancel')
    runToken.current++
    const { started, ...base } = pending
    const note = 'Cancelled — the database was restarted. Uncommitted changes were lost.'
    setEntries((list) => [...list, { ...base, note }])
    setPending(null)
    setTx('idle')
    setWorking(true)
    await restart()
    setWorking(false)
    busy.current = false
  }

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
  }, [entries, pending])

  const reset = async () => {
    if (!pg || !confirm('Drop every table in the REPL database and restore the sample data?')) return
    track('repl-reset')
    busy.current = true
    setWorking(true)
    try {
      // inside an open transaction the reset would be rolled back with it, or fail outright;
      // with none open this is only a warning
      await pg.exec('ROLLBACK')
      await resetDb('repl')
      setTx('idle')
      await refreshSchema()
      setEntries([])
    } finally {
      setWorking(false)
      busy.current = false
    }
  }

  const namespace = useMemo(() => toNamespace(schema), [schema])
  const ready = status.state === 'ready'
  const prompt = PROMPTS[tx]

  return (
    <div className="rdkit-app rdkit-repl not-content">
      <section className="rdkit-main">
        <div className="rdkit-toolbar">
          <span className={`rdkit-status ${status.state}`}>
            {pending && ready ? 'Running…' : statusText(status)}
          </span>
          <span className="rdkit-hint">
            Saved in this browser · Enter runs · Shift+Enter for a new line · ↑/↓ history ·
            Ctrl+C cancels
          </span>
          <button type="button" onClick={() => setEntries([])} disabled={entries.length === 0}>
            Clear output
          </button>
          <button type="button" onClick={reset} disabled={!ready || running}>
            Reset database
          </button>
        </div>
        <div className="rdkit-output" aria-live="polite">
          {entries.length === 0 && !pending && ready && (
            <p className="rdkit-hint">
              The <code>molecules</code> table is ready. Try{' '}
              <code>SELECT name, mol_to_svg(m) FROM molecules WHERE m @&gt; 'c1ccccc1O';</code>
            </p>
          )}
          {entries.map((e) => (
            <div key={e.id} className="rdkit-entry">
              <pre className="rdkit-input-echo">
                <span aria-hidden="true">{e.prompt} </span>
                {e.sql}
              </pre>
              {e.note !== undefined && <p className="rdkit-hint rdkit-note">{e.note}</p>}
              {e.outcome && (
                <>
                  <ResultTable outcome={e.outcome} sql={e.sql} expanded={e.settings.expanded} />
                  {e.settings.timing && (
                    <div className="rdkit-timing">{e.outcome.ms.toFixed(1)} ms</div>
                  )}
                </>
              )}
            </div>
          ))}
          {pending && (
            <div className="rdkit-entry rdkit-pending">
              <pre className="rdkit-input-echo">
                <span aria-hidden="true">{pending.prompt} </span>
                {pending.sql}
              </pre>
              <div className="rdkit-running">
                <span className="rdkit-hint">
                  Running… <Elapsed since={pending.started} />
                </span>
                <button
                  type="button"
                  onClick={cancel}
                  title="Stop the query by restarting the database (Ctrl+C)"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div ref={outputEnd} />
        </div>
        <div className="rdkit-prompt">
          <span aria-hidden="true">{prompt}</span>
          <SqlEditor
            value={input}
            onChange={setInput}
            onRun={submit}
            onCancel={() => {
              if (!pending) return false
              cancel()
              return true
            }}
            onHistory={browse}
            enterRuns
            schema={namespace}
            functions={schema.rdkitFunctions}
            autoFocus
          />
        </div>
      </section>
      <SchemaPanel
        schema={schema}
        onPick={(sql) => {
          if (busy.current) return
          track('repl-schema-pick')
          submit(sql)
        }}
      />
    </div>
  )
}
