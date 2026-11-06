# Changelog

## 0.0.2 (unreleased)

- Update RDKit from 2026.09.1 to [2026.09.2](https://github.com/rdkit/rdkit/releases/tag/Release_2026_09_2).
- Include upstream fixes for incorrect nearest neighbors from `bfp` GiST indexes
  (`ORDER BY <%>` and `ORDER BY <#>`), malformed JSON crashing
  `mol_adjust_query_properties()`, and the cartridge's 4.7.0 to 4.8.0 SQL upgrade script.
- Add regression coverage for indexed Tanimoto and Dice nearest neighbors, malformed
  query JSON, and execution of the cartridge upgrade script.

The cartridge extension version remains 4.8.0, and the supported PGlite range remains
`>=0.5.0 <0.6.0`.