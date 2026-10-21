import type { SchemaInfo } from '../lib/schema'

interface Props {
  schema: SchemaInfo
  /** called with a ready-to-run query when a table name is clicked */
  onPick: (sql: string) => void
}

export default function SchemaPanel({ schema, onPick }: Props) {
  return (
    <aside className="rdkit-schema" aria-label="Schema">
      <h2>Tables</h2>
      {schema.tables.length === 0 && <p className="rdkit-hint">No tables yet.</p>}
      {schema.tables.map((t) => {
        const name = t.schema === 'public' ? t.name : `${t.schema}.${t.name}`
        return (
          <details key={`${t.schema}.${t.name}`} open={schema.tables.length <= 3}>
            <summary>
              <button
                type="button"
                className="rdkit-link"
                title={`SELECT * FROM ${name}`}
                onClick={(e) => {
                  e.preventDefault()
                  onPick(`SELECT * FROM ${name} LIMIT 10;`)
                }}
              >
                {name}
              </button>
            </summary>
            <ul>
              {t.columns.map((c) => (
                <li key={c.name}>
                  <span>{c.name}</span> <code>{c.type}</code>
                </li>
              ))}
            </ul>
            {t.indexes.length > 0 && (
              <ul className="rdkit-indexes">
                {t.indexes.map((i) => (
                  <li key={i.name} title={i.def}>
                    <span>{i.name}</span>
                    {/USING gist/i.test(i.def) && <code>gist</code>}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )
      })}
      <p className="rdkit-hint">
        {schema.rdkitFunctions.length} RDKit functions available for autocomplete. Try <code>\df mol_*</code>.
      </p>
    </aside>
  )
}
