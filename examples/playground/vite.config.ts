import { defineConfig } from 'vite'

export default defineConfig({
  // both packages locate their wasm / extension bundles via import.meta.url,
  // which pre-bundling would break
  optimizeDeps: {
    exclude: ['@electric-sql/pglite', 'pglite-rdkit'],
  },
  // pglite-rdkit is linked from ../../package, so its rdkit.tar.gz is outside this folder
  server: {
    fs: { allow: ['../..'] },
  },
})
