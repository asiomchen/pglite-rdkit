import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'
import { rdkit } from 'pglite-rdkit'

// Postgres runs off the main thread, so loading RDKit and long searches don't freeze the editor
worker({
  async init(options) {
    return new PGlite({ dataDir: options.dataDir, extensions: { rdkit } })
  },
})
