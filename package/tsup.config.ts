import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from 'tsup'

const entryPoints = ['src/index.ts']

const minify = process.env.DEBUG === 'true' ? false : true

export default defineConfig([
  {
    entry: entryPoints,
    sourcemap: true,
    dts: {
      entry: entryPoints,
      resolve: true,
    },
    clean: true,
    minify: minify,
    shims: true,
    format: ['esm', 'cjs'],
    onSuccess: async () => {
      // ship the extension bundle next to the built entry points and point
      // the bundlePath URL (../release/rdkit.tar.gz in src) at it
      cpSync(resolve('release/rdkit.tar.gz'), resolve('dist/rdkit.tar.gz'))
      for (const file of readdirSync('dist')) {
        if (!/\.c?js$/.test(file)) continue
        const path = join('dist', file)
        const src = readFileSync(path, 'utf8')
        const out = src.replace(/\.\.\/release\//g, './')
        if (out !== src) writeFileSync(path, out)
      }
    },
  },
])
