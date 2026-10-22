// RDKit returns SVG markup as text; it is shown through an <img> so any markup
// typed into a query can't run scripts in the page
export const isSvg = (v: unknown): v is string =>
  typeof v === 'string' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(v)

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

export const MAX_TEXT = 120

/** Plain-text rendering of a non-SVG cell. Fingerprints (bfp/sfp) arrive as bytea. */
export function formatValue(value: unknown): string {
  if (value instanceof Uint8Array) {
    const hex = [...value.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `\\x${hex}${value.length > 16 ? '…' : ''} (${value.length} bytes)`
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** "1 row", "1,000,000 rows" */
export const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`

/** Base64 for share links, safe for non-ASCII SQL. */
export const encodeShare = (sql: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(sql)))

export function decodeShare(encoded: string): string | undefined {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}
