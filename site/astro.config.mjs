// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import react from '@astrojs/react'
import starlightLinksValidator from 'starlight-links-validator'
import { EXAMPLES } from 'pglite-rdkit/examples'

const repo = 'https://github.com/asiomchen/pglite-rdkit'

// the landing page links to /playground/#<example id>; those hashes aren't headings, so check them here instead
const exampleIds = new Set(EXAMPLES.map((e) => e.id))
/** @param {string} link */
const isExampleLink = (link) => {
  const m = link.match(/^\/playground\/#(.+)$/)
  return m !== null && exampleIds.has(m[1])
}

export default defineConfig({
  // the floating dev toolbar covers the REPL prompt at the bottom of the page
  devToolbar: { enabled: false },
  site: 'https://pglite-rdkit.cheminfo.dev',
  integrations: [
    starlight({
      title: 'pglite-rdkit',
      description:
        'The RDKit cheminformatics cartridge as a PGlite extension: molecules in Postgres, in the browser.',
      favicon: '/favicon.svg',
      // Umami analytics; data-domains keeps the dev server and previews out of the stats.
      // Custom events are sent from src/lib/analytics.ts
      head: [
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: 'https://umami.cheminfo.dev/script.js',
            'data-website-id': '1e36c19d-3b61-4a61-8b62-78d79bfc15c1',
            'data-domains': 'pglite-rdkit.cheminfo.dev',
          },
        },
      ],
      logo: { src: './src/assets/logo.svg', alt: '' },
      social: [
        { icon: 'github', label: 'GitHub', href: repo },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/pglite-rdkit' },
      ],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      // look and feel follow pglite.dev: Inter, dark only, a top nav instead of a sidebar
      customCss: [
        '@fontsource-variable/inter/opsz.css',
        '@fontsource-variable/jetbrains-mono/wght.css',
        './src/styles/custom.css',
      ],
      components: {
        Header: './src/components/starlight/Header.astro',
        Footer: './src/components/starlight/Footer.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
      },
      // plain code blocks on VitePress' code background, no editor/terminal frames
      expressiveCode: {
        themes: ['github-dark'],
        defaultProps: { frame: 'none' },
        styleOverrides: {
          borderRadius: '8px',
          borderColor: 'transparent',
          codeBackground: '#161618',
          codeFontFamily: 'var(--__sl-font-mono)',
          codeFontSize: '0.875rem',
          codePaddingBlock: '1.25rem',
          codePaddingInline: '1.5rem',
        },
      },
      // three pages, two of them apps: nothing worth a search index or prev/next links
      pagefind: false,
      pagination: false,
      plugins: [starlightLinksValidator({ exclude: ({ link }) => isExampleLink(link) })],
    }),
    react(),
  ],
  vite: {
    // both packages locate their wasm / extension bundles via import.meta.url,
    // which pre-bundling would break
    optimizeDeps: {
      exclude: ['@electric-sql/pglite', 'pglite-rdkit'],
    },
    // the PGlite worker is a module worker, so import.meta.url keeps working inside it
    worker: { format: 'es' },
    // pglite-rdkit is linked from ../package, so its rdkit.tar.gz is outside this folder
    server: {
      fs: { allow: ['..'] },
    },
  },
})
