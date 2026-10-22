import { useCallback, useEffect, useState } from 'react'
import type { PGliteWorker } from '@electric-sql/pglite/worker'
import { getDb, rdkitVersion, restartDb, type DbKind } from './client'
import { loadSchema, type SchemaInfo } from './schema'
import { track } from './analytics'

export type DbStatus =
  | { state: 'loading' }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

async function connect(db: PGliteWorker) {
  const [version, info] = await Promise.all([rdkitVersion(db), loadSchema(db)])
  return { version, info }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Opens the shared database on mount (or when `enabled` turns true) and tracks its schema. */
export function useDb(kind: DbKind, enabled = true) {
  const [pg, setPg] = useState<PGliteWorker>()
  const [status, setStatus] = useState<DbStatus>({ state: 'loading' })
  const [schema, setSchema] = useState<SchemaInfo>({ tables: [], rdkitFunctions: [] })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const started = performance.now()
    getDb(kind)
      .then(async (db) => {
        const { version, info } = await connect(db)
        if (cancelled) return
        setPg(db)
        setSchema(info)
        setStatus({ state: 'ready', version })
        track('db-ready', { db: kind, ms: Math.round(performance.now() - started) })
      })
      .catch((e) => {
        const message = errorMessage(e)
        track('db-error', { db: kind, message })
        if (!cancelled) setStatus({ state: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [kind, enabled])

  const refreshSchema = useCallback(async () => {
    if (pg) setSchema(await loadSchema(pg))
  }, [pg])

  /** Kills a runaway query: the old instance is dropped and `pg` becomes a fresh one. */
  const restart = useCallback(async () => {
    setPg(undefined)
    setStatus({ state: 'loading' })
    try {
      const db = await restartDb(kind)
      const { version, info } = await connect(db)
      setPg(db)
      setSchema(info)
      setStatus({ state: 'ready', version })
    } catch (e) {
      setStatus({ state: 'error', message: errorMessage(e) })
    }
  }, [kind])

  return { pg, status, schema, refreshSchema, restart }
}

export function statusText(status: DbStatus): string {
  if (status.state === 'loading') return 'Loading Postgres and RDKit…'
  if (status.state === 'error') return `Failed to start: ${status.message}`
  return `Ready · RDKit ${status.version}`
}
