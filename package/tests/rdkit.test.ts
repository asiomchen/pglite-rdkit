import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { rdkit } from '../src/index.js'

// Upstream xqm.sql exercises all four representations, not just single-molecule queries.
const extendedQueries = [
  { type: '1', query: 'CCO', match: 'CCO', miss: 'c1ccccc1' },
  { type: '2', query: 'COC |LN:1:1.3|', match: 'COOC', miss: 'COOOOC' },
  { type: '3', query: 'Cc1n[nH]c(F)c1', match: 'Cc1[nH]nc(F)c1', miss: 'Cc1n[nH]c(Cl)c1' },
  { type: '4', query: 'COC1=NNC=C1 |LN:1:1.3|', match: 'COOc1[nH]ncc1', miss: 'COOOOc1[nH]ncc1' },
]

describe(`rdkit`, () => {
  let pg: PGlite
  let dataDirArchive: File | Blob
  beforeEach(async () => {
    if (!dataDirArchive) {
      pg = await PGlite.create({
        extensions: { rdkit },
      })
      dataDirArchive = await pg.dumpDataDir('gzip')
    } else {
      pg = await PGlite.create({
        extensions: { rdkit },
        loadDataDir: dataDirArchive,
      })
    }
    await pg.exec('CREATE EXTENSION IF NOT EXISTS rdkit;')
  })
  afterEach(async () => {
    if (!pg.closed) {
      await pg.close()
    }
  })

  it('version', async () => {
    const res = await pg.query<{ version: string }>(
      `SELECT rdkit_toolkit_version() AS version;`,
    )
    expect(res.rows[0].version).toBe('2026.09.2')
  })

  it('parses and canonicalizes SMILES', async () => {
    const res = await pg.query<{ smiles: string }>(
      `SELECT mol_to_smiles('C1=CC=CC=C1O'::mol) AS smiles;`,
    )
    expect(res.rows[0].smiles).toBe('Oc1ccccc1')
  })

  it('validates SMILES', async () => {
    const res = await pg.query<{ valid: boolean; invalid: boolean }>(
      `SELECT is_valid_smiles('CCO') AS valid, is_valid_smiles('C1CC') AS invalid;`,
    )
    expect(res.rows[0]).toEqual({ valid: true, invalid: false })
  })

  it('raises a postgres error on invalid input', async () => {
    // RDKit throws C++ exceptions on bad input, the cartridge turns them into ereport(ERROR)
    await expect(pg.query(`SELECT 'C1CCxyz'::mol;`)).rejects.toThrow(
      /could not create molecule/,
    )
    // and the backend is still usable afterwards
    const res = await pg.query<{ n: number }>(
      `SELECT mol_numatoms('CCO'::mol) AS n;`,
    )
    expect(res.rows[0].n).toBe(9)
  })

  it.each(['mol', 'qmol'])('ignores malformed query JSON for %s and keeps the database usable', async (type) => {
    const { rows } = await pg.query<{ smarts: string; fallback: string }>(`
      SELECT mol_to_smarts(mol_adjust_query_properties('Cc1ccccc1'::${type}, '{"adjustDegree":false')) AS smarts,
             mol_to_smarts(mol_adjust_query_properties('Cc1ccccc1'::${type})) AS fallback;
    `)
    expect(rows).toHaveLength(1)
    expect(rows[0].smarts).toBe(rows[0].fallback)
    expect(rows[0].smarts).toContain('&D3')
    expect((await pg.query<{ n: number }>('SELECT 1 AS n')).rows).toEqual([{ n: 1 }])
  })

  it('runs the cartridge 4.7.0 to 4.8.0 upgrade script', async () => {
    // Reuse the installed schema to exercise every ALTER FUNCTION in the shipped update script.
    // This checks SQL compatibility; it does not simulate a complete 4.7.0 database migration.
    await pg.exec(`
      UPDATE pg_extension SET extversion = '4.7.0' WHERE extname = 'rdkit';
      ALTER EXTENSION rdkit UPDATE TO '4.8.0';
    `)
    const { rows } = await pg.query<{ version: string; atoms: number }>(`
      SELECT extversion AS version, qmol_numheavyatoms('CCO'::qmol) AS atoms
      FROM pg_extension WHERE extname = 'rdkit';
    `)
    expect(rows).toEqual([{ version: '4.8.0', atoms: 3 }])
  })

  it('computes descriptors', async () => {
    const res = await pg.query<{
      amw: number
      logp: number
      heavy: number
      hbd: number
    }>(`
      SELECT mol_amw(m) AS amw, mol_logp(m) AS logp,
             mol_numheavyatoms(m) AS heavy, mol_hbd(m) AS hbd
      FROM (SELECT 'CC(=O)Oc1ccccc1C(=O)O'::mol AS m) t;
    `)
    const row = res.rows[0]
    expect(row.amw).toBeCloseTo(180.159, 2)
    expect(row.logp).toBeCloseTo(1.31, 1)
    expect(row.heavy).toBe(13)
    expect(row.hbd).toBe(1)
  })

  it('substructure search with and without a gist index', async () => {
    await pg.exec(`
      CREATE TABLE mols (id serial PRIMARY KEY, m mol);
      INSERT INTO mols (m) VALUES
        ('c1ccccc1O'), ('CCO'), ('c1ccncc1'), ('CC(=O)Oc1ccccc1C(=O)O'), ('CCCC');
    `)
    const query = `SELECT id FROM mols WHERE m @> 'c1ccccc1'::qmol ORDER BY id;`
    const seqScan = await pg.query<{ id: number }>(query)
    expect(seqScan.rows.map((r) => r.id)).toEqual([1, 4])

    await pg.exec(`
      CREATE INDEX mols_m_idx ON mols USING gist (m);
      SET enable_seqscan = off;
    `)
    const plan = await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query}`)
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'mols_m_idx',
    )
    const indexScan = await pg.query<{ id: number }>(query)
    expect(indexScan.rows).toEqual(seqScan.rows)
  })

  it.each(extendedQueries)('serializes and matches extended query type $type', async ({ type, query, match, miss }) => {
    const { rows } = await pg.query<{ serialized: string; matches: boolean; misses: boolean; bytes: number }>(`
      SELECT q::text AS serialized, $2::mol @> q AS matches, $3::mol @> q AS misses,
             octet_length(xqmol_send(q)) AS bytes
      FROM (SELECT mol_to_xqmol($1::mol) AS q) queries;
    `, [query, match, miss])
    expect(JSON.parse(rows[0].serialized).xqm_type).toBe(type)
    expect(rows[0].matches).toBe(true)
    expect(rows[0].misses).toBe(false)
    expect(rows[0].bytes).toBeGreaterThan(0)

    // Text input must reconstruct the same query and retain its matching behavior.
    const roundTrip = await pg.query<{ matches: boolean; misses: boolean }>(`
      SELECT $2::mol @> $1::xqmol AS matches, $3::mol @> $1::xqmol AS misses;
    `, [rows[0].serialized, match, miss])
    expect(roundTrip.rows[0]).toEqual({ matches: true, misses: false })
  })

  it('preserves extended queries after reloading the database', async () => {
    await pg.exec('CREATE TABLE saved_queries (kind text, q xqmol, target mol, nonmatch mol);')
    for (const { type, query, match, miss } of extendedQueries) {
      await pg.query(`
        INSERT INTO saved_queries VALUES ($1, mol_to_xqmol($2::mol), $3::mol, $4::mol);
      `, [type, query, match, miss])
    }
    const archive = await pg.dumpDataDir('gzip')
    await pg.close()
    pg = await PGlite.create({ extensions: { rdkit }, loadDataDir: archive })
    const { rows } = await pg.query<{ kind: string; serialized: string; matches: boolean; misses: boolean }>(`
      SELECT kind, q::text AS serialized, target @> q AS matches, nonmatch @> q AS misses
      FROM saved_queries ORDER BY kind;
    `)
    expect(rows).toHaveLength(extendedQueries.length)
    for (const row of rows) {
      expect(JSON.parse(row.serialized).xqm_type).toBe(row.kind)
      expect(row.matches).toBe(true)
      expect(row.misses).toBe(false)
    }
  })

  it('fingerprint similarity', async () => {
    const res = await pg.query<{ self: number; other: number }>(`
      SELECT tanimoto_sml(morganbv_fp('c1ccccc1O'::mol), morganbv_fp('c1ccccc1O'::mol)) AS self,
             tanimoto_sml(morganbv_fp('c1ccccc1O'::mol), morganbv_fp('CCCC'::mol)) AS other;
    `)
    expect(res.rows[0].self).toBe(1)
    expect(res.rows[0].other).toBeLessThan(0.2)

    await pg.exec(`
      CREATE TABLE fps (id serial PRIMARY KEY, fp bfp);
      INSERT INTO fps (fp) SELECT morganbv_fp(s::mol)
        FROM unnest(ARRAY['c1ccccc1O', 'c1ccccc1N', 'CCCC']) AS s;
      CREATE INDEX fps_fp_idx ON fps USING gist (fp);
      SET rdkit.tanimoto_threshold = 0.3;
    `)
    const similar = await pg.query<{ id: number }>(
      `SELECT id FROM fps WHERE fp % morganbv_fp('c1ccccc1O'::mol) ORDER BY id;`,
    )
    expect(similar.rows.map((r) => r.id)).toEqual([1, 2])
  })

  it.each([
    { metric: 'tanimoto', operator: '<%>' },
    { metric: 'dice', operator: '<#>' },
  ])('returns the exact $metric nearest neighbors through a multi-page GiST index', async ({ metric, operator }) => {
    // RDKit's bfpknn_data fixture (BSD-3-Clause), from Release_2026_09_2.
    // Similar benzamides force inner-node traversal, where the upstream distance bug occurred.
    const molecules = readFileSync(new URL('./fixtures/bfpknn.tsv', import.meta.url), 'utf8')
      .trim().split('\n').map((line) => line.split('\t')[1])
    await pg.exec('SET rdkit.morgan_fp_size = 512; CREATE TABLE knn_fps (id int, fp bfp);')
    await pg.query(`
      INSERT INTO knn_fps
      SELECT id::int, morganbv_fp(smiles::mol)
      FROM unnest($1::text[]) WITH ORDINALITY AS molecules(smiles, id);
    `, [molecules])
    await pg.exec(`
      CREATE INDEX knn_fps_idx ON knn_fps USING gist (fp);
      CREATE TABLE knn_query AS SELECT morganbv_fp('CCc1ccc(C(=O)NCc2ccccc2)cc1'::mol) AS fp;
    `)
    const size = await pg.query<{ pages: number }>(`
      SELECT (pg_relation_size('knn_fps_idx') / current_setting('block_size')::int)::int AS pages;
    `)
    expect(size.rows[0].pages).toBeGreaterThanOrEqual(3)

    await pg.exec('SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_seqscan = on;')
    const exact = await pg.query<{ distance: number }>(`
      SELECT 1.0 - ${metric}_sml(fp, (SELECT fp FROM knn_query)) AS distance
      FROM knn_fps ORDER BY distance LIMIT 10;
    `)
    await pg.exec('SET enable_indexscan = on; SET enable_seqscan = off;')
    const query = `
      SELECT fp ${operator} (SELECT fp FROM knn_query) AS distance
      FROM knn_fps ORDER BY fp ${operator} (SELECT fp FROM knn_query) LIMIT 10;
    `
    const plan = await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query}`)
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toMatch(/Index (Only )?Scan using knn_fps_idx/)
    const indexed = await pg.query<{ distance: number }>(query)
    expect(indexed.rows).toHaveLength(10)
    // Equal-distance molecules may come back in any order, so compare distances rather than ids.
    indexed.rows.forEach((row, i) => expect(row.distance).toBeCloseTo(exact.rows[i].distance, 10))
  })

  it('computes InChI and InChIKey', async () => {
    const res = await pg.query<{ inchi: string; key: string; stereo: string }>(`
      SELECT mol_inchi('CC(=O)Oc1ccccc1C(=O)O'::mol) AS inchi,
             mol_inchikey('CC(=O)Oc1ccccc1C(=O)O'::mol) AS key,
             mol_inchi('C[C@H](N)C(=O)O'::mol) AS stereo;
    `)
    expect(res.rows[0]).toEqual({
      inchi: 'InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)',
      key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
      stereo: 'InChI=1S/C3H7NO2/c1-2(4)3(5)6/h2H,4H2,1H3,(H,5,6)/t2-/m0/s1',
    })
  })

  it('passes InChI options and handles molecules InChI cannot represent', async () => {
    const res = await pg.query<{ fixedh: string; dummy: string | null; empty: string | null }>(`
      SELECT mol_inchi('CC(=O)O'::mol, '/FixedH') AS fixedh,
             mol_inchi('*C'::mol) AS dummy,
             mol_inchi(''::mol) AS empty;
    `)
    expect(res.rows[0]).toEqual({
      fixedh: 'InChI=1/C2H4O2/c1-2(3)4/h1H3,(H,3,4)/f/h3H',
      dummy: null,
      empty: null,
    })
    const after = await pg.query<{ one: number }>('SELECT 1 AS one;')
    expect(after.rows[0].one).toBe(1)
  })

  it('renders svg', async () => {
    const res = await pg.query<{ svg: string }>(
      `SELECT mol_to_svg('c1ccccc1O'::mol) AS svg;`,
    )
    expect(res.rows[0].svg).toMatch(/<svg/)
  })

  it('renders svg with a legend and charged atoms', async () => {
    // label layout calls islower/isupper; on 0.5.0-0.5.9 these were missing from pglite.wasm and
    // the query returned no rows instead of failing
    const res = await pg.query<{ svg: string }>(
      `SELECT mol_to_svg('ClCC[NH3+]'::mol, 'aspirin')::text AS svg;`,
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].svg).toMatch(/<svg/)
    // without FreeType, SVG text remains in <text> elements that use browser fonts
    expect(res.rows[0].svg).toContain("class='legend'")
    expect(res.rows[0].svg).toContain("class='atom-3'")
  })
})
