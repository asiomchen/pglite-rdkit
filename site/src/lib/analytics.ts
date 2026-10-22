// Umami custom events (the script tag is in astro.config.mjs). Umami only loads on the
// production domain and can be blocked, so every call is a no-op when it isn't there.
// Event data never includes the SQL itself, only what kind of query it was and how it went.

type EventData = Record<string, string | number | boolean | undefined>

declare global {
  interface Window {
    umami?: { track(event: string, data?: EventData): void }
  }
}

// Umami's own opt-out key: while it's set, the script records nothing (see the privacy page)
const DISABLED_KEY = 'umami.disabled'

export function analyticsDisabled(): boolean {
  try {
    return localStorage.getItem(DISABLED_KEY) !== null
  } catch {
    return false
  }
}

export function setAnalyticsDisabled(disabled: boolean) {
  try {
    if (disabled) localStorage.setItem(DISABLED_KEY, '1')
    else localStorage.removeItem(DISABLED_KEY)
  } catch {
    // no storage, no saved choice
  }
}

export function track(event: string, data?: EventData) {
  if (analyticsDisabled()) return
  try {
    window.umami?.track(event, data)
  } catch {
    // analytics must never break the page
  }
}

/** Outbound destinations worth their own event name, matched by hostname. */
const OUTBOUND: [RegExp, string][] = [
  [/(^|\.)github\.com$/, 'github-link'],
  [/(^|\.)npmjs\.com$/, 'npm-link'],
  [/(^|\.)rdkit\.org$/, 'rdkit-link'],
  [/(^|\.)pglite\.dev$/, 'pglite-link'],
]

/** Tracks clicks on links to other sites, wherever they are on the page (nav, menu, hero, docs). */
export function trackOutboundLinks() {
  document.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest?.('a[href]')
    if (!(link instanceof HTMLAnchorElement) || link.host === location.host) return
    const event = OUTBOUND.find(([re]) => re.test(link.hostname))?.[1] ?? 'outbound-link'
    const where = link.closest('.mobile-menu')
      ? 'menu'
      : link.closest('header')
        ? 'nav'
        : link.closest('.hero')
          ? 'hero'
          : 'content'
    track(event, { url: link.href, where, page: location.pathname })
  })
}

/** Reports time spent with a page visible, once per visible stretch, as `<event>` with seconds. */
export function trackVisibleTime(event: string, extra: () => EventData = () => ({})) {
  let since = document.visibilityState === 'visible' ? performance.now() : undefined
  const flush = () => {
    if (since === undefined) return
    const seconds = Math.round((performance.now() - since) / 1000)
    since = undefined
    if (seconds > 0) track(event, { seconds, ...extra() })
  }
  const onChange = () => {
    if (document.visibilityState === 'hidden') flush()
    else since ??= performance.now()
  }
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('pagehide', flush)
  return () => {
    flush()
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('pagehide', flush)
  }
}
