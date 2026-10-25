import { PGliteWorker } from '@electric-sql/pglite/worker'
import { SEED_SQL } from 'pglite-rdkit/examples'

/**
 * playground: in-memory, private to the tab, reseeded on every load
 * repl: kept in IndexedDB, so tables survive reloads and are shared between tabs
 */
export type DbKind = 'playground' | 'repl'

const instances = new Map<DbKind, Promise<PGliteWorker>>()
/** every worker this page started, so pagehide can stop them synchronously */
const live = new Set<PGliteWorker>()

/**
 * Terminates every database worker of this page. Called on pagehide: a page kept in the
 * back/forward cache would otherwise keep its worker and its ~500 MB of wasm memory alive.
 * close() reaches worker.terminate() without awaiting, so this is effectively synchronous.
 */
export function closeAll() {
  instances.clear()
  for (const pg of live) void pg.close()
  live.clear()
}

export function getDb(kind: DbKind): Promise<PGliteWorker> {
  let db = instances.get(kind)
  if (!db) {
    db = open(kind)
    instances.set(kind, db)
    // let a later call retry instead of caching the failure
    db.catch(() => instances.delete(kind))
  }
  return db
}

async function open(kind: DbKind): Promise<PGliteWorker> {
  const pg = new PGliteWorker(
    new Worker(new URL('./pg.worker.ts', import.meta.url), { type: 'module' }),
    kind === 'repl'
      ? { dataDir: 'idb://pglite-rdkit-repl', id: 'pglite-rdkit-repl' }
      : // a memory database must not be shared through leader election with other tabs
        { dataDir: 'memory://', id: `pglite-rdkit-playground-${crypto.randomUUID()}` },
  )
  live.add(pg)
  await pg.waitReady
  await seed(pg)
  return pg
}

/** Creates the extension and, unless it is already there, the sample molecules table. */
async function seed(pg: PGliteWorker) {
  const { rows } = await pg.query<{ seeded: boolean }>(
    `SELECT to_regclass('public.molecules') IS NOT NULL AS seeded`,
  )
  await pg.exec(rows[0].seeded ? 'CREATE EXTENSION IF NOT EXISTS rdkit;' : SEED_SQL)
}

/**
 * Stops whatever the database is doing and opens it again. close() terminates the worker, which
 * also frees its leader-election lock so the new worker can take over the data directory; work
 * already committed to IndexedDB survives, an open transaction is lost.
 */
export async function restartDb(kind: DbKind): Promise<PGliteWorker> {
  const old = instances.get(kind)
  instances.delete(kind)
  await old?.then((pg) => (live.delete(pg), pg.close())).catch(() => {})
  return getDb(kind)
}

/** Drops everything the user created and restores the sample data. */
export async function resetDb(kind: DbKind) {
  const pg = await getDb(kind)
  await pg.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await seed(pg)
}

export async function rdkitVersion(pg: PGliteWorker): Promise<string> {
  const { rows } = await pg.query<{ v: string }>('SELECT rdkit_toolkit_version() AS v')
  return rows[0].v
}
