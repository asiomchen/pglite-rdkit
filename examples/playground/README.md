# RDKit playground

An in-browser SQL playground for `pglite-rdkit`, running on the stock npm `@electric-sql/pglite`
it targets. On startup it creates a `molecules` table with about 20 well-known drugs, Morgan
fingerprints, and GiST indexes. The sidebar has example queries. Any SVG returned by a query, such
as `mol_to_svg(m)`, is shown as an image.

```bash
./scripts/build.sh                # from the repo root: builds dist/rdkit.tar.gz
(cd package && npm run build)     # packages it into package/dist
cd examples/playground && npm install && npm run dev
```

Press <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to run the query in the editor.
