import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

const current = (): Theme =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'

/** Follows Starlight's theme toggle, which sets data-theme on <html>. */
export function useStarlightTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(current)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
