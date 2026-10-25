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
cd site && pnpm install && pnpm run dev
```

`pnpm run build` type-checks (`astro check`), builds into `dist/` and validates internal
links.

## Deploy

`.github/workflows/docs.yml` deploys the production site to the `pglite-rdkit`
Cloudflare Pages project at `pglite-rdkit.cheminfo.dev`. Run **Deploy docs** manually
with a published npm version, or leave the version empty to use npm’s `latest`.
Publishing a stable GitHub release also deploys its version; publishing a prerelease
does not trigger deployment.
The workflow builds site content from the ref it runs on and installs `pglite-rdkit`
from npm. It needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository
secrets, and the domain configured as a custom domain of the Pages project.
The site job in `.github/workflows/compat.yml` only builds the site for CI; it does not
deploy previews for branches or pull requests.
