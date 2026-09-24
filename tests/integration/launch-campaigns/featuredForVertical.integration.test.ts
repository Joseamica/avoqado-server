/**
 * La VITRINA del giro contra Postgres REAL (relevo 2026-09-24).
 *
 * 🔴 Lo que sólo se puede probar aquí: la exclusividad vive en la BASE — un índice único PARCIAL
 * (`WHERE "featuredForVertical" = true`) que Prisma no expresa ni reporta en un `migrate diff`, y un
 * CHECK que impide que una ficha terminada conserve la vitrina. Con el cliente mockeado, las dos
 * cosas se darían por buenas sin haberse ejecutado nunca.
 *
 * Y la carrera de verdad: dos pestañas del superadmin marcando dos campañas del MISMO giro a la vez.
 * El candado por giro (advisory lock) las pone en fila; sin él, la segunda chocaría con el índice.
 *
 * Corre SIEMPRE contra una base DESECHABLE, nunca contra `av-db-25`:
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration \
 *     --runInBand --runTestsByPath tests/integration/launch-campaigns/featuredForVertical.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

const SUFIJO = `vit${Date.now().toString(36)}`
const A = `camp-a-${SUFIJO}` // FOOD_SERVICE — la de Google a $22
const B = `camp-b-${SUFIJO}` // FOOD_SERVICE — la de Meta a $25, activa A LA VEZ
const C = `camp-c-${SUFIJO}` // RETAIL

async function insertar(id: string, vertical: string, precio: number) {
  await prisma.$executeRaw`
    INSERT INTO "LaunchCampaign" (
      "id","code","name","landingSlug","vertical","planTier","advertisedPriceCents","discountMonths","currency",
      "redemptionCap","redemptionCount","status","listPriceCentsSnapshot","discountAmountCents",
      "stripeCouponId","bullets","validFrom","validUntil","updatedAt"
    ) VALUES (
      ${id}, ${`${id.toUpperCase().slice(0, 20)}`}, ${id}, ${id}, ${vertical}::"LaunchCampaignVertical", ${'PRO'}::"PlanTier",
      ${precio}, ${3}, ${'MXN'}, ${100}, ${0}, ${'ACTIVE'}::"LaunchCampaignStatus",
      ${115884}, ${115884 - precio}, ${`LC_${id}_V1`}, ${[]},
      ${utcTs(new Date('2020-01-01T00:00:00Z'))}, ${utcTs(new Date('2099-01-01T00:00:00Z'))}, ${utcTs(new Date())}
    )`
}

async function vitrinaDe(vertical: string): Promise<string[]> {
  const filas = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LaunchCampaign"
     WHERE "vertical" = ${vertical}::"LaunchCampaignVertical" AND "featuredForVertical" = true
     ORDER BY "id"`
  return filas.map(f => f.id)
}

async function limpiarMarcas() {
  await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "featuredForVertical" = false WHERE "id" IN (${A}, ${B}, ${C})`
}

/** El código de error de Postgres que viaja dentro del error de Prisma, venga como venga envuelto. */
function codigoPg(error: unknown): string | undefined {
  const texto = JSON.stringify(error, Object.getOwnPropertyNames(error as object)) + String(error)
  return ['23505', '23514'].find(c => texto.includes(c))
}

beforeAll(async () => {
  await insertar(A, 'FOOD_SERVICE', 2200)
  await insertar(B, 'FOOD_SERVICE', 2500)
  await insertar(C, 'RETAIL', 2200)
})

beforeEach(limpiarMarcas)

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "LaunchCampaign" WHERE "id" IN (${A}, ${B}, ${C})`
  await prisma.$disconnect()
})

describe('la base: índice único parcial y CHECK', () => {
  it('🔴 dos campañas del MISMO giro no pueden ocupar la vitrina a la vez (23505)', async () => {
    await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "featuredForVertical" = true WHERE "id" = ${A}`
    const error = await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "featuredForVertical" = true WHERE "id" = ${B}`.catch(e => e)
    expect(codigoPg(error)).toBe('23505')
    expect(await vitrinaDe('FOOD_SERVICE')).toEqual([A])
  })

  it('giros distintos tienen cada uno su vitrina', async () => {
    await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "featuredForVertical" = true WHERE "id" IN (${A}, ${C})`
    expect(await vitrinaDe('FOOD_SERVICE')).toEqual([A])
    expect(await vitrinaDe('RETAIL')).toEqual([C])
  })

  it('dos campañas ACTIVAS del mismo giro sin vitrina conviven sin problema (el caso Google $22 + Meta $25)', async () => {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM "LaunchCampaign"
       WHERE "id" IN (${A}, ${B}) AND "status" = 'ACTIVE' AND "vertical" = 'FOOD_SERVICE'`
    expect(Number(n)).toBe(2)
  })

  it('🔴 una ficha TERMINADA no puede conservar la vitrina (23514)', async () => {
    const error = await prisma.$executeRaw`
      UPDATE "LaunchCampaign" SET "featuredForVertical" = true, "status" = 'ENDED' WHERE "id" = ${C}`.catch(e => e)
    expect(codigoPg(error)).toBe('23514')
  })
})

/**
 * El candado por giro, con las MISMAS sentencias que emite `soltarVitrinaDelGiro` +
 * `updateLaunchCampaign` (advisory lock → desmarca a la otra → marca a la propia, en UNA
 * transacción).
 *
 * ⚠️ Por qué SQL crudo y no el servicio, igual que `seatReservation.integration.test.ts`: dentro de
 * Jest, `@prisma/client` resuelve al cliente generado del ÁRBOL PRINCIPAL, que no conoce el campo
 * nuevo (medido el 24-sep: `Unknown field featuredForVertical`, también con `--no-cache`). Que el
 * servicio emita ESTAS sentencias lo guardan sus pruebas unitarias; que Postgres las serialice como
 * se espera, esto. Ninguna sustituye a la otra.
 */
async function marcar(id: string, vertical: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`launch-campaign-featured:${vertical}`}))::text`
    await tx.$executeRaw`
      UPDATE "LaunchCampaign" SET "featuredForVertical" = false
       WHERE "vertical" = ${vertical}::"LaunchCampaignVertical" AND "featuredForVertical" = true AND "id" <> ${id}`
    await tx.$executeRaw`UPDATE "LaunchCampaign" SET "featuredForVertical" = true WHERE "id" = ${id}`
  })
}

describe('el candado por giro', () => {
  it('🔴 marcar la segunda del giro le quita la vitrina a la primera', async () => {
    await marcar(A, 'FOOD_SERVICE')
    expect(await vitrinaDe('FOOD_SERVICE')).toEqual([A])
    await marcar(B, 'FOOD_SERVICE')
    expect(await vitrinaDe('FOOD_SERVICE')).toEqual([B])
  })

  it('🔴 DOS pestañas marcando a la vez: las dos terminan bien y queda EXACTAMENTE una', async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      await limpiarMarcas()
      const resultados = await Promise.allSettled([marcar(A, 'FOOD_SERVICE'), marcar(B, 'FOOD_SERVICE')])
      expect(resultados.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(await vitrinaDe('FOOD_SERVICE')).toHaveLength(1)
    }
  })

  it('terminar la que ocupa la vitrina y soltarla en el MISMO UPDATE pasa el CHECK', async () => {
    await marcar(C, 'RETAIL')
    await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "status" = 'ENDED', "featuredForVertical" = false WHERE "id" = ${C}`
    expect(await vitrinaDe('RETAIL')).toEqual([])
    await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "status" = 'ACTIVE' WHERE "id" = ${C}`.catch(() => undefined)
  })
})
