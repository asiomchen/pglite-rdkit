import { defineConfig } from 'vitest/config'

// scripts/compat-matrix.sh runs this suite against other @electric-sql/pglite releases by
// pointing PGLITE_DIR at an installed copy of that release
const pgliteDir = process.env.PGLITE_DIR

export default defineConfig({
  resolve: pgliteDir ? { alias: { '@electric-sql/pglite': pgliteDir } } : {},
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
  },
})
