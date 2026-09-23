/**
 * S8 — el CUPO bajo concurrencia REAL (spec 2026-09-17 § 3.6 paso 7, § 9.1).
 *
 * 🔴 Esto NO se puede probar con el cliente mockeado, y por eso vive aquí: lo que impide la
 * sobreventa es el comportamiento de **Postgres** en Read Committed — `UPDATE … WHERE
 * redemptionCount < redemptionCap` bloquea la fila y vuelve a EVALUAR el WHERE después de
 * obtener el candado. Una prueba unitaria daría eso por bueno sin haberlo ejecutado nunca.
 *
 * ⚠️ ENTORNO, medido el 2026-09-17 y hay que saberlo antes de tocar este archivo: dentro de Jest,
 * `@prisma/client` resuelve al cliente generado del ÁRBOL PRINCIPAL (`avoqado-server/node_modules`),
 * que NO conoce los modelos nuevos — `prisma.launchCampaignRedemption` vale `undefined` y los enums
 * nuevos también. En `node` a secas el worktree resuelve el suyo, fresco, así que **producción está
 * bien**; lo que falla es la resolución de Jest. Por eso este archivo habla con la base por SQL
 * crudo, igual que `schema.integration.test.ts`. Si algún día se arregla (regenerando el cliente del
 * árbol principal), esto se puede reescribir con el cliente tipado.
 *
 * Corre SIEMPRE contra una base DESECHABLE, nunca contra `av-db-25`:
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration \
 *     --runInBand --runTestsByPath tests/integration/launch-campaigns/seatReservation.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

const SUFIJO = `seat${Date.now().toString(36)}`
const CAMPAIGN = `camp-${SUFIJO}`
const CUPO = 5
const INTENTOS = 20

const VALID_FROM = new Date('2020-01-01T00:00:00.000Z')
const VALID_UNTIL = new Date('2099-01-01T00:00:00.000Z')

/** Una organización por intento: el índice único parcial es POR ORGANIZACIÓN. */
function orgId(i: number) {
  return `org-${SUFIJO}-${i}`
}

beforeAll(async () => {
  const valores = Array.from({ length: INTENTOS }, (_, i) => i)
  for (const i of valores) {
    await prisma.$executeRaw`
      INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
      VALUES (${orgId(i)}, ${`Org ${i} ${SUFIJO}`}, ${`o${i}-${SUFIJO}@test.local`}, ${'5500000000'}, ${utcTs(new Date())})`
  }
  await prisma.$executeRaw`
    INSERT INTO "LaunchCampaign" (
      "id","code","name","landingSlug","planTier","advertisedPriceCents","discountMonths","currency",
      "redemptionCap","redemptionCount","status","listPriceCentsSnapshot","discountAmountCents",
      "stripeCouponId","bullets","validFrom","validUntil","updatedAt"
    ) VALUES (
      ${CAMPAIGN}, ${`POS22-${SUFIJO}`}, ${'POS $22'}, ${`pos-22-${SUFIJO}`}, ${'PRO'}::"PlanTier",
      ${2200}, ${3}, ${'MXN'}, ${CUPO}, ${0}, ${'ACTIVE'}::"LaunchCampaignStatus",
      ${115884}, ${113684}, ${`LC_POS22_${SUFIJO}_V1`}, ${[]}, ${utcTs(VALID_FROM)}, ${utcTs(VALID_UNTIL)}, ${utcTs(new Date())}
    )`
})

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "LaunchCampaignRedemption"`
  await prisma.$executeRaw`DELETE FROM "LaunchCampaign"`
  await prisma.$executeRaw`DELETE FROM "Organization" WHERE "id" LIKE ${`org-${SUFIJO}-%`}`
  await prisma.$disconnect()
})

/**
 * La MISMA sentencia que emite `planActivation.service.ts` — su `updateMany` con la referencia de
 * campo `redemptionCount < redemptionCap` compila exactamente a este WHERE — seguida, sólo si ganó,
 * de la fila de redención.
 *
 * 🔴 Lo que se prueba AQUÍ es la semántica de POSTGRES, no el orquestador: que el `UPDATE`
 * condicional bloquee la fila y vuelva a evaluar el WHERE después del candado. Que el SERVICIO
 * siga emitiendo ese WHERE lo guarda la prueba unitaria y su sabotaje; ninguna de las dos
 * sustituye a la otra, y por eso las dos existen.
 */
async function apartar(i: number): Promise<'ganó' | 'perdió'> {
  const ahora = new Date()
  try {
    return await prisma.$transaction(async tx => {
      const tomados = await tx.$executeRaw`
        UPDATE "LaunchCampaign"
           SET "redemptionCount" = "redemptionCount" + 1
         WHERE "id" = ${CAMPAIGN}
           AND "status" = 'ACTIVE'::"LaunchCampaignStatus"
           AND "offerVersion" = 1
           AND "validFrom" <= ${utcTs(ahora)}
           AND "validUntil" > ${utcTs(ahora)}
           AND "redemptionCount" < "redemptionCap"`
      if (tomados !== 1) return 'perdió'

      await tx.$executeRaw`
        INSERT INTO "LaunchCampaignRedemption" (
          "id","campaignId","organizationId","status","offerVersion","planTier","advertisedPriceCents",
          "discountAmountCents","discountMonths","listPriceCents","stripeCouponId","updatedAt"
        ) VALUES (
          ${`red-${SUFIJO}-${i}-${Math.random().toString(36).slice(2, 8)}`}, ${CAMPAIGN}, ${orgId(i)},
          ${'RESERVED'}::"LaunchCampaignRedemptionStatus", ${1}, ${'PRO'}::"PlanTier", ${2200},
          ${113684}, ${3}, ${115884}, ${`LC_POS22_${SUFIJO}_V1`}, ${utcTs(new Date())}
        )`
      return 'ganó'
    })
  } catch {
    // Un choque con el índice único parcial revierte la transacción ENTERA, incremento incluido:
    // por eso perder aquí no deja el contador inflado.
    return 'perdió'
  }
}

describe('el cupo bajo concurrencia real', () => {
  it(`🔴 ${INTENTOS} reservas simultáneas sobre un cupo de ${CUPO} dejan EXACTAMENTE ${CUPO}`, async () => {
    const resultados = await Promise.all(Array.from({ length: INTENTOS }, (_, i) => apartar(i)))

    const ganadores = resultados.filter(r => r === 'ganó').length
    expect(ganadores).toBe(CUPO)

    const [{ redemptionCount }] = await prisma.$queryRaw<Array<{ redemptionCount: number }>>`
      SELECT "redemptionCount" FROM "LaunchCampaign" WHERE "id" = ${CAMPAIGN}`
    expect(Number(redemptionCount)).toBe(CUPO)

    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "LaunchCampaignRedemption"
       WHERE "campaignId" = ${CAMPAIGN} AND "status" = 'RESERVED'::"LaunchCampaignRedemptionStatus"`
    expect(Number(n)).toBe(CUPO)
  }, 60_000)

  it('🔴 el CHECK de la base es el respaldo: un UPDATE directo que pase del cupo se RECHAZA', async () => {
    // Si alguien «optimiza» el WHERE condicional algún día, esto es lo que sigue impidiendo la
    // sobreventa — y por eso el CHECK existe además de la sentencia.
    await expect(prisma.$executeRaw`UPDATE "LaunchCampaign" SET "redemptionCount" = ${CUPO + 1} WHERE "id" = ${CAMPAIGN}`).rejects.toThrow()
  })

  it('🔴 la MISMA organización no puede tomar DOS lugares vivos (índice único parcial)', async () => {
    // La campaña ya está llena, así que se sube el cupo para aislar el candado que se prueba.
    await prisma.$executeRaw`UPDATE "LaunchCampaign" SET "redemptionCap" = ${CUPO + 5} WHERE "id" = ${CAMPAIGN}`

    const vivasDe = async (org: string) => {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "LaunchCampaignRedemption"
         WHERE "organizationId" = ${org} AND "status" <> 'RELEASED'::"LaunchCampaignRedemptionStatus"`
      return Number(n)
    }

    const primera = await apartar(0)
    expect(['ganó', 'perdió']).toContain(primera)
    expect(await vivasDe(orgId(0))).toBe(1)

    // Un segundo intento de la MISMA organización choca con el índice único parcial y no deja
    // una segunda fila viva — que es lo que impide contar DOS veces contra el cupo.
    await apartar(0)
    expect(await vivasDe(orgId(0))).toBe(1)
  }, 30_000)
})
