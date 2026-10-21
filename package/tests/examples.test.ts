import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { rdkit } from '../src/index.js'
import { EXAMPLES, SEED_SQL } from '../src/examples.js'

// the playground and the website show these queries, so they must keep working
describe(`examples`, () => {
  let pg: PGlite
  beforeAll(async () => {
    pg = await PGlite.create({ extensions: { rdkit } })
    await pg.exec(SEED_SQL)
  })
  afterAll(async () => {
    await pg.close()
  })

  it('have unique ids', () => {
    const ids = EXAMPLES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const example of EXAMPLES) {
    it(example.id, async () => {
      const run = pg.exec(example.sql)
      if (example.id === 'error-handling') {
        await expect(run).rejects.toThrow()
      } else {
        const results = await run
        expect(results.length).toBeGreaterThan(0)
      }
    })
  }
})
