import type { PGliteWorker } from '@electric-sql/pglite/worker'
import type { SQLNamespace } from '@codemirror/lang-sql'

export interface Column {
  name: string
  type: string
}

export interface Table {
  schema: string
  name: string
  columns: Column[]
  indexes: { name: string; def: string }[]
}

export interface SchemaInfo {
  tables: Table[]
  /** functions installed by CREATE EXTENSION rdkit, for autocomplete */
  rdkitFunctions: string[]
}

export async function loadSchema(pg: PGliteWorker): Promise<SchemaInfo> {
  const [columns, indexes, functions] = await Promise.all([
    pg.query<{ table_schema: string; table_name: string; column_name: string; type: string }>(`
      SELECT c.table_schema, c.table_name, c.column_name,
             CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS type
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND t.table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`),
    pg.query<{ schemaname: string; tablename: string; indexname: string; indexdef: string }>(`
      SELECT schemaname, tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY indexname`),
    pg.query<{ proname: string }>(`
      SELECT DISTINCT p.proname
      FROM pg_proc p
      JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      JOIN pg_extension e ON e.oid = d.refobjid
      WHERE e.extname = 'rdkit'
      ORDER BY p.proname`),
  ])

  const tables = new Map<string, Table>()
  for (const c of columns.rows) {
    const key = `${c.table_schema}.${c.table_name}`
    let table = tables.get(key)
    if (!table) {
      table = { schema: c.table_schema, name: c.table_name, columns: [], indexes: [] }
      tables.set(key, table)
    }
    table.columns.push({ name: c.column_name, type: c.type })
  }
  for (const i of indexes.rows) {
    tables.get(`${i.schemaname}.${i.tablename}`)?.indexes.push({ name: i.indexname, def: i.indexdef })
  }

  return { tables: [...tables.values()], rdkitFunctions: functions.rows.map((r) => r.proname) }
}

/** The shape @codemirror/lang-sql wants: public tables unqualified, others as schema.table. */
export function toNamespace(info: SchemaInfo): SQLNamespace {
  const ns: Record<string, string[]> = {}
  for (const t of info.tables) {
    ns[t.schema === 'public' ? t.name : `${t.schema}.${t.name}`] = t.columns.map((c) => c.name)
  }
  return ns
}
