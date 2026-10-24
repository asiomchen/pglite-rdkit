# pglite-rdkit website

The site at [pglite-rdkit.cheminfo.dev](https://pglite-rdkit.cheminfo.dev): a landing
page, a Playground with the shared examples, and a psql-style REPL. Built with
[Astro](https://astro.build) and [Starlight](https://starlight.astro.build), with React
for the interactive parts.
PGlite runs in a Web Worker.

| Path | What |
| --- | --- |
| `src/content/docs/index.mdx` | Landing page |
| `src/content/docs/playground.mdx`, `repl.mdx` | Full-width pages that mount the React apps |
| `src/components/` | `Playground`, `Repl`, `SchemaPanel`, `LiveDemo`, `SqlEditor` (CodeMirror), `ResultTable` |
| `src/lib/pg.worker.ts`, `client.ts` | PGlite + RDKit in a worker; one database for the playground (memory) and one for the REPL (IndexedDB) |
| `src/lib/run.ts`, `schema.ts` | Running SQL and `\d` commands, schema queries for the panel and autocomplete |
| `public/_headers` | Cloudflare Pages caching, content types and CSP |

The example queries come from the package (`pglite-rdkit/examples`), so the playground,
this site and the test suite share one list.

## Develop

The site uses the local package, so build the extension and the package first:

```bash
./scripts/build.sh && (cd package && npm ci && npm run build)
cd site && npm install && npm run dev
```

`npm run build` type-checks (`astro check`), builds into `dist/` and validates internal
links.

## Deploy

The `site` job in `.github/workflows/compat.yml` builds the site on top of the bundle
from the `build` job and runs `wrangler pages deploy` to the `pglite-rdkit` Cloudflare
Pages project. `main` goes to production; other branches and same-repo PRs get preview
URLs. It needs the `CLOUDFLARE_API_TOKEN` (Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`
repository secrets, and `pglite-rdkit.cheminfo.dev` added as a custom domain of the
Pages project.
