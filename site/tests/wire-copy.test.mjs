import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { simpleQuery } from '../src/lib/wire.ts'

test('unsupported COPY input leaves the database session usable', { timeout: 30_000 }, async (t) => {
  const pg = await PGlite.create()
  const query = (sql) => simpleQuery(pg, sql, 1000)
  const healthy = async () => {
    const result = await query('SELECT 42 AS answer;')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 'I')
    assert.deepEqual(result.statements[0].rows, [['42']])
  }
  try {
    await pg.exec('CREATE TABLE x (a int, "from" text, "stdin" text);')
    const copies = [
      'COPY x FROM STDIN;',
      'cOpY x fRoM sTdIn',
      'COPY x FROM /* comment */ STDIN;',
      'COPY/* comment */x/* ; */FROM/* outer /* nested */ comment */STDIN;',
      'COPY x FROM -- comment\nSTDIN;',
      'COPY x FROM -- comment\rSTDIN;',
      'COPY x FROM\t\r\nSTDIN;',
      'COPY "public"."x" ("from", "stdin") FROM STDIN WITH (FORMAT csv);',
      'COPY BINARY x FROM STDIN;',
      // PostgreSQL treats FROM STDOUT as FROM STDIN for historical compatibility.
      'COPY x FROM STDOUT;',
      'COPY x FROM /* ; */ STDOUT WITH (FORMAT binary);',
      "SELECT 'semicolon; and quote: ''value'''; COPY x FROM STDIN;",
      'SELECT $tag$ COPY x FROM STDIN; $tag$; COPY x FROM STDIN;',
      'SELECT 1 AS strange$tag$identifier; COPY x FROM STDIN;',
      'SELECT 1; /* ; /* nested; */ */ COPY x FROM STDIN;',
      String.raw`SELECT E'quote: \'; text'; COPY x FROM STDIN;`,
      String.raw`SELECT '\'; COPY x FROM STDIN;`,
      'COPY x FROM STDIN; COPY x FROM STDIN;',
    ]
    for (const sql of copies) {
      await t.test(JSON.stringify(sql), async () => {
        const result = await query(sql)
        assert.equal(result.error?.C, '57014')
        assert.match(result.error.M, /COPY FROM STDIN is not supported.*INSERT/)
        assert.equal(result.status, 'I')
        await healthy()
      })
    }
    await t.test('session string settings use PostgreSQL parsing', async () => {
      await pg.exec('SET standard_conforming_strings = off')
      const result = await query(String.raw`SELECT '\''; COPY x FROM STDIN;`)
      assert.equal(result.error?.C, '57014')
      await pg.exec('SET standard_conforming_strings = on')
      await healthy()
    })
    await t.test('COPY output and ordinary queries are unaffected', async () => {
      for (const destination of ['STDOUT', 'STDIN']) {
        const output = await query(`COPY (SELECT 7) TO ${destination}; SELECT 8;`)
        assert.equal(output.error, undefined)
        assert.deepEqual(output.copy, ['7\n'])
        assert.deepEqual(output.statements.at(-1).rows, [['8']])
      }
      const literal = await query("SELECT $é$COPY x FROM STDIN;$é$ AS example;")
      assert.equal(literal.error, undefined)
      assert.deepEqual(literal.statements[0].rows, [['COPY x FROM STDIN;']])
      const empty = await query('-- COPY x FROM STDIN;')
      assert.equal(empty.error, undefined)
      await healthy()
    })
    await t.test('COPY failure rolls back an implicit batch and skips later statements', async () => {
      const result = await query('INSERT INTO x(a) VALUES (1); COPY x FROM STDIN; INSERT INTO x(a) VALUES (2);')
      assert.equal(result.error?.C, '57014')
      assert.deepEqual((await query('SELECT count(*) FROM x;')).statements[0].rows, [['0']])
      await healthy()
    })
    await t.test('an explicit transaction reports failure and recovers with ROLLBACK', async () => {
      assert.equal((await query('BEGIN;')).status, 'T')
      const result = await query('COPY x FROM /* comment */ STDIN;')
      assert.equal(result.error?.C, '57014')
      assert.equal(result.status, 'E')
      assert.equal((await query('SELECT 1;')).error?.C, '25P02')
      assert.equal((await query('ROLLBACK;')).status, 'I')
      await healthy()
    })
    await t.test('normal SQL errors and dynamic COPY retain server errors', async () => {
      assert.equal((await query('SELECT FROM;')).error?.C, '42601')
      const dynamic = await query("DO $$ BEGIN EXECUTE 'COPY x FROM STDIN'; END $$;")
      assert.equal(dynamic.error?.C, '0A000')
      await healthy()
    })
  } finally {
    await pg.close()
  }
})
