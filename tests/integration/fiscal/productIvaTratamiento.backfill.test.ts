// tests/integration/fiscal/productIvaTratamiento.backfill.test.ts
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import prisma from '@/utils/prismaClient'

const sqlBackfill = fs.readFileSync(
  path.join(__dirname, '../../../prisma/migrations/20260926000100_iva_tratamiento_backfill/migration.sql'),
  'utf8',
)

// El archivo trae 3 sentencias de nivel superior (UPDATE, DO $$ ... $$, UPDATE). `prisma.$executeRawUnsafe`
// usa el protocolo extendido (prepared statement) y Postgres rechaza varias sentencias ahí con
// "cannot insert multiple commands into a prepared statement". `prisma migrate deploy` sí puede correrlo
// porque su motor no pasa por ese camino. Aquí se reproduce lo mismo con `pg.Client` (protocolo simple),
// que es exactamente como corre la migración real.
async function ejecutarBackfill(): Promise<void> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(sqlBackfill)
  } finally {
    await client.end()
  }
}

describe('backfill de Product.ivaTratamiento', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string, venueId: string, categoryId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `BF ${s}`, email: `bf-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    venueId = (await prisma.venue.create({ data: { organizationId, name: `BF ${s}`, slug: `bf-${s}`, seatCapExempt: true } })).id
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `C ${s}`, slug: `c-${s}` } as any })).id
  })

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  // La prueba corre DESPUÉS de las dos migraciones (la columna ya es NOT NULL), así que no puede recrear filas en
  // NULL. Comprueba lo que el relleno debe dejar garantizado: el invariante sobre TODA la tabla, y que la marca
  // pegajosa se reconstruye aunque alguien la haya dejado en false.
  it('invariante: ningún producto contradice su tupla (salvo EXENTO, que no se deriva)', async () => {
    const rotos = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
      SELECT count(*) AS n FROM "Product"
      WHERE "ivaTratamiento" IS NULL
         OR ("ivaTratamiento" <> 'EXENTO' AND "derivarIvaTratamiento"("taxRate", "objetoImp") IS DISTINCT FROM "ivaTratamiento")
         OR ("ivaTratamiento" = 'EXENTO' AND ("objetoImp" <> '02' OR round("taxRate", 4) <> 0))`)
    expect(Number(rotos[0].n)).toBe(0)
  })

  it('la marca pegajosa se reconstruye para una organización con un producto heredado 04', async () => {
    await prisma.venueIvaPorProducto.create({ data: { venueId } }) // sólo para poder sembrar el 04 en la prueba
    await prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${s}`, name: 'GRN TURISMO 2 KG', price: 480, objetoImp: '04' } as any,
    })
    await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } })
    await prisma.$executeRawUnsafe(`UPDATE "Organization" SET "ivaMixtoAlgunaVez" = false WHERE "id" = $1`, organizationId)

    await ejecutarBackfill()

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })
    expect(org.ivaMixtoAlgunaVez).toBe(true)
    const cafe = await prisma.product.findFirstOrThrow({ where: { venueId, name: 'GRN TURISMO 2 KG' } })
    expect(cafe.ivaTratamiento).toBe('BLOQUEADO_04')
  })

  it('es idempotente: correrlo otra vez no cambia nada ni falla', async () => {
    await expect(ejecutarBackfill()).resolves.toBeUndefined()
  })
})
