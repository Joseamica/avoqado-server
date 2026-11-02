import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const migration = readFileSync('prisma/migrations/20261020120100_cambio_de_producto/migration.sql', 'utf8')
const schema = `cambio_lock_${process.pid}_${Date.now()}`
let writer: Client
let reader: Client

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/.test(url.pathname))
    throw new Error('La prueba de migración requiere su base desechable local.')
  writer = new Client({ connectionString: url.toString() })
  reader = new Client({ connectionString: url.toString() })
  await writer.connect()
  await reader.connect()
  await writer.query(`CREATE SCHEMA "${schema}"`)
  await writer.query(`SET search_path TO "${schema}"`)
  await writer.query('CREATE TABLE "VenueSettings" (id text PRIMARY KEY)')
  await writer.query("SET statement_timeout = '8s'")
})
afterAll(async () => {
  await reader?.query('ROLLBACK')
  await writer?.query('ROLLBACK')
  await writer?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await Promise.all([writer?.end(), reader?.end()])
})

it('bounds the exclusive VenueSettings lock to 5s inside the migration transaction and rolls back atomically', async () => {
  await reader.query('BEGIN')
  await reader.query(`SELECT * FROM "${schema}"."VenueSettings"`)
  try {
    await expect(writer.query(migration)).rejects.toMatchObject({ code: '55P03', message: 'canceling statement due to lock timeout' })
  } finally {
    await reader.query('ROLLBACK')
    await writer.query('ROLLBACK')
  }
  expect((await writer.query(`SELECT to_regtype('"ExchangeStatus"')::text AS name`)).rows).toEqual([{ name: null }])
  expect((await writer.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '0' }])
}, 15000)

it('applies the complete migration when the lock is available', async () => {
  await writer.query(migration)
  expect(
    (
      await writer.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'VenueSettings' AND column_name = 'exchangesEnabled'`,
        [schema],
      )
    ).rows,
  ).toEqual([{ is_nullable: 'YES' }])
  expect((await writer.query('SELECT count(*)::int AS count FROM "ExchangeCreditLink"')).rows).toEqual([{ count: 0 }])
  expect((await writer.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '0' }])
})
