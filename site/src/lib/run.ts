import type { PGliteWorker } from '@electric-sql/pglite/worker'
import { describe, describeDataToString } from 'psql-describe'
import { simpleQuery, type PgFields, type RawResult } from './wire'

export interface StatementResult {
  columns: string[]
  /** arrays, not objects, so duplicate column names (two `?column?`) both survive */
  rows: unknown[][]
  affectedRows?: number
  /** total row count when `rows` was cut to MAX_ROWS; undefined when rows is complete */
  rowCount?: number
}

export interface RunError {
  message: string
  detail?: string
  hint?: string
  /** 1-based character offset into the query, as Postgres reports it */
  position?: number
}

export type TxStatus = 'idle' | 'transaction' | 'failed'

export type RunOutcome =
  | { ok: true; results: StatementResult[]; ms: number; text?: string; notices?: string[]; txStatus?: TxStatus }
  | { ok: false; error: RunError; ms: number; notices?: string[]; txStatus?: TxStatus }

/** Rows kept per statement; the table pages through 100 at a time, and a 1M-row result would pin hundreds of MB */
export const MAX_ROWS = 1000

const TX_STATUS: Record<string, TxStatus> = { I: 'idle', T: 'transaction', E: 'failed' }

// PGlite has no way to feed COPY data to the backend, which then exits and takes the database down with it
const COPY_FROM_STDIN = /\bcopy\b[^;]*\bfrom\s+stdin\b/i

/** Runs one or more statements and returns one result per statement that produced rows. */
export async function runSql(pg: PGliteWorker, sql: string): Promise<RunOutcome> {
  const started = performance.now()
  if (COPY_FROM_STDIN.test(sql)) {
    return {
      ok: false,
      error: {
        message: 'COPY FROM STDIN is not supported in the browser REPL',
        hint: 'Use INSERT ... VALUES to add rows.',
      },
      ms: performance.now() - started,
    }
  }
  let raw: RawResult
  try {
    raw = await simpleQuery(pg, sql, MAX_ROWS)
  } catch (e) {
    // the worker itself failed, not the SQL
    return { ok: false, error: { message: e instanceof Error ? e.message : String(e) }, ms: performance.now() - started }
  }
  const ms = performance.now() - started
  const notices = raw.notices.length > 0 ? raw.notices.map(formatNotice) : undefined
  const txStatus = raw.status ? TX_STATUS[raw.status] : undefined
  if (raw.error) return { ok: false, error: toRunError(raw.error), ms, notices, txStatus }

  const all: StatementResult[] = raw.statements.map((s) => {
    const result: StatementResult = {
      columns: s.fields.map((f) => f.name),
      rows: s.rows.map((row) => row.map((v, i) => parseValue(pg, v, s.fields[i].dataTypeID))),
    }
    if (s.rowCount > s.rows.length) result.rowCount = s.rowCount
    // "INSERT 0 5", "UPDATE 3", "SELECT 2" from CREATE TABLE AS; "CREATE TABLE" has no count
    const count = / (\d+)$/.exec(s.tag)
    if (s.fields.length === 0 && count) result.affectedRows = Number(count[1])
    return result
  })
  // SET / CREATE results are noise next to a SELECT
  const shown = all.filter((r) => r.columns.length > 0)
  if (raw.copyRows > 0) {
    // COPY ... TO STDOUT: print the data like psql; its "n row(s) affected" would only repeat it
    const more = raw.copyRows - raw.copy.length
    const text = raw.copy.join('').replace(/\n$/, '') + (more > 0 ? `\n… ${more} more row(s) not shown` : '')
    return { ok: true, results: shown, text, ms, notices, txStatus }
  }
  // keep the last result if nothing returned rows; an empty query (only comments) still gets an "OK"
  const results = shown.length > 0 ? shown : all.length > 0 ? all.slice(-1) : [{ columns: [], rows: [] }]
  return { ok: true, results, ms, notices, txStatus }
}

function parseValue(pg: PGliteWorker, value: string | null, type: number): unknown {
  if (value === null) return null
  const parse = pg.parsers[type]
  return parse ? parse(value, type) : value
}

function toRunError(f: PgFields): RunError {
  return {
    message: f.M ?? 'Unknown error',
    detail: f.D,
    hint: f.H,
    position: f.P ? Number(f.P) : undefined,
  }
}

/** psql's layout: "NOTICE:  text", then DETAIL/HINT lines */
function formatNotice(f: PgFields): string {
  let line = `${f.S ?? f.V ?? 'NOTICE'}:  ${f.M ?? ''}`
  if (f.D) line += `\nDETAIL:  ${f.D}`
  if (f.H) line += `\nHINT:  ${f.H}`
  return line
}

type DescribeTable = { title?: string; headers: string[]; cells: string[]; ncolumns: number; footers?: string[] | null }

/** psql's \d family (\dt, \d molecules, \df mol_*), ported to JS by psql-describe. */
export async function runDescribe(pg: PGliteWorker, command: string): Promise<RunOutcome> {
  const started = performance.now()
  const items: (string | DescribeTable)[] = []
  let status: string | undefined
  const { promise } = describe(
    command,
    'postgres',
    async (query: string) => {
      // psql-describe wants unparsed text values (it compares booleans to 't'), which the raw protocol gives us
      const raw = await simpleQuery(pg, query, Infinity)
      status = raw.status
      // psql-describe catches this and reports it as an "ERROR:" item
      if (raw.error) throw new Error(raw.error.M)
      const s = raw.statements[0]
      return { rows: s.rows, fields: s.fields, rowCount: s.rows.length }
    },
    (item: string | Record<string, unknown>) => {
      items.push(item as string | DescribeTable)
    },
  )
  await promise
  const ms = performance.now() - started
  const txStatus = status ? TX_STATUS[status] : undefined
  const error = items.find((i): i is string => typeof i === 'string' && i.startsWith('ERROR:'))
  if (error) return { ok: false, error: { message: error.replace(/^ERROR:\s*/, '') }, ms, txStatus }
  if (items.length === 0) return { ok: false, error: { message: 'No output' }, ms, txStatus }

  const tables = items.filter((i): i is DescribeTable => typeof i !== 'string')
  // several tables (\d with a pattern matching many relations) would lose which title and footers
  // belong to which table, so print them the way psql does
  if (tables.length > 1) {
    return { ok: true, results: [], text: items.map((i) => describeDataToString(i)).join('\n\n'), ms, txStatus }
  }
  // one table: its title and footers (indexes, constraints, ...) go to the text block, the rows to a result
  const text = items
    .flatMap((i) => (typeof i === 'string' ? [i] : [i.title ?? '', ...(i.footers ?? [])]))
    .filter(Boolean)
    .join('\n')
  const results = tables.map((t) => ({
    columns: t.headers,
    rows: Array.from({ length: t.cells.length / t.ncolumns }, (_, r) => t.cells.slice(r * t.ncolumns, (r + 1) * t.ncolumns)),
  }))
  return { ok: true, results, text: text || undefined, ms, txStatus }
}

export const isDescribe = (input: string) => input.trimStart().startsWith('\\')

/** Statements that can change the schema panel and autocomplete. */
export const changesSchema = (sql: string) => /\b(create|drop|alter|truncate)\b/i.test(sql)
