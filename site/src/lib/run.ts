import type { PGliteWorker } from '@electric-sql/pglite/worker'
import { describe } from 'psql-describe'

export interface StatementResult {
  columns: string[]
  /** arrays, not objects, so duplicate column names (two `?column?`) both survive */
  rows: unknown[][]
  affectedRows?: number
}

export interface RunError {
  message: string
  detail?: string
  hint?: string
  /** 1-based character offset into the query, as Postgres reports it */
  position?: number
}

export type RunOutcome =
  | { ok: true; results: StatementResult[]; ms: number; text?: string }
  | { ok: false; error: RunError; ms: number }

/** Runs one or more statements and returns one result per statement that produced rows. */
export async function runSql(pg: PGliteWorker, sql: string): Promise<RunOutcome> {
  const started = performance.now()
  try {
    const res = await pg.exec(sql, { rowMode: 'array' })
    const all = res.map((r) => ({
      columns: r.fields.map((f) => f.name),
      rows: r.rows as unknown[][],
      affectedRows: r.affectedRows,
    }))
    // SET / CREATE results are noise next to a SELECT; keep the last one if nothing returned rows
    const shown = all.filter((r) => r.columns.length > 0)
    return { ok: true, results: shown.length > 0 ? shown : all.slice(-1), ms: performance.now() - started }
  } catch (e) {
    return { ok: false, error: toRunError(e), ms: performance.now() - started }
  }
}

function toRunError(e: unknown): RunError {
  if (!(e instanceof Error)) return { message: String(e) }
  const { detail, hint, position } = e as Error & Record<string, unknown>
  return {
    message: e.message,
    detail: typeof detail === 'string' ? detail : undefined,
    hint: typeof hint === 'string' ? hint : undefined,
    position: position ? Number(position) : undefined,
  }
}

/** psql's \d family (\dt, \d molecules, \df mol_*), ported to JS by psql-describe. */
export async function runDescribe(pg: PGliteWorker, command: string): Promise<RunOutcome> {
  const started = performance.now()
  let output: string | Record<string, unknown> | undefined
  let last: StatementResult | undefined
  const { promise } = describe(
    command,
    'postgres',
    async (query: string) => {
      const res = (await pg.exec(query, { rowMode: 'array' }))[0]
      last = { columns: res.fields.map((f) => f.name), rows: res.rows as unknown[][] }
      return { rows: res.rows, fields: res.fields, rowCount: res.rows.length }
    },
    (out: string | Record<string, unknown>) => {
      output = out
    },
  )
  await promise
  const ms = performance.now() - started
  if (typeof output === 'string') {
    return output.startsWith('ERROR:')
      ? { ok: false, error: { message: output.replace(/^ERROR:\s*/, '') }, ms }
      : { ok: true, results: [], text: output, ms }
  }
  if (!output || !last) return { ok: false, error: { message: 'No output' }, ms }
  return { ok: true, results: [last], text: String(output.title ?? ''), ms }
}

export const isDescribe = (input: string) => input.trimStart().startsWith('\\')

/** Statements that can change the schema panel and autocomplete. */
export const changesSchema = (sql: string) => /\b(create|drop|alter|truncate)\b/i.test(sql)
