import { PGlite, type Results } from '@electric-sql/pglite'
import { rdkit } from 'pglite-rdkit'
import { EXAMPLES, SEED_SQL } from 'pglite-rdkit/examples'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const editor = $<HTMLTextAreaElement>('editor')
const runButton = $<HTMLButtonElement>('run')
const status = $<HTMLSpanElement>('status')
const results = $<HTMLDivElement>('results')
const timing = $<HTMLSpanElement>('timing')
const examplesList = $<HTMLUListElement>('examples')

const setStatus = (text: string, kind: 'loading' | 'ready' | 'error') => {
  status.textContent = text
  status.className = `status ${kind}`
}

// examples sidebar
EXAMPLES.forEach(({ title, sql }, i) => {
  const li = document.createElement('li')
  const button = document.createElement('button')
  button.textContent = title
  button.addEventListener('click', () => {
    editor.value = sql
    run()
  })
  li.append(button)
  examplesList.append(li)
  if (i === 0) editor.value = sql
})

// RDKit returns SVG markup as text; render it through an <img> so any markup
// typed into a query can't run scripts in the page
const isSvg = (v: unknown): v is string =>
  typeof v === 'string' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(v)

const renderCell = (value: unknown): Node => {
  if (isSvg(value)) {
    const img = document.createElement('img')
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`
    img.alt = 'molecule'
    img.className = 'mol'
    return img
  }
  if (value === null) {
    const span = document.createElement('span')
    span.className = 'null'
    span.textContent = 'NULL'
    return span
  }
  if (value instanceof Uint8Array) {
    return document.createTextNode(`\\x${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}`)
  }
  return document.createTextNode(typeof value === 'object' ? JSON.stringify(value) : String(value))
}

const renderResult = (result: Results, index: number, total: number): HTMLElement => {
  const block = document.createElement('div')
  block.className = 'result'
  if (total > 1) {
    const label = document.createElement('div')
    label.className = 'hint'
    label.textContent = `Statement ${index + 1}`
    block.append(label)
  }
  if (result.fields.length === 0) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = result.affectedRows ? `${result.affectedRows} row(s) affected` : 'OK'
    block.append(p)
    return block
  }
  const table = document.createElement('table')
  const head = table.createTHead().insertRow()
  for (const field of result.fields) {
    const th = document.createElement('th')
    th.textContent = field.name
    head.append(th)
  }
  const body = table.createTBody()
  for (const row of result.rows as Record<string, unknown>[]) {
    const tr = body.insertRow()
    for (const field of result.fields) tr.insertCell().append(renderCell(row[field.name]))
  }
  const count = document.createElement('div')
  count.className = 'hint'
  count.textContent = `${result.rows.length} row(s)`
  const wrap = document.createElement('div')
  wrap.className = 'table-wrap'
  wrap.append(table)
  block.append(wrap, count)
  return block
}

let pg: PGlite | undefined

async function run() {
  if (!pg || runButton.disabled) return
  const sql = editor.value
  runButton.disabled = true
  results.replaceChildren()
  const started = performance.now()
  try {
    const res = await pg.exec(sql)
    timing.textContent = `${(performance.now() - started).toFixed(1)} ms`
    const shown = res.filter((r) => r.fields.length > 0)
    const list = shown.length > 0 ? shown : res.slice(-1)
    list.forEach((r, i) => results.append(renderResult(r, i, list.length)))
  } catch (e) {
    timing.textContent = ''
    const err = document.createElement('pre')
    err.className = 'error'
    err.textContent = e instanceof Error ? e.message : String(e)
    results.append(err)
  } finally {
    runButton.disabled = false
  }
}

runButton.addEventListener('click', run)
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    run()
  }
})

async function init() {
  try {
    pg = await PGlite.create({ extensions: { rdkit } })
    setStatus('Loading RDKit and sample data…', 'loading')
    await pg.exec(SEED_SQL)
    const { rows } = await pg.query<{ v: string }>('SELECT rdkit_toolkit_version() AS v')
    setStatus(`Ready · RDKit ${rows[0].v}`, 'ready')
    runButton.disabled = false
    run()
  } catch (e) {
    setStatus(`Failed to start: ${e instanceof Error ? e.message : e}`, 'error')
  }
}

init()
