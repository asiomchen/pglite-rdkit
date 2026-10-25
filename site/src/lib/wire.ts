import type { PGliteWorker } from '@electric-sql/pglite/worker'

/*
 * A minimal reader for the Postgres wire protocol, used instead of pg.exec() for user SQL.
 * PGliteWorker drops most of what a psql-like REPL needs on its way out of the worker: errors
 * cross the worker boundary as bare `new Error(message)` (no position/detail/hint), onNotice
 * callbacks can't be posted to the worker, the ReadyForQuery transaction status isn't exposed,
 * and COPY ... TO STDOUT data is discarded. execProtocolRaw() returns the backend's bytes
 * untouched, so we read all of that here.
 */

/** Postgres error/notice fields keyed by their protocol code (S severity, M message, P position, ...) */
export type PgFields = Record<string, string>

export interface RawStatement {
  fields: { name: string; dataTypeID: number }[]
  /** text values, cut to maxRows */
  rows: (string | null)[][]
  /** number of DataRows actually received */
  rowCount: number
  /** command tag, e.g. "SELECT 3" or "CREATE TABLE" */
  tag: string
}

export interface RawResult {
  statements: RawStatement[]
  error?: PgFields
  notices: PgFields[]
  /** COPY ... TO STDOUT data, one chunk per row, cut to maxRows */
  copy: string[]
  copyRows: number
  /** ReadyForQuery status: I idle, T in a transaction, E in a failed transaction */
  status?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function stringMessage(type: number, text: string): Uint8Array {
  const bytes = encoder.encode(text)
  const msg = new Uint8Array(bytes.length + 6)
  msg[0] = type
  new DataView(msg.buffer).setInt32(1, bytes.length + 5)
  msg.set(bytes, 5)
  return msg
}

function queryMessage(sql: string): Uint8Array {
  const query = stringMessage(0x51, sql) // Q: Query
  const msg = new Uint8Array(query.length + COPY_FAIL.length)
  msg.set(query)
  msg.set(COPY_FAIL, query.length)
  return msg
}

// PGlite runs synchronously until the supplied protocol input is exhausted. Queue a
// CopyFail with every query so COPY FROM STDIN cannot run out of input and kill the
// session. PostgreSQL ignores it outside copy-in mode; otherwise it aborts COPY and
// skips the remaining statements, returning the usual error and transaction status.
// https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-COPY
const COPY_FAIL = stringMessage(
  0x66, // f: CopyFail
  'COPY FROM STDIN is not supported in the browser REPL. Use INSERT ... VALUES to add rows.',
)
const SYNC = new Uint8Array([0x53, 0, 0, 0, 4]) // S: Sync

/** Runs `sql` with the simple query protocol, like psql does, and decodes the reply. */
export async function simpleQuery(pg: PGliteWorker, sql: string, maxRows: number): Promise<RawResult> {
  const data = await pg.runExclusive(async () => {
    const reply = await pg.execProtocolRaw(queryMessage(sql))
    // the worker still parses raw replies into a query buffer that is only dropped by the
    // next wrapped call; a Sync (a no-op after a simple query) frees it now, not after a 1M-row SELECT lingers
    await pg.execProtocolStream(SYNC)
    return reply
  })
  return decode(data, maxRows)
}

export function decode(data: Uint8Array, maxRows: number): RawResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: RawResult = { statements: [], notices: [], copy: [], copyRows: 0 }
  let current: RawStatement = { fields: [], rows: [], rowCount: 0, tag: '' }
  let pos = 0
  while (pos + 5 <= data.length) {
    const type = data[pos]
    const end = pos + 1 + view.getInt32(pos + 1)
    let at = pos + 5
    const cstring = () => {
      const zero = data.indexOf(0, at)
      const s = decoder.decode(data.subarray(at, zero))
      at = zero + 1
      return s
    }
    switch (type) {
      case 0x54: {
        // T: RowDescription
        const n = view.getInt16(at)
        at += 2
        for (let i = 0; i < n; i++) {
          const name = cstring()
          current.fields.push({ name, dataTypeID: view.getInt32(at + 6) })
          at += 18
        }
        break
      }
      case 0x44: {
        // D: DataRow; only decode the rows we keep
        if (current.rowCount++ >= maxRows) break
        const n = view.getInt16(at)
        at += 2
        const row: (string | null)[] = []
        for (let i = 0; i < n; i++) {
          const len = view.getInt32(at)
          at += 4
          if (len < 0) row.push(null)
          else {
            row.push(decoder.decode(data.subarray(at, at + len)))
            at += len
          }
        }
        current.rows.push(row)
        break
      }
      case 0x43: // C: CommandComplete
      case 0x49: // I: EmptyQueryResponse
        current.tag = type === 0x43 ? cstring() : ''
        out.statements.push(current)
        current = { fields: [], rows: [], rowCount: 0, tag: '' }
        break
      case 0x45: // E: ErrorResponse
      case 0x4e: {
        // N: NoticeResponse
        const fields: PgFields = {}
        while (data[at] !== 0 && at < end) {
          const code = String.fromCharCode(data[at++])
          fields[code] = cstring()
        }
        if (type === 0x4e) out.notices.push(fields)
        else out.error ??= fields
        break
      }
      case 0x64: // d: CopyData
        if (out.copyRows++ < maxRows) out.copy.push(decoder.decode(data.subarray(at, end)))
        break
      case 0x5a: // Z: ReadyForQuery
        out.status = String.fromCharCode(data[at])
        break
    }
    pos = end
  }
  return out
}
