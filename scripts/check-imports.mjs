#!/usr/bin/env node
// Lists every import of a PGlite side module (extension .so) that the
// published main module cannot satisfy at dlopen time.
//
// usage: node scripts/check-imports.mjs <rdkit.so> [pglite.wasm] [pglite.js]
//   pglite.wasm defaults to package/node_modules/@electric-sql/pglite/dist/pglite.wasm
//   pglite.js   defaults to pglite.js next to pglite.wasm
//
// Emscripten's dylink resolves a side module's env.* / GOT.mem.* / GOT.func.*
// imports via resolveGlobalSymbol(): a name is provided iff it is a key of the
// JS `wasmImports` object (JS library functions + the main module's exports,
// which are merged in at startup), or it starts with "invoke_" (those wrappers
// are generated on demand for any signature). Anything else becomes a lazy
// stub that throws "missing function" when called (or a load-time error for
// required GOT entries). Exit code 1 if anything is missing.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [sidePath, mainWasmArg, mainJsArg] = process.argv.slice(2)
if (!sidePath) {
  console.error('usage: check-imports.mjs <side.so> [pglite.wasm] [pglite.js]')
  process.exit(2)
}
const mainWasmPath =
  mainWasmArg ??
  join(ROOT, 'package/node_modules/@electric-sql/pglite/dist/pglite.wasm')
const mainJsPath = mainJsArg ?? join(dirname(mainWasmPath), 'pglite.js')

// Keys of the top-level `wasmImports={...}` object literal in the emscripten glue.
function jsLibrarySymbols(js) {
  const m = /\bwasmImports\s*=\s*\{/.exec(js)
  if (!m) throw new Error(`no "wasmImports={" object literal in ${mainJsPath}`)
  let i = m.index + m[0].length
  let depth = 1
  let seg = ''
  const keys = []
  const push = () => {
    const k = seg.split(':')[0].trim().replace(/^["']|["']$/g, '')
    if (k) keys.push(k)
    seg = ''
  }
  for (; i < js.length && depth > 0; i++) {
    const c = js[i]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    if (depth === 0) break
    if (c === ',' && depth === 1) push()
    else if (depth === 1) seg += c
  }
  push()
  if (keys.length < 50) throw new Error(`suspiciously few wasmImports keys (${keys.length})`)
  return new Set(keys)
}

// JS implementation source of a wasmImports symbol (`var _name=...;_name.sig=`)
function jsBody(js, name) {
  const decl = `var _${name}=`
  const start = js.indexOf(decl)
  if (start < 0) return null
  const end = js.indexOf(`;_${name}.sig=`, start)
  return js.slice(start, end < 0 ? start + 400 : end)
}

// provided by the dylink loader itself (memory/table/relocation bases)
const LOADER = new Set([
  'memory',
  '__indirect_function_table',
  '__stack_pointer',
  '__memory_base',
  '__table_base',
])

const side = new WebAssembly.Module(readFileSync(sidePath))
const main = new WebAssembly.Module(readFileSync(mainWasmPath))
const js = readFileSync(mainJsPath, 'utf8')
const jsSyms = jsLibrarySymbols(js)
const mainExports = new Set(WebAssembly.Module.exports(main).map((e) => e.name))
const sideExports = new Set(WebAssembly.Module.exports(side).map((e) => e.name))

const imports = WebAssembly.Module.imports(side)
const missing = []
const aborting = []
const stats = { loader: 0, self: 0, main: 0, js: 0, invoke: 0 }
for (const imp of imports) {
  const n = imp.name
  if (LOADER.has(n)) stats.loader++
  else if (sideExports.has(n)) stats.self++
  else if (mainExports.has(n)) stats.main++
  else if (jsSyms.has(n)) {
    stats.js++
    // present, but a stub that kills the runtime (e.g. C++ EH when the main
    // module was linked without exception catching: __cxa_throw -> abort())
    const body = jsBody(js, n)
    if (imp.kind === 'function' && body && /\babort\(/.test(body) && !/^(abort|_abort_js|__assert_fail)$/.test(n))
      aborting.push(imp)
  }
  else if (n.startsWith('invoke_')) stats.invoke++
  else missing.push(imp)
}

console.log(`side module:  ${sidePath}`)
console.log(`main module:  ${mainWasmPath} (${mainExports.size} exports)`)
console.log(`JS glue:      ${mainJsPath} (${jsSyms.size} wasmImports)`)
console.log(
  `imports: ${imports.length} total; provided by loader ${stats.loader}, ` +
    `side module itself ${stats.self}, main exports ${stats.main}, ` +
    `JS library ${stats.js}, dynamic invoke_* ${stats.invoke}`,
)
if (aborting.length) {
  console.log(`PROVIDED BUT ABORT() IN JS GLUE (${aborting.length}) - calling these kills the runtime:`)
  for (const imp of aborting.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`  ${imp.module}.${imp.name}`)
}
if (missing.length) {
  console.log(`MISSING (${missing.length}):`)
  for (const imp of missing.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`  ${imp.module}.${imp.name} (${imp.kind})`)
}
if (!missing.length && !aborting.length) console.log('OK: all imports are provided')
process.exit(missing.length || aborting.length ? 1 : 0)
