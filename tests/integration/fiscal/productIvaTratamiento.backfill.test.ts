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

// Fix round 1 (Ruling R8, hallazgo Importante #2): las tres pruebas de arriba corren DESPUÉS de que la
// columna ya es NOT NULL, así que el UPDATE del relleno nunca toca una fila real (siempre 0 filas) y el
// DO $$ ... RAISE EXCEPTION ... $$ del guard de abort jamás se ejercita — la prueba de idempotencia es un
// no-op sobre el camino de relleno. Este helper reproduce el estado ANTERIOR a las migraciones de la Tarea 4
// —columna nullable, sin CHECK, sin DEFAULT— dentro de UNA transacción que SIEMPRE se revierte (BEGIN…
// ROLLBACK en try/finally), conectada sólo a TEST_DATABASE_URL, para poder sembrar filas legacy con
// "ivaTratamiento" NULL (los triggers de la Tarea 2 lo impedirían con las tres barreras encendidas) y correr
// el archivo REAL del relleno contra ellas. Nada de esto sobrevive: el ROLLBACK deshace tanto el DDL
// (ALTER TABLE es transaccional en Postgres) como el DML. Ojo: ese ALTER/DISABLE TRIGGER USER toma ACCESS
// EXCLUSIVE sobre "Product" hasta el ROLLBACK, y sólo es seguro porque el proyecto de integración corre con
// --runInBand (ninguna otra suite toca "Product" en paralelo mientras la transacción vive).
async function conTransaccionDesechable<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

async function volverAlEstadoPreTarea4(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE "Product" ALTER COLUMN "ivaTratamiento" DROP NOT NULL;
    ALTER TABLE "Product" DROP CONSTRAINT "Product_ivaTratamiento_not_null";
    ALTER TABLE "Product" ALTER COLUMN "ivaTratamiento" DROP DEFAULT;
    ALTER TABLE "Product" DISABLE TRIGGER USER;
  `)
}

describe('backfill de Product.ivaTratamiento', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let venueId: string, categoryId: string
  const organizaciones: Array<{ organizationId: string; venueId: string }> = []

  // Plan 4: la marca pegajosa ya no se apaga (trigger "Organization_ivaMixto_pegajosa"). Cada caso que necesita una
  // organización SIN marca usa una NUEVA, que nace así (Ruling PF7).
  async function nuevaOrganizacion(etiqueta: string) {
    const organizationId = (
      await prisma.organization.create({
        data: { name: `BF ${etiqueta} ${s}`, email: `bf-${etiqueta}-${s}@example.com`, phone: '5555555555' },
      })
    ).id
    const venue = (
      await prisma.venue.create({ data: { organizationId, name: `BF ${etiqueta} ${s}`, slug: `bf-${etiqueta}-${s}`, seatCapExempt: true } })
    ).id
    const categoria = (
      await prisma.menuCategory.create({ data: { venueId: venue, name: `C ${etiqueta} ${s}`, slug: `c-${etiqueta}-${s}` } as any })
    ).id
    organizaciones.push({ organizationId, venueId: venue })
    return { organizationId, venueId: venue, categoryId: categoria }
  }

  const marcada = async (organizationId: string) =>
    (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { ivaMixtoAlgunaVez: true } })).ivaMixtoAlgunaVez

  beforeAll(async () => {
    ;({ venueId, categoryId } = await nuevaOrganizacion('base'))
  })

  afterAll(async () => {
    for (const o of organizaciones) {
      await prisma.product.deleteMany({ where: { venueId: o.venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId: o.venueId } })
      await prisma.venue.deleteMany({ where: { id: o.venueId } })
      await prisma.organization.deleteMany({ where: { id: o.organizationId } })
    }
  })

  // La prueba corre DESPUÉS de las dos migraciones (la columna ya es NOT NULL), así que no puede recrear filas en
  // NULL. Comprueba lo que el relleno debe dejar garantizado: el invariante sobre TODA la tabla, y que la marca
  // pegajosa se reconstruye en una organización que tiene un producto ≠ 16 % y no la tiene.
  it('invariante: ningún producto contradice su tupla (salvo EXENTO, que no se deriva)', async () => {
    const rotos = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
      SELECT count(*) AS n FROM "Product"
      WHERE "ivaTratamiento" IS NULL
         OR ("ivaTratamiento" <> 'EXENTO' AND "derivarIvaTratamiento"("taxRate", "objetoImp") IS DISTINCT FROM "ivaTratamiento")
         OR ("ivaTratamiento" = 'EXENTO' AND ("objetoImp" <> '02' OR round("taxRate", 4) <> 0))`)
    expect(Number(rotos[0].n)).toBe(0)
  })

  // El valor BLOQUEADO_04 en sí lo asigna el trigger de INSERT (Tarea 2) al crear el producto, no este
  // archivo de relleno — lo que esta prueba pin-ea es que el relleno RECONSTRUYE la marca pegajosa de una
  // organización que tiene un producto ≠ 16 % sin la marca. Plan 4: como la marca ya no se apaga, ese estado viejo
  // se siembra en una organización NUEVA con los triggers apagados SÓLO dentro de la transacción de la siembra.
  it('el backfill reconstruye la marca pegajosa de la organización (el BLOQUEADO_04 lo puso el trigger de INSERT)', async () => {
    await prisma.venueIvaPorProducto.create({ data: { venueId } }) // sólo para poder sembrar el 04 en la prueba
    await prisma.product.create({
      data: { venueId, categoryId, sku: `SKU-${s}`, name: 'GRN TURISMO 2 KG', price: 480, objetoImp: '04' } as any,
    })
    await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } })
    const cafe = await prisma.product.findFirstOrThrow({ where: { venueId, name: 'GRN TURISMO 2 KG' } })
    expect(cafe.ivaTratamiento).toBe('BLOQUEADO_04')

    const vieja = await nuevaOrganizacion('vieja')
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.product.create({
        data: {
          venueId: vieja.venueId,
          categoryId: vieja.categoryId,
          sku: `SKU-vieja-${s}`,
          name: 'GRN TURISMO 2 KG',
          price: 480,
          taxRate: 0.16,
          objetoImp: '04',
          ivaTratamiento: 'BLOQUEADO_04',
        },
      })
    })
    expect(await marcada(vieja.organizationId)).toBe(false)

    await ejecutarBackfill()

    expect(await marcada(vieja.organizationId)).toBe(true)
  })

  it('es idempotente: correrlo otra vez no cambia nada ni falla', async () => {
    await expect(ejecutarBackfill()).resolves.toBeUndefined()
  })

  // Fix round 1 (Ruling R8, hallazgo Importante #2): regresión REAL del camino de relleno — no del invariante
  // ya cumplido, sino del propio UPDATE del archivo de la Tarea 4. Dentro de una transacción desechable se
  // baja la tabla al estado "antes de la Tarea 4" (nullable, sin CHECK, sin DEFAULT, triggers apagados),
  // se siembran las 6 tuplas legacy con "ivaTratamiento" NULL, se prenden los triggers de vuelta y se corre
  // el ARCHIVO real de la migración de relleno — el mismo que ya está aplicado en la base.
  it('el archivo real del relleno deriva las 6 tuplas legacy (Ruling R8: 0.16/01 termina en 0/01)', async () => {
    const ids = {
      iva16: `bf-${s}-iva16`,
      iva8: `bf-${s}-iva8`,
      iva0: `bf-${s}-iva0`,
      noObjeto: `bf-${s}-noobjeto`,
      bloqueado03: `bf-${s}-b03`,
      bloqueado04: `bf-${s}-b04`,
    }
    const filas: Array<{ id: string; taxRate: number; objetoImp: string }> = [
      { id: ids.iva16, taxRate: 0.16, objetoImp: '02' },
      { id: ids.iva8, taxRate: 0.08, objetoImp: '02' },
      { id: ids.iva0, taxRate: 0, objetoImp: '02' },
      { id: ids.noObjeto, taxRate: 0.16, objetoImp: '01' },
      { id: ids.bloqueado03, taxRate: 0.16, objetoImp: '03' },
      { id: ids.bloqueado04, taxRate: 0.16, objetoImp: '04' },
    ]

    // Plan 4: una organización NUEVA nace sin la marca (ya no se apaga); todo lo de abajo se revierte.
    const legado = await nuevaOrganizacion('legado')

    await conTransaccionDesechable(async client => {
      await volverAlEstadoPreTarea4(client)

      for (const f of filas) {
        await client.query(
          `INSERT INTO "Product" (id, "venueId", sku, name, "categoryId", price, "taxRate", "objetoImp", "ivaTratamiento", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 100, $6, $7, NULL, now())`,
          [f.id, legado.venueId, `SKU-${f.id}`, `Legacy ${f.id}`, legado.categoryId, f.taxRate, f.objetoImp],
        )
      }

      await client.query(`ALTER TABLE "Product" ENABLE TRIGGER USER`)
      expect(await marcada(legado.organizationId)).toBe(false)

      // El archivo REAL, verbatim, tal como está aplicado en la base.
      await client.query(sqlBackfill)

      const { rows } = await client.query<{ id: string; ivaTratamiento: string; taxRate: string }>(
        `SELECT id, "ivaTratamiento", "taxRate" FROM "Product" WHERE id = ANY($1) ORDER BY id`,
        [Object.values(ids)],
      )
      const porId = new Map(rows.map(r => [r.id, r]))

      expect(porId.get(ids.iva16)?.ivaTratamiento).toBe('IVA_16')
      expect(Number(porId.get(ids.iva16)?.taxRate)).toBe(0.16)

      expect(porId.get(ids.iva8)?.ivaTratamiento).toBe('IVA_8')
      expect(Number(porId.get(ids.iva8)?.taxRate)).toBe(0.08)

      expect(porId.get(ids.iva0)?.ivaTratamiento).toBe('IVA_0')
      expect(Number(porId.get(ids.iva0)?.taxRate)).toBe(0)

      // Ruling R8: la única fila cuya taxRate SÍ cambia — (0.16, '01') termina en (0, '01') porque el
      // trigger "_1_explicito" reescribe la tupla a la canónica de NO_OBJETO al ver que taxRate/objetoImp
      // no cambiaron en el UPDATE del relleno (sólo tocó la columna "ivaTratamiento").
      expect(porId.get(ids.noObjeto)?.ivaTratamiento).toBe('NO_OBJETO')
      expect(Number(porId.get(ids.noObjeto)?.taxRate)).toBe(0)

      // BLOQUEADO_03/04 conservan su taxRate original: no están en la lista de reescritura del trigger.
      expect(porId.get(ids.bloqueado03)?.ivaTratamiento).toBe('BLOQUEADO_03')
      expect(Number(porId.get(ids.bloqueado03)?.taxRate)).toBe(0.16)

      expect(porId.get(ids.bloqueado04)?.ivaTratamiento).toBe('BLOQUEADO_04')
      expect(Number(porId.get(ids.bloqueado04)?.taxRate)).toBe(0.16)

      const { rows: orgRows } = await client.query<{ ivaMixtoAlgunaVez: boolean }>(
        `SELECT "ivaMixtoAlgunaVez" FROM "Organization" WHERE id = $1`,
        [legado.organizationId],
      )
      expect(orgRows[0]?.ivaMixtoAlgunaVez).toBe(true)
    })
  })

  it('el archivo real del relleno detiene la migración si una tupla es contradictoria (objeto 02 con tasa que el SAT no admite)', async () => {
    const idContradictorio = `bf-${s}-contradictorio`

    await conTransaccionDesechable(async client => {
      await volverAlEstadoPreTarea4(client)

      await client.query(
        `INSERT INTO "Product" (id, "venueId", sku, name, "categoryId", price, "taxRate", "objetoImp", "ivaTratamiento", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 100, 0.10, '02', NULL, now())`,
        [idContradictorio, venueId, `SKU-${idContradictorio}`, `Legacy ${idContradictorio}`, categoryId],
      )

      await client.query(`ALTER TABLE "Product" ENABLE TRIGGER USER`)

      await expect(client.query(sqlBackfill)).rejects.toThrow(/Hay productos con una tupla taxRate\/objetoImp que el SAT no admite/)
    })
  })
})
