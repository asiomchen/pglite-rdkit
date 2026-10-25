import { defineConfig } from 'vite'

export default defineConfig({
  // data/mols.smi (from data.mjs) is served as /mols.smi
  publicDir: 'data',
  // both packages locate their wasm / extension bundles via import.meta.url,
  // which pre-bundling would break
  optimizeDeps: {
    exclude: ['@electric-sql/pglite', 'pglite-rdkit'],
  },
  // page.js uses top-level await
  build: { target: 'es2022' },
  // pglite-rdkit is linked from ../package, so its rdkit.tar.gz is outside this folder
  server: {
    fs: { allow: ['..'] },
  },
})
