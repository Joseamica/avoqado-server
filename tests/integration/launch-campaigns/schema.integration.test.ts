/**
 * S1 — la MIGRACIÓN y sus candados (spec 2026-09-17 § 2.4 y § 9.1).
 *
 * 🔴 Corre SIEMPRE contra una base DESECHABLE, nunca contra `av-db-25`:
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration \
 *     --runInBand --runTestsByPath tests/integration/launch-campaigns/schema.integration.test.ts
 * Ese script crea la base, aplica `prisma migrate deploy`, corre esto y la borra con
 * `DROP … WITH (FORCE)` comprobando después que ya no existe.
 *
 * Qué se prueba aquí y no se puede probar en otro sitio: los CHECK y el índice único PARCIAL
 * viven en POSTGRES, no en TypeScript. Una prueba unitaria con el cliente mockeado los daría por
 * buenos sin haberlos ejecutado nunca — que es exactamente cómo una migración mal escrita llega
 * a producción en verde.
 *
 * 🔴 Todas las fechas de SQL crudo van por `utcTs()`: un bind pelón se compara en la zona de la
 * SESIÓN, que aquí es `America/Mexico_City` y en producción `UTC` (.claude/rules/critical-warnings.md).
 */
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

const SUFIJO = `lc${Date.now().toString(36)}`
const ORG_A = `org-a-${SUFIJO}`
const ORG_B = `org-b-${SUFIJO}`
const VENUE_A = `venue-a-${SUFIJO}`
const CAMPAIGN = `camp-${SUFIJO}`

const VALID_FROM = new Date('2026-09-01T06:00:00.000Z')
const VALID_UNTIL = new Date('2026-10-31T06:00:00.000Z')

/** Inserta una ficha por SQL crudo: es la única forma de ejercitar los CHECK con valores que el cliente tipado no deja expresar. */
async function insertarCampana(overrides: Record<string, unknown> = {}, client: PrismaClient = prisma as unknown as PrismaClient) {
  const v = {
    id: CAMPAIGN,
    code: `POS22-${SUFIJO}`,
    name: 'POS a $22',
    landingSlug: `pos-22-${SUFIJO}`,
    planTier: 'PRO',
    advertisedPriceCents: 2200,
    discountMonths: 3,
    redemptionCap: 100,
    redemptionCount: 0,
    status: 'DRAFT',
    listPriceCentsSnapshot: null as number | null,
    discountAmountCents: null as number | null,
    stripeCouponId: null as string | null,
    currency: 'MXN',
    headline: null as string | null,
    subheadline: null as string | null,
    bullets: [] as string[],
    ...overrides,
  }
  await client.$executeRaw`
    INSERT INTO "LaunchCampaign" (
      "id", "code", "name", "landingSlug", "planTier", "advertisedPriceCents", "discountMonths",
      "currency", "redemptionCap", "redemptionCount", "status", "listPriceCentsSnapshot",
      "discountAmountCents", "stripeCouponId", "headline", "subheadline", "bullets",
      "validFrom", "validUntil", "updatedAt"
    ) VALUES (
      ${v.id}, ${v.code}, ${v.name}, ${v.landingSlug}, ${v.planTier}::"PlanTier",
      ${v.advertisedPriceCents}, ${v.discountMonths}, ${v.currency}, ${v.redemptionCap},
      ${v.redemptionCount}, ${v.status}::"LaunchCampaignStatus", ${v.listPriceCentsSnapshot},
      ${v.discountAmountCents}, ${v.stripeCouponId},
      ${v.headline}, ${v.subheadline}, ${v.bullets},
      ${utcTs(VALID_FROM as Date)}, ${utcTs(VALID_UNTIL as Date)}, ${utcTs(new Date())}
    )`
  return v
}

async function insertarRedencion(overrides: Record<string, unknown> = {}) {
  const v = {
    id: `red-${Math.random().toString(36).slice(2, 10)}`,
    campaignId: CAMPAIGN,
    organizationId: ORG_A,
    venueId: null as string | null,
    status: 'RESERVED',
    offerVersion: 1,
    planTier: 'PRO',
    advertisedPriceCents: 2200,
    discountAmountCents: 113684,
    discountMonths: 3,
    listPriceCents: 115884,
    stripeCouponId: 'LC_POS22_V1',
    stripeSubscriptionId: null as string | null,
    appliedAt: null as Date | null,
    releasedAt: null as Date | null,
    ...overrides,
  }
  await prisma.$executeRaw`
    INSERT INTO "LaunchCampaignRedemption" (
      "id", "campaignId", "organizationId", "venueId", "status", "offerVersion", "planTier",
      "advertisedPriceCents", "discountAmountCents", "discountMonths", "listPriceCents",
      "stripeCouponId", "stripeSubscriptionId", "appliedAt", "releasedAt", "reservedAt", "updatedAt"
    ) VALUES (
      ${v.id}, ${v.campaignId}, ${v.organizationId}, ${v.venueId},
      ${v.status}::"LaunchCampaignRedemptionStatus", ${v.offerVersion}, ${v.planTier}::"PlanTier",
      ${v.advertisedPriceCents}, ${v.discountAmountCents}, ${v.discountMonths}, ${v.listPriceCents},
      ${v.stripeCouponId}, ${v.stripeSubscriptionId},
      ${v.appliedAt ? utcTs(v.appliedAt) : Prisma.sql`NULL::timestamp`},
      ${v.releasedAt ? utcTs(v.releasedAt) : Prisma.sql`NULL::timestamp`},
      ${utcTs(new Date())}, ${utcTs(new Date())}
    )`
  return v
}

beforeAll(async () => {
  await prisma.$executeRaw`
    INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
    VALUES (${ORG_A}, ${'Org A ' + SUFIJO}, ${`a-${SUFIJO}@test.local`}, ${'5500000000'}, ${utcTs(new Date())}),
           (${ORG_B}, ${'Org B ' + SUFIJO}, ${`b-${SUFIJO}@test.local`}, ${'5500000001'}, ${utcTs(new Date())})`
  await prisma.$executeRaw`
    INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
    VALUES (${VENUE_A}, ${ORG_A}, ${'Venue A ' + SUFIJO}, ${`venue-a-${SUFIJO}`}, ${utcTs(new Date())})`
})

afterEach(async () => {
  // Las dos tablas ENTERAS, no sólo la ficha del fixture: varias pruebas crean una SEGUNDA ficha
  // (unicidad de code/slug/cupón) y dejarla viva rompería la siguiente por un motivo que no es suyo.
  await prisma.$executeRaw`DELETE FROM "LaunchCampaignRedemption"`
  await prisma.$executeRaw`DELETE FROM "LaunchCampaign"`
})

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "Venue" WHERE "id" = ${VENUE_A}`
  await prisma.$executeRaw`DELETE FROM "Organization" WHERE "id" IN (${ORG_A}, ${ORG_B})`
  await prisma.$disconnect()
})

describe('la migración se aplicó y dejó las dos tablas', () => {
  it('existen LaunchCampaign y LaunchCampaignRedemption', async () => {
    const t = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('LaunchCampaign', 'LaunchCampaignRedemption')
      ORDER BY table_name`
    expect(t.map(r => r.table_name)).toEqual(['LaunchCampaign', 'LaunchCampaignRedemption'])
  })

  it('OnboardingProgress ganó las nueve columnas, y NINGUNA es obligatoria sin default', async () => {
    const c = await prisma.$queryRaw<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'OnboardingProgress'
        AND column_name IN ('launchCampaignId','launchCampaignClaimedAt','acquisitionSource','acquisitionUtm',
                            'planActivationStatus','planActivationAttempt','planActivationLeaseUntil',
                            'planActivatedAt','planStripeSubscriptionId')
      ORDER BY column_name`
    expect(c).toHaveLength(9)
    // 🔴 Lo que hace ADITIVA la migración: una fila de alta que ya existe sigue siendo válida.
    // Una columna NOT NULL sin default tumbaría el deploy con filas dentro.
    for (const col of c) expect(col.is_nullable === 'YES' || col.column_default !== null).toBe(true)
  })

  it('planActivationStatus arranca en NONE, que es lo que ya significaba «sin cobro»', async () => {
    const d = await prisma.$queryRaw<{ column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'OnboardingProgress' AND column_name = 'planActivationStatus'`
    expect(d[0].column_default).toContain('NONE')
  })
})

describe('los CHECK de LaunchCampaign rechazan lo que no puede existir', () => {
  it('acepta la ficha del ejemplo de la spec', async () => {
    await expect(insertarCampana()).resolves.toBeDefined()
  })

  it('🔴 un precio por debajo del mínimo de Stripe ($10.00) se rechaza', async () => {
    await expect(insertarCampana({ advertisedPriceCents: 999 })).rejects.toThrow(/LaunchCampaign_price_min/)
    await expect(insertarCampana({ advertisedPriceCents: 1000 })).resolves.toBeDefined()
  })

  it('🔴 una campaña sobre GRATIS o ENTERPRISE se rechaza: no hay qué cobrar', async () => {
    await expect(insertarCampana({ planTier: 'GRATIS' })).rejects.toThrow(/LaunchCampaign_plan_tier_paid/)
    await expect(insertarCampana({ planTier: 'ENTERPRISE' })).rejects.toThrow(/LaunchCampaign_plan_tier_paid/)
    await expect(insertarCampana({ planTier: 'PREMIUM' })).resolves.toBeDefined()
  })

  it('🔴 el conteo NUNCA puede pasarse del cupo — el RESPALDO de la carrera', async () => {
    await expect(insertarCampana({ redemptionCap: 5, redemptionCount: 6 })).rejects.toThrow(/LaunchCampaign_count_in_cap/)
    await expect(insertarCampana({ redemptionCap: 5, redemptionCount: 5 })).resolves.toBeDefined()
  })

  it('🔴 un UPDATE que intente pasarse del cupo también rebota', async () => {
    await insertarCampana({ redemptionCap: 2, redemptionCount: 2 })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "redemptionCount" = "redemptionCount" + 1 WHERE "id" = ${CAMPAIGN}`,
    ).rejects.toThrow(/LaunchCampaign_count_in_cap/)
  })

  it('un cupo de cero o negativo se rechaza', async () => {
    await expect(insertarCampana({ redemptionCap: 0 })).rejects.toThrow(/LaunchCampaign_cap_positive/)
  })

  it('los meses de promoción viven entre 1 y 24', async () => {
    await expect(insertarCampana({ discountMonths: 0 })).rejects.toThrow(/LaunchCampaign_months_range/)
    await expect(insertarCampana({ discountMonths: 25 })).rejects.toThrow(/LaunchCampaign_months_range/)
  })

  it('una ventana invertida se rechaza', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LaunchCampaign" ("id","code","name","landingSlug","planTier","advertisedPriceCents",
          "discountMonths","currency","redemptionCap","redemptionCount","status","validFrom","validUntil","updatedAt")
        VALUES (${CAMPAIGN}, ${'X-' + SUFIJO}, ${'x'}, ${'x-' + SUFIJO}, 'PRO'::"PlanTier", 2200, 3, 'MXN', 10, 0,
          'DRAFT'::"LaunchCampaignStatus", ${utcTs(VALID_UNTIL)}, ${utcTs(VALID_FROM)}, ${utcTs(new Date())})`,
    ).rejects.toThrow(/LaunchCampaign_window/)
  })

  it('sólo se vende en pesos', async () => {
    await expect(insertarCampana({ currency: 'USD' })).rejects.toThrow(/LaunchCampaign_currency_mxn/)
  })

  it('🔴 los tres importes congelados no pueden contradecirse: lista − descuento = anunciado', async () => {
    await expect(
      insertarCampana({ listPriceCentsSnapshot: 115884, discountAmountCents: 100000, advertisedPriceCents: 2200 }),
    ).rejects.toThrow(/LaunchCampaign_discount_consistent/)
    await expect(
      insertarCampana({ listPriceCentsSnapshot: 115884, discountAmountCents: 113684, advertisedPriceCents: 2200 }),
    ).resolves.toBeDefined()
  })

  it('un descuento sin precio de lista congelado se rechaza', async () => {
    await expect(insertarCampana({ discountAmountCents: 113684, listPriceCentsSnapshot: null })).rejects.toThrow(
      /LaunchCampaign_discount_consistent/,
    )
  })

  it('🔴 una ficha ACTIVE sin cupón de Stripe se rechaza: anunciaría un precio que nadie va a descontar', async () => {
    await expect(
      insertarCampana({ status: 'ACTIVE', listPriceCentsSnapshot: 115884, discountAmountCents: 113684, stripeCouponId: null }),
    ).rejects.toThrow(/LaunchCampaign_active_has_coupon/)
    await expect(
      insertarCampana({
        status: 'ACTIVE',
        listPriceCentsSnapshot: 115884,
        discountAmountCents: 113684,
        stripeCouponId: `LC_POS22_V1_${SUFIJO}`,
      }),
    ).resolves.toBeDefined()
  })

  it('una ficha DRAFT sí puede no tener cupón todavía', async () => {
    await expect(insertarCampana({ status: 'DRAFT', stripeCouponId: null })).resolves.toBeDefined()
  })
})

describe('los CHECK de LaunchCampaignRedemption', () => {
  beforeEach(async () => {
    await insertarCampana()
  })

  it('acepta una reserva con el snapshot cuadrado', async () => {
    await expect(insertarRedencion()).resolves.toBeDefined()
  })

  it('🔴 un snapshot que no cuadra se rechaza: se cobraría un precio y se anunciaría otro', async () => {
    await expect(insertarRedencion({ listPriceCents: 115884, discountAmountCents: 113684, advertisedPriceCents: 9999 })).rejects.toThrow(
      /LaunchCampaignRedemption_amounts/,
    )
  })

  it('🔴 APPLIED sin suscripción de Stripe se rechaza: nada probaría el cobro', async () => {
    await expect(insertarRedencion({ status: 'APPLIED', stripeSubscriptionId: null, appliedAt: new Date() })).rejects.toThrow(
      /LaunchCampaignRedemption_applied/,
    )
    await expect(insertarRedencion({ status: 'APPLIED', stripeSubscriptionId: null, appliedAt: null })).rejects.toThrow(
      /LaunchCampaignRedemption_applied/,
    )
    await expect(
      insertarRedencion({ status: 'APPLIED', stripeSubscriptionId: `sub_${SUFIJO}`, appliedAt: new Date() }),
    ).resolves.toBeDefined()
  })

  it('RELEASED sin fecha de liberación se rechaza', async () => {
    await expect(insertarRedencion({ status: 'RELEASED', releasedAt: null })).rejects.toThrow(/LaunchCampaignRedemption_released/)
    await expect(insertarRedencion({ status: 'RELEASED', releasedAt: new Date() })).resolves.toBeDefined()
  })

  it('dos redenciones no pueden compartir suscripción de Stripe', async () => {
    await insertarRedencion({ status: 'APPLIED', stripeSubscriptionId: `sub_dup_${SUFIJO}`, appliedAt: new Date() })
    await expect(
      insertarRedencion({
        organizationId: ORG_B,
        status: 'APPLIED',
        stripeSubscriptionId: `sub_dup_${SUFIJO}`,
        appliedAt: new Date(),
      }),
    ).rejects.toThrow(/stripeSubscriptionId/)
  })
})

describe('🔴 el índice único PARCIAL — a lo más UN lugar vivo por organización', () => {
  /**
   * 🔴 Por qué estas pruebas no comprueban el NOMBRE del índice en el mensaje: Prisma, en una
   * consulta cruda, sólo devuelve el SQLSTATE (`23505`) y la columna en conflicto — el nombre del
   * índice se queda en el `detail` de Postgres. Así que el nombre lo fija su propia prueba
   * (`indexdef`), y aquí se comprueba que la escritura REBOTA.
   *
   * 🔴 Y lo que distingue este índice PARCIAL de un `@unique` a secas es el caso de las N filas
   * RELEASED conviviendo: con un `@unique` normal, ese caso sería imposible. Las dos pruebas
   * juntas son la demostración; ninguna lo es por separado.
   */
  const violaUnicidadDeOrganizacion = async (p: Promise<unknown>) => {
    await expect(p).rejects.toThrow(/23505/)
    await expect(p.catch(e => Promise.reject(e))).rejects.toThrow(/organizationId/)
  }

  beforeEach(async () => {
    await insertarCampana()
  })

  it('una segunda RESERVED de la MISMA organización se rechaza', async () => {
    await insertarRedencion({ organizationId: ORG_A })
    await violaUnicidadDeOrganizacion(insertarRedencion({ organizationId: ORG_A }))
  })

  it('RESERVED y APPLIED cuentan las dos como vivas: no pueden convivir', async () => {
    await insertarRedencion({ organizationId: ORG_A, status: 'RESERVED' })
    await violaUnicidadDeOrganizacion(
      insertarRedencion({ organizationId: ORG_A, status: 'APPLIED', stripeSubscriptionId: `sub_x_${SUFIJO}`, appliedAt: new Date() }),
    )
  })

  it('🔴 N filas RELEASED SÍ conviven — es la historia de qué campaña trajo a este cliente', async () => {
    for (let i = 0; i < 4; i++) {
      await insertarRedencion({ organizationId: ORG_A, status: 'RELEASED', releasedAt: new Date() })
    }
    const n = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "LaunchCampaignRedemption" WHERE "organizationId" = ${ORG_A}`
    expect(Number(n[0].c)).toBe(4)
  })

  it('🔴 tras liberar el intento anterior se puede volver a intentar — y la historia NO se muta', async () => {
    await insertarRedencion({ organizationId: ORG_A, status: 'RELEASED', releasedAt: new Date() })
    await expect(insertarRedencion({ organizationId: ORG_A, status: 'RESERVED' })).resolves.toBeDefined()
    const n = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "LaunchCampaignRedemption" WHERE "organizationId" = ${ORG_A}`
    expect(Number(n[0].c)).toBe(2)
  })

  it('el candado es POR organización: otra organización no queda bloqueada', async () => {
    await insertarRedencion({ organizationId: ORG_A })
    await expect(insertarRedencion({ organizationId: ORG_B })).resolves.toBeDefined()
  })

  it('el índice existe con su predicado exacto, para que nadie lo borre creyendo que sobra', async () => {
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'LaunchCampaignRedemption_org_live_unique'`
    expect(idx).toHaveLength(1)
    expect(idx[0].indexdef).toMatch(/UNIQUE/)
    expect(idx[0].indexdef).toMatch(/WHERE \(status <> 'RELEASED'/)
  })
})

describe('las llaves foráneas', () => {
  beforeEach(async () => {
    await insertarCampana()
  })

  it('🔴 RESTRICT: una ficha con redenciones NO se puede borrar — se perdería el rastro del dinero', async () => {
    await insertarRedencion()
    await expect(prisma.$executeRaw`DELETE FROM "LaunchCampaign" WHERE "id" = ${CAMPAIGN}`).rejects.toThrow(/campaignId_fkey|foreign key/i)
  })

  it('🔴 RESTRICT: una organización con redenciones tampoco', async () => {
    await insertarRedencion({ organizationId: ORG_B })
    await expect(prisma.$executeRaw`DELETE FROM "Organization" WHERE "id" = ${ORG_B}`).rejects.toThrow(/organizationId_fkey|foreign key/i)
  })

  it('SET NULL: borrar el local deja la redención viva y sin venue', async () => {
    const r = await insertarRedencion({ venueId: VENUE_A })
    await prisma.$executeRaw`DELETE FROM "Venue" WHERE "id" = ${VENUE_A}`
    const filas = await prisma.$queryRaw<{ venueId: string | null }[]>`
      SELECT "venueId" FROM "LaunchCampaignRedemption" WHERE "id" = ${r.id}`
    expect(filas).toHaveLength(1)
    expect(filas[0].venueId).toBeNull()
    // Se repone para las pruebas siguientes.
    await prisma.$executeRaw`
      INSERT INTO "Venue" ("id","organizationId","name","slug","updatedAt")
      VALUES (${VENUE_A}, ${ORG_A}, ${'Venue A ' + SUFIJO}, ${`venue-a-${SUFIJO}`}, ${utcTs(new Date())})`
  })

  it('una redención no puede apuntar a una campaña inexistente', async () => {
    await expect(insertarRedencion({ campaignId: 'no-existe' })).rejects.toThrow(/campaignId_fkey|foreign key/i)
  })

  it('SET NULL: borrar la campaña reclamada deja el alta viva sin campaña', async () => {
    const orgC = `org-c-${SUFIJO}`
    await prisma.$executeRaw`
      INSERT INTO "Organization" ("id","name","email","phone","updatedAt")
      VALUES (${orgC}, ${'Org C'}, ${`c-${SUFIJO}@test.local`}, ${'5500000002'}, ${utcTs(new Date())})`
    await prisma.$executeRaw`
      INSERT INTO "OnboardingProgress" ("id","organizationId","completedSteps","launchCampaignId","updatedAt")
      VALUES (${`prog-${SUFIJO}`}, ${orgC}, ${'[]'}::jsonb, ${CAMPAIGN}, ${utcTs(new Date())})`
    await prisma.$executeRaw`DELETE FROM "LaunchCampaign" WHERE "id" = ${CAMPAIGN}`
    const p = await prisma.$queryRaw<{ launchCampaignId: string | null }[]>`
      SELECT "launchCampaignId" FROM "OnboardingProgress" WHERE "id" = ${`prog-${SUFIJO}`}`
    expect(p[0].launchCampaignId).toBeNull()
    await prisma.$executeRaw`DELETE FROM "OnboardingProgress" WHERE "id" = ${`prog-${SUFIJO}`}`
    await prisma.$executeRaw`DELETE FROM "Organization" WHERE "id" = ${orgC}`
  })
})

describe('🔴 la reserva del cupo es ATÓMICA — dos transacciones concurrentes, sin sleeps', () => {
  /**
   * El patrón que el servicio de la fase S8 va a usar, y que se prueba AQUÍ porque su garantía
   * vive en Postgres, no en TypeScript:
   *
   *   UPDATE "LaunchCampaign" SET "redemptionCount" = "redemptionCount" + 1
   *   WHERE id = $1 AND "redemptionCount" < "redemptionCap"
   *
   * Con cupo 1 y dos transacciones a la vez, la segunda se BLOQUEA en el candado de fila de la
   * primera; al commitear la primera, Postgres (READ COMMITTED) reevalúa el WHERE sobre la fila
   * nueva y el UPDATE afecta CERO filas. Un leer-y-luego-escribir daría DOS ganadores —el defecto
   * que `coupon.dashboard.service.ts` ya tiene documentado.
   *
   * 🔴 La espera se hace mirando `pg_stat_activity` (¿está de verdad bloqueada?), NUNCA con un
   * sleep: un sleep pasa también cuando no hubo bloqueo, así que no probaría nada.
   */
  const url = process.env.TEST_DATABASE_URL as string
  let a: PrismaClient
  let b: PrismaClient

  beforeAll(() => {
    a = new PrismaClient({ datasources: { db: { url } } })
    b = new PrismaClient({ datasources: { db: { url } } })
  })

  afterAll(async () => {
    await a.$disconnect()
    await b.$disconnect()
  })

  /** Poll de una CONDICIÓN, no un sleep: si la condición no se cumple, la prueba FALLA. */
  async function esperarA(condicion: () => Promise<boolean> | boolean, queEsperaba: string): Promise<void> {
    for (let i = 0; i < 600; i++) {
      if (await condicion()) return
      await new Promise(res => setTimeout(res, 10))
    }
    throw new Error(`nunca ocurrió: ${queEsperaba}`)
  }

  /**
   * 🔴 Se espera a que la segunda transacción esté REALMENTE bloqueada en el candado de fila,
   * preguntándoselo a `pg_stat_activity` — no a que «haya pasado un rato». Un sleep pasaría
   * también cuando no hubo bloqueo ninguno, y entonces la prueba no probaría la atomicidad:
   * probaría que dos UPDATEs separados en el tiempo no chocan, que es otra cosa.
   */
  async function esperarBloqueoDeFila(pid: number): Promise<void> {
    await esperarA(async () => {
      const r = await prisma.$queryRaw<{ wait_event_type: string | null; state: string }[]>`
        SELECT wait_event_type, state FROM pg_stat_activity WHERE pid = ${pid}`
      return r[0]?.wait_event_type === 'Lock'
    }, `la transacción (pid ${pid}) quedó bloqueada esperando el candado de fila`)

    // Y que el candado que espera sea de verdad uno NO concedido sobre una tupla/fila.
    const bloqueos = await prisma.$queryRaw<{ locktype: string }[]>`
      SELECT locktype FROM pg_locks WHERE pid = ${pid} AND NOT granted`
    expect(bloqueos.length).toBeGreaterThan(0)
  }

  it('con cupo 1, exactamente UNA de dos reservas concurrentes gana', async () => {
    await insertarCampana({ redemptionCap: 1, redemptionCount: 0 })

    let soltarA: () => void = () => {}
    const puertaA = new Promise<void>(res => {
      soltarA = res
    })
    let aYaReservo: () => void = () => {}
    const aReservo = new Promise<void>(res => {
      aYaReservo = res
    })

    let ganadasA = 0
    const txA = a.$transaction(
      async tx => {
        ganadasA = await tx.$executeRaw`
          UPDATE "LaunchCampaign" SET "redemptionCount" = "redemptionCount" + 1
          WHERE "id" = ${CAMPAIGN} AND "redemptionCount" < "redemptionCap"`
        aYaReservo()
        await puertaA // se queda con el candado de fila tomado hasta que B esté bloqueada
      },
      { timeout: 30000, maxWait: 30000 },
    )

    await aReservo
    expect(ganadasA).toBe(1)

    let ganadasB = -1
    let pidB = 0
    const txB = b.$transaction(
      async tx => {
        const p = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`
        pidB = p[0].pid
        ganadasB = await tx.$executeRaw`
          UPDATE "LaunchCampaign" SET "redemptionCount" = "redemptionCount" + 1
          WHERE "id" = ${CAMPAIGN} AND "redemptionCount" < "redemptionCap"`
      },
      { timeout: 30000, maxWait: 30000 },
    )

    try {
      await esperarA(() => pidB > 0, 'la segunda transacción abrió su conexión')
      await esperarBloqueoDeFila(pidB)
    } finally {
      // Pase lo que pase, A tiene que commitear: una transacción colgada dejaría la fila
      // bloqueada y tumbaría la prueba SIGUIENTE con un error que no se parece a su causa.
      soltarA()
    }
    await txA
    await txB

    // 🔴 El veredicto: B reevaluó el WHERE tras el commit de A y NO tocó ninguna fila.
    expect(ganadasB).toBe(0)

    const fila = await prisma.$queryRaw<{ redemptionCount: number; redemptionCap: number }[]>`
      SELECT "redemptionCount", "redemptionCap" FROM "LaunchCampaign" WHERE "id" = ${CAMPAIGN}`
    expect(fila[0].redemptionCount).toBe(1)
    expect(fila[0].redemptionCount).toBeLessThanOrEqual(fila[0].redemptionCap)
  })

  it('🔴 con cupo 3 y 10 reservas a la vez, ganan EXACTAMENTE 3 y el conteo queda en 3', async () => {
    await insertarCampana({ redemptionCap: 3, redemptionCount: 0 })

    const clientes = Array.from({ length: 10 }, () => new PrismaClient({ datasources: { db: { url } } }))
    try {
      const resultados = await Promise.all(
        clientes.map(
          c =>
            c.$executeRaw`
            UPDATE "LaunchCampaign" SET "redemptionCount" = "redemptionCount" + 1
            WHERE "id" = ${CAMPAIGN} AND "redemptionCount" < "redemptionCap"`,
        ),
      )
      expect(resultados.filter(n => n === 1)).toHaveLength(3)
      expect(resultados.filter(n => n === 0)).toHaveLength(7)
    } finally {
      await Promise.all(clientes.map(c => c.$disconnect()))
    }

    const fila = await prisma.$queryRaw<{ redemptionCount: number }[]>`
      SELECT "redemptionCount" FROM "LaunchCampaign" WHERE "id" = ${CAMPAIGN}`
    expect(fila[0].redemptionCount).toBe(3)
  })
})

// ============================================================================
// Cierre de la revisión independiente del 2026-09-17 (P2-2, P2-4, P3-2, P3-3, P3-4, P3-6).
// ============================================================================

describe('🔴 P2-2 · el SNAPSHOT del dinero tiene los mismos candados que la ficha', () => {
  /**
   * Medido el 2026-09-17 contra una base desechable: la ficha tenía NUEVE CHECK y la redención
   * —que es el retrato de lo que el cliente CONSINTIÓ, y de donde se arma el correo de
   * confirmación— tenía TRES. Las cinco escrituras de abajo fueron ACEPTADAS.
   */
  beforeEach(async () => {
    await insertarCampana()
  })

  it('🔴 un precio por debajo del mínimo de Stripe se rechaza también aquí', async () => {
    await expect(insertarRedencion({ advertisedPriceCents: 1, listPriceCents: 1200, discountAmountCents: 1199 })).rejects.toThrow(
      /LaunchCampaignRedemption_amounts/,
    )
    await expect(
      insertarRedencion({ advertisedPriceCents: 1000, listPriceCents: 115884, discountAmountCents: 114884 }),
    ).resolves.toBeDefined()
  })

  it('🔴 un descuento NEGATIVO se rechaza: el cliente pagaría MÁS que el precio de lista', async () => {
    // 1200 − (−1000) = 2200, así que la igualdad de los tres importes se cumple y el CHECK viejo
    // lo dejaba pasar. Lo que no puede existir es un «descuento» que sube el precio.
    await expect(insertarRedencion({ listPriceCents: 1200, discountAmountCents: -1000, advertisedPriceCents: 2200 })).rejects.toThrow(
      /LaunchCampaignRedemption_amounts/,
    )
  })

  it('🔴 los meses viven entre 1 y 24, igual que en la ficha', async () => {
    for (const discountMonths of [0, -5, 999]) {
      await expect(insertarRedencion({ discountMonths })).rejects.toThrow(/LaunchCampaignRedemption_months_range/)
    }
    await expect(insertarRedencion({ discountMonths: 24 })).resolves.toBeDefined()
  })

  it('🔴 una redención sobre un plan GRATIS o ENTERPRISE se rechaza: no hay qué cobrar', async () => {
    await expect(insertarRedencion({ planTier: 'GRATIS' })).rejects.toThrow(/LaunchCampaignRedemption_plan_tier_paid/)
    await expect(insertarRedencion({ planTier: 'ENTERPRISE' })).rejects.toThrow(/LaunchCampaignRedemption_plan_tier_paid/)
  })

  it('🔴 un cupón VACÍO se rechaza: sin él nada descuenta en Stripe', async () => {
    await expect(insertarRedencion({ stripeCouponId: '' })).rejects.toThrow(/LaunchCampaignRedemption_coupon_present/)
    await expect(insertarRedencion({ stripeCouponId: '   ' })).rejects.toThrow(/LaunchCampaignRedemption_coupon_present/)
  })
})

describe('🔴 P2-4 · una ficha con cupón en Stripe NO cambia de precio', () => {
  /**
   * Medido: sobre una ficha ACTIVE **con una redención viva**, las cuatro mutaciones pasaban —
   * precio anunciado, descuento, `code`, `landingSlug`, `offerVersion` y hasta el propio cupón.
   * El cupón de Stripe ya nació con su `amount_off`, así que después de esa edición Stripe cobra
   * `lista − descuentoViejo` mientras `/oferta/<slug>` anuncia el número nuevo.
   *
   * 🔴 Un CHECK no puede expresar inmutabilidad (no ve el valor ANTERIOR): es un trigger. El
   * candado se cierra cuando EXISTE el cupón, no cuando el estado es ACTIVE — un `_active_has_coupon`
   * obliga a que ACTIVE lo tenga, pero una ficha PAUSED también conserva su cupón vivo en Stripe.
   */
  const CUPON = `LC_FROZEN_${SUFIJO}`
  const activa = () =>
    insertarCampana({ status: 'ACTIVE', listPriceCentsSnapshot: 115884, discountAmountCents: 113684, stripeCouponId: CUPON })

  const noSePuede = (sql: Promise<unknown>) => expect(sql).rejects.toThrow(/LaunchCampaign_terms_frozen/)

  it('🔴 el precio anunciado y el descuento quedan congelados', async () => {
    await activa()
    await noSePuede(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "advertisedPriceCents" = 9900, "discountAmountCents" = 105984 WHERE "id" = ${CAMPAIGN}`,
    )
    const f = await prisma.$queryRaw<{ advertisedPriceCents: number }[]>`
      SELECT "advertisedPriceCents" FROM "LaunchCampaign" WHERE "id" = ${CAMPAIGN}`
    expect(f[0].advertisedPriceCents).toBe(2200)
  })

  it('🔴 el código, el slug del anuncio y la versión de la oferta también', async () => {
    await activa()
    await noSePuede(prisma.$executeRaw`UPDATE "LaunchCampaign" SET "code" = ${'OTRO-' + SUFIJO} WHERE "id" = ${CAMPAIGN}`)
    await noSePuede(prisma.$executeRaw`UPDATE "LaunchCampaign" SET "landingSlug" = ${'otro-' + SUFIJO} WHERE "id" = ${CAMPAIGN}`)
    await noSePuede(prisma.$executeRaw`UPDATE "LaunchCampaign" SET "offerVersion" = 7 WHERE "id" = ${CAMPAIGN}`)
  })

  it('🔴 y el propio cupón: cambiarlo re-precia la campaña en silencio', async () => {
    await activa()
    await noSePuede(prisma.$executeRaw`UPDATE "LaunchCampaign" SET "stripeCouponId" = ${'OTRO_' + SUFIJO} WHERE "id" = ${CAMPAIGN}`)
  })

  it('lo que SÍ se puede tocar con la campaña viva: pausar, alargar la ventana, subir el cupo y el copy', async () => {
    await activa()
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "status" = 'PAUSED', "statusReason" = 'pausa manual' WHERE "id" = ${CAMPAIGN}`,
    ).resolves.toBeDefined()
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "validUntil" = ${utcTs(new Date('2026-12-31T06:00:00.000Z'))} WHERE "id" = ${CAMPAIGN}`,
    ).resolves.toBeDefined()
    await expect(prisma.$executeRaw`UPDATE "LaunchCampaign" SET "redemptionCap" = 500 WHERE "id" = ${CAMPAIGN}`).resolves.toBeDefined()
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "headline" = 'Otro titular' WHERE "id" = ${CAMPAIGN}`,
    ).resolves.toBeDefined()
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "redemptionCount" = "redemptionCount" + 1 WHERE "id" = ${CAMPAIGN}`,
    ).resolves.toBeDefined()
  })

  it('🔴 un BORRADOR sin cupón sí se edita entero — si no, el superadmin no podría corregir una errata', async () => {
    await insertarCampana({ status: 'DRAFT', stripeCouponId: null })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaign" SET "advertisedPriceCents" = 2320, "code" = ${'NUEVO-' + SUFIJO} WHERE "id" = ${CAMPAIGN}`,
    ).resolves.toBeDefined()
  })

  it('🔴 y la ACTIVACIÓN misma pasa: es el UPDATE que ESTRENA el cupón, no uno que lo cambia', async () => {
    await insertarCampana({ status: 'DRAFT', stripeCouponId: null })
    await expect(
      prisma.$executeRaw`
        UPDATE "LaunchCampaign"
        SET "status" = 'ACTIVE', "listPriceCentsSnapshot" = 115884, "discountAmountCents" = 113684,
            "stripeCouponId" = ${'LC_ACT_' + SUFIJO}, "stripePriceId" = ${'price_' + SUFIJO}, "activatedAt" = ${utcTs(new Date())}
        WHERE "id" = ${CAMPAIGN}`,
    ).resolves.toBeDefined()
  })
})

describe('🔴 P3-4 · liberar dos veces la misma redención sobrevendería el cupo', () => {
  /**
   * El cupo se descuenta del CONTADOR, no de las filas (§ 7.3): liberar hace
   * `redemptionCount = redemptionCount - 1`. Si el mismo intento se libera DOS veces, el contador
   * baja dos y entra un cliente de más. Medido: la segunda liberación sobre una fila ya RELEASED
   * era ACEPTADA, y también `APPLIED → RELEASED` — o sea soltar el cupo de alguien a quien Stripe
   * YA le cobró.
   *
   * 🔴 Esto NO sustituye al CAS que S8 debe escribir (`WHERE id = $1 AND status = 'RESERVED'`, y
   * decrementar sólo si afectó 1 fila): lo vuelve OBLIGATORIO, porque la forma insegura ahora
   * revienta en vez de pasar en silencio.
   */
  beforeEach(async () => {
    await insertarCampana()
  })

  it('🔴 RELEASED es TERMINAL: no se puede volver a liberar ni re-sellar la fecha', async () => {
    const r = await insertarRedencion({ status: 'RESERVED' })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaignRedemption" SET "status" = 'RELEASED', "releasedAt" = ${utcTs(new Date('2026-09-17T10:00:00.000Z'))} WHERE "id" = ${r.id}`,
    ).resolves.toBeDefined()
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaignRedemption" SET "status" = 'RELEASED', "releasedAt" = ${utcTs(new Date('2026-09-17T11:00:00.000Z'))} WHERE "id" = ${r.id}`,
    ).rejects.toThrow(/LaunchCampaignRedemption_released_is_terminal/)
  })

  it('🔴 una liberada NO revive como reserva: volvería a consumir cupo con su historia borrada', async () => {
    const r = await insertarRedencion({ status: 'RELEASED', releasedAt: new Date() })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaignRedemption" SET "status" = 'RESERVED', "releasedAt" = NULL WHERE "id" = ${r.id}`,
    ).rejects.toThrow(/LaunchCampaignRedemption_released_is_terminal/)
  })

  it('🔴 APPLIED no se libera: Stripe ya cobró, y soltar su cupo se lo daría a otro cliente', async () => {
    const r = await insertarRedencion({ status: 'APPLIED', stripeSubscriptionId: `sub_ap_${SUFIJO}`, appliedAt: new Date() })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaignRedemption" SET "status" = 'RELEASED', "releasedAt" = ${utcTs(new Date())} WHERE "id" = ${r.id}`,
    ).rejects.toThrow(/LaunchCampaignRedemption_applied_is_terminal/)
  })

  it('el camino normal NO se estorba: reservar → aplicar, y una reserva se puede corregir', async () => {
    const r = await insertarRedencion({ status: 'RESERVED' })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaignRedemption" SET "lastError" = 'tarjeta rechazada' WHERE "id" = ${r.id}`,
    ).resolves.toBeDefined()
    await expect(
      prisma.$executeRaw`
        UPDATE "LaunchCampaignRedemption" SET "status" = 'APPLIED', "stripeSubscriptionId" = ${'sub_ok_' + SUFIJO},
          "appliedAt" = ${utcTs(new Date())} WHERE "id" = ${r.id}`,
    ).resolves.toBeDefined()
  })

  it('y una RESERVED sí se puede liberar (es el camino de la tarjeta rechazada)', async () => {
    const r = await insertarRedencion({ status: 'RESERVED' })
    await expect(
      prisma.$executeRaw`UPDATE "LaunchCampaignRedemption" SET "status" = 'RELEASED', "releasedAt" = ${utcTs(new Date())} WHERE "id" = ${r.id}`,
    ).resolves.toBeDefined()
  })
})

describe('🔴 P3-2 y P3-6 · lo que llega a la URL pública y al payload cacheado tiene forma', () => {
  /**
   * Medido: `landingSlug` aceptaba `''`, `'../../etc/passwd'` y `'POS 22 MAYUS'`. La ruta pública
   * valida el slug con su propio regex, así que una ficha creada así queda **inalcanzable** en
   * `/oferta/<slug>` — y nadie se entera hasta que el anuncio está vivo y los clics dan 404.
   * Y el copy no tenía tope, yendo directo a un payload público cacheado en CDN.
   */
  it('🔴 un slug que la ruta pública no puede servir se rechaza al escribirlo', async () => {
    for (const landingSlug of ['', '../../etc/passwd', 'POS 22 MAYUS', 'con espacios', 'doble--guion', '-empieza', 'termina-']) {
      await expect(insertarCampana({ landingSlug })).rejects.toThrow(/LaunchCampaign_landing_slug_shape/)
    }
    await expect(insertarCampana({ landingSlug: 'pos-22-lanzamiento' })).resolves.toBeDefined()
  })

  it('un código o un nombre vacíos se rechazan', async () => {
    await expect(insertarCampana({ code: '' })).rejects.toThrow(/LaunchCampaign_code_present/)
    await expect(insertarCampana({ code: '   ' })).rejects.toThrow(/LaunchCampaign_code_present/)
    await expect(insertarCampana({ name: '' })).rejects.toThrow(/LaunchCampaign_name_present/)
  })

  it('🔴 el copy tiene tope: 200 caracteres por renglón, 8 viñetas y 1,600 en total', async () => {
    await expect(insertarCampana({ headline: 'x'.repeat(201) })).rejects.toThrow(/LaunchCampaign_copy_length/)
    await expect(insertarCampana({ subheadline: 'x'.repeat(201) })).rejects.toThrow(/LaunchCampaign_copy_length/)
    await expect(insertarCampana({ bullets: Array.from({ length: 9 }, (_, i) => `b${i}`) })).rejects.toThrow(
      /LaunchCampaign_bullets_bounded/,
    )
    // 🔴 El tope que de verdad protege el payload NO es el número de viñetas sino su LARGO TOTAL:
    // 8 viñetas sin límite de longitud siguen siendo ilimitadas. Un CHECK no puede medir el
    // elemento más largo de un arreglo (una subconsulta no está permitida), así que se acota la
    // suma — `array_to_string`, que es IMMUTABLE y por eso sí cabe en un CHECK.
    await expect(insertarCampana({ bullets: ['x'.repeat(1601)] })).rejects.toThrow(/LaunchCampaign_bullets_bounded/)
    await expect(
      insertarCampana({
        headline: 'x'.repeat(200),
        subheadline: 'y'.repeat(200),
        bullets: Array.from({ length: 8 }, () => 'z'.repeat(200)),
      }),
    ).resolves.toBeDefined()
  })
})

describe('🔴 P3-3 · los índices ÚNICOS que nadie estaba probando', () => {
  /**
   * Los saboteé en una base desechable y las 34 pruebas seguían verdes. El de `stripeCouponId` es
   * el que cuesta dinero: sin él, dos fichas comparten un cupón de Stripe y el cupo de una
   * descuenta a través de la otra.
   */
  it('🔴 dos fichas NO pueden compartir el cupón de Stripe', async () => {
    const cupon = `LC_DUP_${SUFIJO}`
    await insertarCampana({ status: 'ACTIVE', listPriceCentsSnapshot: 115884, discountAmountCents: 113684, stripeCouponId: cupon })
    await expect(
      insertarCampana({
        id: `otra-${SUFIJO}`,
        code: `OTRA-${SUFIJO}`,
        landingSlug: `otra-${SUFIJO}`,
        status: 'ACTIVE',
        listPriceCentsSnapshot: 115884,
        discountAmountCents: 113684,
        stripeCouponId: cupon,
      }),
    ).rejects.toThrow(/stripeCouponId/)
  })

  it('dos fichas no comparten `code`', async () => {
    const v = await insertarCampana()
    await expect(insertarCampana({ id: `otra-${SUFIJO}`, code: v.code, landingSlug: `otra-${SUFIJO}` })).rejects.toThrow(/code/)
  })

  it('dos fichas no comparten el slug del anuncio: la URL pública tiene que resolver a UNA', async () => {
    const v = await insertarCampana()
    await expect(insertarCampana({ id: `otra-${SUFIJO}`, code: `OTRA-${SUFIJO}`, landingSlug: v.landingSlug })).rejects.toThrow(
      /landingSlug/,
    )
  })

  it('el alta lleva índice por campaña reclamada (es como el superadmin cuenta las altas de un anuncio)', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'OnboardingProgress' AND indexname = 'OnboardingProgress_launchCampaignId_idx'`
    expect(idx).toHaveLength(1)
  })
})
