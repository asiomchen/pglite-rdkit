export const SEED_SQL = `
CREATE EXTENSION IF NOT EXISTS rdkit;

CREATE TABLE molecules (id serial PRIMARY KEY, name text NOT NULL, m mol NOT NULL, fp bfp);
INSERT INTO molecules (name, m) VALUES
  ('aspirin',        'CC(=O)Oc1ccccc1C(=O)O'),
  ('paracetamol',    'CC(=O)Nc1ccc(O)cc1'),
  ('ibuprofen',      'CC(C)Cc1ccc(cc1)C(C)C(=O)O'),
  ('naproxen',       'COc1ccc2cc(ccc2c1)C(C)C(=O)O'),
  ('caffeine',       'Cn1cnc2c1c(=O)n(C)c(=O)n2C'),
  ('theobromine',    'Cn1cnc2c1c(=O)[nH]c(=O)n2C'),
  ('nicotine',       'CN1CCC[C@H]1c1cccnc1'),
  ('morphine',       'CN1CC[C@]23c4c5ccc(O)c4O[C@H]2[C@@H](O)C=C[C@H]3[C@H]1C5'),
  ('codeine',        'COc1ccc2C[C@H]3N(C)CC[C@@]45[C@@H](Oc1c24)[C@@H](O)C=C[C@@H]35'),
  ('diazepam',       'CN1C(=O)CN=C(c2ccccc2)c2cc(Cl)ccc21'),
  ('fluoxetine',     'CNCCC(Oc1ccc(cc1)C(F)(F)F)c1ccccc1'),
  ('sertraline',     'CN[C@H]1CC[C@@H](c2ccc(Cl)c(Cl)c2)c2ccccc21'),
  ('metformin',      'CN(C)C(=N)N=C(N)N'),
  ('atorvastatin',   'CC(C)c1c(C(=O)Nc2ccccc2)c(-c2ccccc2)c(-c2ccc(F)cc2)n1CC[C@@H](O)C[C@@H](O)CC(=O)O'),
  ('penicillin G',   'CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O'),
  ('amoxicillin',    'CC1(C)S[C@@H]2[C@H](NC(=O)[C@H](N)c3ccc(O)cc3)C(=O)N2[C@H]1C(=O)O'),
  ('sildenafil',     'CCCc1nn(C)c2c(=O)[nH]c(-c3cc(ccc3OCC)S(=O)(=O)N3CCN(C)CC3)nc12'),
  ('imatinib',       'Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1'),
  ('dopamine',       'NCCc1ccc(O)c(O)c1'),
  ('serotonin',      'NCCc1c[nH]c2ccc(O)cc12'),
  ('benzene',        'c1ccccc1'),
  ('ethanol',        'CCO');
UPDATE molecules SET fp = morganbv_fp(m);
CREATE INDEX molecules_m_idx ON molecules USING gist (m);
CREATE INDEX molecules_fp_idx ON molecules USING gist (fp);
`

export const EXAMPLES: { title: string; sql: string }[] = [
  {
    title: 'Browse the table',
    sql: `SELECT id, name, m AS smiles, mol_to_svg(m, '', 220, 160) AS structure
FROM molecules
ORDER BY id;`,
  },
  {
    title: 'Descriptors',
    sql: `SELECT name,
       round(mol_amw(m)::numeric, 2)  AS mw,
       round(mol_logp(m)::numeric, 2) AS logp,
       mol_hba(m) AS hba,
       mol_hbd(m) AS hbd,
       mol_numrotatablebonds(m) AS rot_bonds,
       round(mol_tpsa(m)::numeric, 1) AS tpsa,
       mol_formula(m) AS formula
FROM molecules
ORDER BY mw DESC;`,
  },
  {
    title: 'InChI & InChIKey',
    sql: `SELECT name,
       mol_inchikey(m) AS inchikey,
       mol_inchi(m) AS inchi
FROM molecules
ORDER BY name;`,
  },
  {
    title: 'Substructure search (@>)',
    sql: `-- molecules containing a carboxylic acid
SELECT name, mol_to_svg(m, '', 220, 160) AS structure
FROM molecules
WHERE m @> 'C(=O)[OH]'::qmol;`,
  },
  {
    title: 'SMARTS: catechol',
    sql: `SELECT name, m AS smiles, mol_to_svg(m, '', 220, 160) AS structure
FROM molecules
WHERE m @> 'c([OH])c[OH]'::qmol;`,
  },
  {
    title: 'Similarity search (%)',
    sql: `-- Tanimoto on Morgan fingerprints, threshold via GUC
SET rdkit.tanimoto_threshold = 0.3;

SELECT name,
       round(tanimoto_sml(fp, morganbv_fp('Cn1cnc2c1c(=O)n(C)c(=O)n2C'::mol))::numeric, 3) AS similarity,
       mol_to_svg(m, '', 220, 160) AS structure
FROM molecules
WHERE fp % morganbv_fp('Cn1cnc2c1c(=O)n(C)c(=O)n2C'::mol)
ORDER BY similarity DESC;`,
  },
  {
    title: 'Nearest neighbours (<%>)',
    sql: `-- KNN ordering by Tanimoto distance using the gist index
SELECT name,
       round(tanimoto_sml(fp, morganbv_fp('CC(=O)Nc1ccc(O)cc1'::mol))::numeric, 3) AS similarity
FROM molecules
ORDER BY fp <%> morganbv_fp('CC(=O)Nc1ccc(O)cc1'::mol)
LIMIT 5;`,
  },
  {
    title: 'Check the plan uses the index',
    sql: `SET enable_seqscan = off;
EXPLAIN SELECT name FROM molecules WHERE m @> 'c1ccccc1'::qmol;`,
  },
  {
    title: 'Canonicalize & validate',
    sql: `-- is_valid_smiles / mol_from_smiles take cstring, so cast text columns
SELECT s AS input,
       is_valid_smiles(s::cstring) AS valid,
       mol_to_smiles(mol_from_smiles(s::cstring)) AS canonical
FROM unnest(ARRAY['C1=CC=CC=C1O', 'OC(=O)c1ccccc1', 'C1CC', 'c1cccc1']) AS s;`,
  },
  {
    title: 'Draw your own molecule',
    sql: `SELECT mol_to_svg('O=C(O)c1ccccc1OC(C)=O'::mol, 'aspirin', 400, 300) AS structure;`,
  },
  {
    title: 'Error handling',
    sql: `-- invalid SMILES raises a normal postgres error
SELECT 'C1CCxyz'::mol;`,
  },
]
