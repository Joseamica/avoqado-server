/**
 * «Clientes» legible (plan C1, task 2): what each organization uses, its plan level and whether it charges, from ONE SQL
 * expression (`clientFactsLateral`), against a real Postgres. Only the database can prove that enum literals compare, that
 * the 30-day window is inclusive to the second, that a demo venue's sample sales never count, and — the redesign after
 * Codex r3 — that the level is EXACTLY the platform's: `getVenuePlanInfo(venue).tier` on every plan state its writers
 * leave, `daAcceso` row by row and the commercial grant of `getContractBaseTier`.
 *
 * Every organization is this file's own (one per case) and every query reads them by id, so other suites sharing the
 * database never move a result. `now` is fixed; the canonical functions read the real clock, so their parity runs with
 * only `Date` simulated at that `now` (Prisma keeps its real timers).
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/clientes-legible.integration.test.ts --ci
 */
import {
  OrderSource,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  Prisma,
  TerminalType,
  TransactionStatus,
  VenueStatus,
} from '@prisma/client'
import { daAcceso } from '@/services/access/ventanaDeAcceso'
import { getVenueBaseTier, getVenuePlanInfo } from '@/services/access/basePlan.service'
import { clientFactsLateral, concesionComercialSql, ventanaDeAccesoSql } from '@/services/crm/clientFacts'
import prisma from '@/utils/prismaClient'

const suffix = `cfacts${Date.now()}`
const NOW = new Date('2026-11-06T18:00:00.000Z')
const DAY = 86_400_000
const hace = (ms: number) => new Date(NOW.getTime() - ms)
const dentroDe = (ms: number) => new Date(NOW.getTime() + ms)

const organizationIds: string[] = []
const venueIds: string[] = []
/** A commercial contract cannot be deleted (its purchase is immutable): it is ended, and its venue stays. */
const hybridContractIds: string[] = []
let staffId: string
let planProId: string
let planPremiumId: string
let n = 0

type Facts = {
  id: string
  usaTerminal: boolean
  usaPos: boolean
  ultimoCobroAt: Date | null
  usaMedido: string
  nivel: string
  estado: string
}

async function factsOf(ids: string[]): Promise<Map<string, Facts>> {
  const rows = await prisma.$queryRaw<Facts[]>(
    Prisma.sql`SELECT o."id", f.* FROM "Organization" o ${clientFactsLateral(NOW)} WHERE o."id" IN (${Prisma.join(ids)})`,
  )
  return new Map(rows.map(row => [row.id, row]))
}
const factOf = async (id: string) => (await factsOf([id])).get(id)!

async function org(over: { onboardingCompletedAt?: Date } = {}) {
  const key = `${suffix}${++n}`
  const { id } = await prisma.organization.create({
    data: { name: `Org ${key}`, email: `org-${key}@test.mx`, phone: '5555555555', ...over },
  })
  organizationIds.push(id)
  return id
}

async function venue(organizationId: string, over: { status?: VenueStatus; demoExpiresAt?: Date; seatCapExempt?: boolean } = {}) {
  const key = `${suffix}${++n}`
  const { id } = await prisma.venue.create({
    data: { organizationId, name: `Negocio ${key}`, slug: `v-${key}`, status: over.status ?? VenueStatus.ACTIVE, ...over },
  })
  venueIds.push(id)
  return id
}

/** An organization with one real venue. */
async function orgWithVenue(over: { seatCapExempt?: boolean } = {}) {
  const organizationId = await org()
  return { organizationId, venueId: await venue(organizationId, over) }
}

async function terminal(venueId: string, type: TerminalType) {
  const key = `${suffix}${++n}`
  return (await prisma.terminal.create({ data: { venueId, name: `T ${key}`, type, serialNumber: `SN-${key}` } })).id
}

async function reservation(venueId: string) {
  const key = `${suffix}${++n}`
  const startsAt = new Date(NOW.getTime() - 3 * DAY - n * 3_600_000)
  const endsAt = new Date(startsAt.getTime() + 3_000_000)
  return (
    await prisma.reservation.create({
      data: {
        venueId,
        confirmationCode: `R-${key}`,
        status: 'CHECKED_IN',
        startsAt,
        endsAt,
        duration: 50,
        blockedEndsAt: endsAt,
        partySize: 1,
      },
    })
  ).id
}

/**
 * An order and (unless `payment: null`) its charge. Defaults: charged in cash 3 days ago, the order paid.
 */
async function sale(
  venueId: string,
  o: {
    source: OrderSource
    paymentStatus?: PaymentStatus
    at?: Date
    reservation?: boolean
    payment?: null | {
      source?: PaymentSource
      status?: TransactionStatus
      amount?: string
      method?: PaymentMethod
      terminalId?: string
      at?: Date
    }
  },
) {
  const at = o.at ?? hace(3 * DAY)
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `ORD-${suffix}-${++n}`,
      source: o.source,
      paymentStatus: o.paymentStatus ?? 'PAID',
      subtotal: '100.00',
      taxAmount: '0.00',
      total: '100.00',
      createdAt: at,
      reservationId: o.reservation ? await reservation(venueId) : undefined,
    },
  })
  if (o.payment === null) return order.id
  const p = o.payment ?? {}
  await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: p.amount ?? '100.00',
      method: p.method ?? 'CASH',
      source: p.source ?? 'OTHER',
      status: p.status ?? 'COMPLETED',
      terminalId: p.terminalId,
      feePercentage: '0',
      feeAmount: '0',
      netAmount: p.amount ?? '100.00',
      createdAt: p.at ?? at,
    },
  })
  return order.id
}

/** An organization with one real venue, built by `build`, and its `usaMedido`. */
async function usaOf(build: (venueId: string) => Promise<unknown>) {
  const { organizationId, venueId } = await orgWithVenue()
  await build(venueId)
  return (await factOf(organizationId)).usaMedido
}

async function planRow(
  venueId: string,
  tier: 'PRO' | 'PREMIUM',
  over: Partial<{
    active: boolean
    endDate: Date | null
    suspendedAt: Date | null
    gracePeriodEndsAt: Date | null
    stripeSubscriptionId: string | null
    paymentFailureCount: number
  }> = {},
) {
  return prisma.venueFeature.create({
    data: {
      venueId,
      featureId: tier === 'PREMIUM' ? planPremiumId : planProId,
      monthlyPrice: tier === 'PREMIUM' ? 1699 : 999,
      active: over.active ?? true,
      endDate: over.endDate ?? null,
      suspendedAt: over.suspendedAt ?? null,
      gracePeriodEndsAt: over.gracePeriodEndsAt ?? null,
      stripeSubscriptionId: over.stripeSubscriptionId ?? null,
      paymentFailureCount: over.paymentFailureCount ?? 0,
      startDate: hace(30 * DAY),
    },
  })
}

/**
 * A commercial plan contract (no classic row) with its paid period and one grant, `[grantStart, grantEnd]`: the shape of
 * the hybrid delivery, as in `audiencias.integration.test.ts`.
 */
async function contract(venueId: string, planTier: 'PRO' | 'PREMIUM', grantStart: Date, grantEnd: Date) {
  const key = `cf${suffix}${++n}`
  const funciones = ['LOYALTY_PROGRAM']
  const terms = {
    currency: 'MXN',
    interval: 'MONTHLY',
    price: 999,
    taxIncluded: true,
    promotionCycles: null,
    renewal: { kind: 'SAME_PRICE' },
  }
  const definition = { schemaVersion: 1, kind: 'PLAN', planTier, terms }
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: key,
      slug: key,
      name: key,
      draftDefinition: definition,
      startsAt: hace(60 * DAY),
      endsAt: dentroDe(60 * DAY),
      capacity: 5,
      audience: 'ALL',
      createdById: staffId,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: key,
      definition,
      definitionHash: 'b'.repeat(64),
      includedFeatureCodes: funciones,
      createdById: staffId,
      stripePriceId: `price_${key}`,
      stripeProductId: `prod_${key}`,
    },
  })
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: staffId,
      quote: { schemaVersion: 1, lines: [{ publicationId: publication.id, kind: 'PLAN', planTier, featureCodes: funciones, terms }] },
      quoteHash: key,
      quoteExpiresAt: dentroDe(DAY),
      status: 'COMPLETED',
      stripeCustomerId: `cus_${key}`,
      stripeSubscriptionId: `sub_${key}`,
      initialInvoiceId: `in_${key}`,
    },
  })
  const created = await prisma.hybridContract.create({
    data: {
      venueId,
      purchaseId: purchase.id,
      publicationId: publication.id,
      stripeSubscriptionId: `sub_${key}`,
      stripeItemId: `si_${key}`,
      featureCodes: funciones,
      planTier,
      startsAt: grantStart,
      paidThrough: grantEnd,
    },
  })
  hybridContractIds.push(created.id)
  const period = await prisma.hybridPaymentPeriod.create({
    data: {
      venueId,
      stripeSubscriptionId: `sub_${key}`,
      stripeInvoiceId: `inv_${key}`,
      startsAt: grantStart,
      endsAt: grantEnd,
      fundedAmount: '999.00',
      composition: [{ contractId: created.id, itemId: `si_${key}`, featureCodes: funciones, priceId: `price_${key}`, amount: '999.00' }],
    },
  })
  await prisma.capabilityGrant.create({
    data: {
      venueId,
      featureCode: funciones[0],
      sourceId: `${period.id}:${created.id}`,
      contractId: created.id,
      paymentPeriodId: period.id,
      startsAt: grantStart,
      endsAt: grantEnd,
    },
  })
}

/** Only `Date` simulated (the pattern of `activacion.reloj.test.ts`): Prisma keeps its real timers. */
const clockAt = (date: Date) =>
  jest.useFakeTimers({
    now: date,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })

describe('Los hechos de cada organización en una sola expresión (Postgres)', () => {
  beforeAll(async () => {
    staffId = (await prisma.staff.create({ data: { email: `vendedor-${suffix}@test.mx`, firstName: 'Hechos', lastName: 'C1' } })).id
    planProId = (
      await prisma.feature.upsert({
        where: { code: 'PLAN_PRO' },
        update: {},
        create: { code: 'PLAN_PRO', name: 'Plan Pro', category: 'OPERATIONS', monthlyPrice: 999 },
      })
    ).id
    planPremiumId = (
      await prisma.feature.upsert({
        where: { code: 'PLAN_PREMIUM' },
        update: {},
        create: { code: 'PLAN_PREMIUM', name: 'Plan Premium', category: 'OPERATIONS', monthlyPrice: 1699 },
      })
    ).id
  })

  afterAll(async () => {
    jest.useRealTimers()
    // By the ids this file created, never a `where` that could be undefined.
    if (hybridContractIds.length) {
      await prisma.hybridContract.updateMany({ where: { id: { in: hybridContractIds } }, data: { endedAt: new Date() } })
    }
    if (venueIds.length) {
      const free = { venueId: { in: venueIds }, venue: { hybridContracts: { none: {} } } }
      await prisma.payment.deleteMany({ where: free })
      await prisma.order.deleteMany({ where: free })
      await prisma.reservation.deleteMany({ where: free })
      await prisma.terminal.deleteMany({ where: free })
      await prisma.venue.deleteMany({ where: { id: { in: venueIds }, hybridContracts: { none: {} } } })
    }
    // The seller stays: the contracts' campaigns and publications point at it.
    if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds }, venues: { none: {} } } })
  })

  // ── Usa ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('Usa', () => {
    it('orden TPV cobrada hace 3 días → TERMINAL', async () => {
      expect(await usaOf(v => sale(v, { source: 'TPV', payment: { source: 'TPV' } }))).toBe('TERMINAL')
    })

    it('orden AVOQADO_ANDROID cobrada → POS', async () => {
      expect(await usaOf(v => sale(v, { source: 'AVOQADO_ANDROID', payment: { source: 'APP' } }))).toBe('POS')
    })

    it('AVOQADO_IOS cobrada → POS', async () => {
      expect(await usaOf(v => sale(v, { source: 'AVOQADO_IOS', payment: { source: 'APP' } }))).toBe('POS')
    })

    it('las dos → AMBOS', async () => {
      const { organizationId, venueId } = await orgWithVenue()
      await sale(venueId, { source: 'TPV', payment: { source: 'TPV' } })
      await sale(venueId, { source: 'AVOQADO_ANDROID', payment: { source: 'APP' } })
      const f = await factOf(organizationId)
      expect([f.usaMedido, f.usaTerminal, f.usaPos]).toEqual(['AMBOS', true, true])
    })

    it('orden AVOQADO_ANDROID cuyo cobro con tarjeta lo procesó una TPV_ANDROID → AMBOS (Testarudo)', async () => {
      expect(
        await usaOf(async v =>
          sale(v, {
            source: 'AVOQADO_ANDROID',
            payment: { source: 'APP', method: 'CREDIT_CARD', terminalId: await terminal(v, 'TPV_ANDROID') },
          }),
        ),
      ).toBe('AMBOS')
    })

    it('sólo PAYMENT_LINK, DASHBOARD_MANUAL, WEB y POS, con cobro real → NO_IDENTIFICADO', async () => {
      expect(
        await usaOf(async v => {
          await sale(v, { source: 'PAYMENT_LINK', payment: { source: 'WEB', method: 'CREDIT_CARD' } })
          await sale(v, { source: 'DASHBOARD_MANUAL', payment: { source: 'OTHER', method: 'BANK_TRANSFER' } })
          await sale(v, { source: 'WEB', payment: { source: 'WEB', method: 'CREDIT_CARD' } })
          await sale(v, { source: 'POS', payment: { source: 'POS' } })
        }),
      ).toBe('NO_IDENTIFICADO')
    })

    it('orden TPV PENDING o REFUNDED y ningún otro cobro → NINGUNO', async () => {
      expect(
        await usaOf(async v => {
          await sale(v, { source: 'TPV', paymentStatus: 'PENDING', payment: null })
          await sale(v, { source: 'TPV', paymentStatus: 'REFUNDED', payment: { source: 'TPV', status: 'REFUNDED' } })
        }),
      ).toBe('NINGUNO')
    })

    it('🔴 orden de una reserva (source TPV, con reservationId) cobrada en efectivo desde el POS (Payment.source APP) → POS, no TERMINAL', async () => {
      expect(await usaOf(v => sale(v, { source: 'TPV', reservation: true, payment: { source: 'APP' } }))).toBe('POS')
    })

    it('🔴 la misma cobrada en efectivo en la terminal (Payment.source TPV, sin terminalId) → TERMINAL', async () => {
      expect(await usaOf(v => sale(v, { source: 'TPV', reservation: true, payment: { source: 'TPV' } }))).toBe('TERMINAL')
    })

    it('la misma cobrada con tarjeta en una TPV_ANDROID → TERMINAL', async () => {
      expect(
        await usaOf(async v =>
          sale(v, {
            source: 'TPV',
            reservation: true,
            // Not `TPV` on purpose: the device that processed the card is what proves the terminal here.
            payment: { source: 'OTHER', method: 'CREDIT_CARD', terminalId: await terminal(v, 'TPV_ANDROID') },
          }),
        ),
      ).toBe('TERMINAL')
    })

    it('🔴 Codex r3 #3: reserva cobrada desde el POS como transferencia (Payment.source OTHER) → NO_IDENTIFICADO, nunca NINGUNO', async () => {
      expect(await usaOf(v => sale(v, { source: 'TPV', reservation: true, payment: { source: 'OTHER', method: 'BANK_TRANSFER' } }))).toBe(
        'NO_IDENTIFICADO',
      )
    })

    it('una reserva cobrada sólo con una liga (Payment.source WEB) → NO_IDENTIFICADO', async () => {
      expect(await usaOf(v => sale(v, { source: 'TPV', reservation: true, payment: { source: 'WEB', method: 'CREDIT_CARD' } }))).toBe(
        'NO_IDENTIFICADO',
      )
    })

    it('🔴 sin ningún cobro real en 30 días → NINGUNO', async () => {
      expect(
        await usaOf(async v => {
          await sale(v, { source: 'TPV', at: hace(40 * DAY), payment: { source: 'TPV' } })
          await sale(v, { source: 'AVOQADO_ANDROID', at: hace(40 * DAY), payment: { source: 'APP' } })
        }),
      ).toBe('NINGUNO')
    })

    it('🔴 orden TPV cobrada hace exactamente 30 días cuenta; hace 30 días + 1 s no', async () => {
      expect(await usaOf(v => sale(v, { source: 'TPV', at: hace(30 * DAY), payment: { source: 'TPV' } }))).toBe('TERMINAL')
      expect(await usaOf(v => sale(v, { source: 'TPV', at: hace(30 * DAY + 1000), payment: { source: 'TPV' } }))).toBe('NINGUNO')
    })

    it('🔴 una sucursal TRIAL con ventas de muestra no cuenta, la real de la misma organización sí', async () => {
      const { organizationId, venueId } = await orgWithVenue()
      const demo = await venue(organizationId, { status: VenueStatus.TRIAL, demoExpiresAt: dentroDe(10 * DAY) })
      await sale(demo, { source: 'TPV', payment: { source: 'TPV' } })
      await sale(demo, { source: 'AVOQADO_ANDROID', at: hace(DAY), payment: { source: 'APP' } })
      await sale(venueId, { source: 'AVOQADO_ANDROID', at: hace(10 * DAY), payment: { source: 'APP' } })
      const f = await factOf(organizationId)
      expect(f.usaMedido).toBe('POS')
      // The newest charge is the real venue's, not the demo's of yesterday.
      expect(f.ultimoCobroAt).toEqual(hace(10 * DAY))
    })

    it('🔴 un pago en una terminal PRINTER_RECEIPT o KDS no cuenta como terminal', async () => {
      expect(
        await usaOf(async v => {
          await sale(v, { source: 'DASHBOARD_MANUAL', payment: { source: 'OTHER', terminalId: await terminal(v, 'PRINTER_RECEIPT') } })
          await sale(v, { source: 'DASHBOARD_MANUAL', payment: { source: 'OTHER', terminalId: await terminal(v, 'KDS') } })
        }),
      ).toBe('NO_IDENTIFICADO')
    })
  })

  // ── Nivel: paridad con las reglas canónicas ───────────────────────────────────────────────────────────────────────

  describe('Nivel (paridad canónica)', () => {
    /** One organization with one real venue per state its writers leave (the «Escritores sembrados» table of the plan). */
    const seeded: Array<{ name: string; organizationId: string; venueId: string; expected: 'FREE' | 'PRO' | 'PREMIUM' }> = []

    beforeAll(async () => {
      const add = async (
        name: string,
        expected: 'FREE' | 'PRO' | 'PREMIUM',
        build: (venueId: string) => Promise<unknown>,
        over: { seatCapExempt?: boolean } = {},
      ) => {
        const { organizationId, venueId } = await orgWithVenue(over)
        await build(venueId)
        seeded.push({ name, organizationId, venueId, expected })
      }
      await add('Pro con Stripe', 'PRO', v => planRow(v, 'PRO', { stripeSubscriptionId: `sub_pro_${suffix}` }))
      await add('Premium de cortesía', 'PREMIUM', v => planRow(v, 'PREMIUM'))
      await add('prueba vigente sin Stripe', 'PRO', v => planRow(v, 'PRO', { endDate: dentroDe(3 * DAY) }))
      await add('prueba vigente con Stripe', 'PRO', v =>
        planRow(v, 'PRO', { endDate: dentroDe(3 * DAY), stripeSubscriptionId: `sub_trial_${suffix}` }),
      )
      await add('gracia vigente con prueba vencida', 'PRO', v =>
        planRow(v, 'PRO', { endDate: hace(DAY), gracePeriodEndsAt: dentroDe(2 * DAY), stripeSubscriptionId: `sub_grace_${suffix}` }),
      )
      await add('prueba vencida sin Stripe', 'FREE', v => planRow(v, 'PRO', { endDate: hace(DAY) }))
      await add('primer pago fallido', 'FREE', v =>
        planRow(v, 'PRO', { active: false, suspendedAt: hace(DAY), stripeSubscriptionId: `sub_fail1_${suffix}`, paymentFailureCount: 1 }),
      )
      await add('cuarto intento', 'FREE', v =>
        planRow(v, 'PREMIUM', {
          active: false,
          suspendedAt: hace(2 * DAY),
          gracePeriodEndsAt: dentroDe(DAY),
          stripeSubscriptionId: `sub_fail4_${suffix}`,
          paymentFailureCount: 4,
        }),
      )
      await add('corte de los 14 días', 'FREE', v => planRow(v, 'PRO', { active: false, suspendedAt: hace(15 * DAY) }))
      await add('suscripción borrada', 'FREE', v => planRow(v, 'PRO', { active: false, stripeSubscriptionId: `sub_gone_${suffix}` }))
      await add('cortesía y luego Gratis', 'FREE', v => planRow(v, 'PREMIUM', { active: false, endDate: hace(3_600_000) }))
      await add('dos filas (retirada + vigente)', 'PRO', async v => {
        await planRow(v, 'PREMIUM', { active: false, endDate: hace(5 * DAY) })
        await planRow(v, 'PRO', { stripeSubscriptionId: `sub_two_${suffix}` })
      })
      await add('🔴 Codex r3 #1: prueba Pro cancelada con endDate futuro + Premium suspendido después', 'FREE', async v => {
        await planRow(v, 'PRO', { active: false, endDate: dentroDe(10 * DAY) })
        await planRow(v, 'PREMIUM', { active: false, suspendedAt: hace(DAY), stripeSubscriptionId: `sub_r3_${suffix}` })
      })
      await add('🔴 Codex r3 #2: contrato Premium con concesión vigente y SIN fila clásica', 'PREMIUM', v =>
        contract(v, 'PREMIUM', hace(10 * DAY), dentroDe(20 * DAY)),
      )
      await add('contrato Pro con concesión vigente', 'PRO', v => contract(v, 'PRO', hace(10 * DAY), dentroDe(20 * DAY)))
      await add('contrato con la concesión vencida', 'FREE', v => contract(v, 'PREMIUM', hace(40 * DAY), hace(10 * DAY)))
      await add('grandfather sin plan', 'FREE', async () => undefined, { seatCapExempt: true })
    })

    afterEach(() => jest.useRealTimers())

    it('🔴 en cada sucursal sembrada, f.nivel de su organización de una sola sucursal = getVenuePlanInfo(sucursal).tier', async () => {
      const facts = await factsOf(seeded.map(s => s.organizationId))
      clockAt(NOW)
      const got: Record<string, { sql: string; canonical: string }> = {}
      for (const s of seeded) got[s.name] = { sql: facts.get(s.organizationId)!.nivel, canonical: (await getVenuePlanInfo(s.venueId)).tier }
      jest.useRealTimers()
      for (const s of seeded) expect({ name: s.name, ...got[s.name] }).toEqual({ name: s.name, sql: s.expected, canonical: s.expected })
    })

    it('🔴 ventanaDeAccesoSql = daAcceso fila por fila (todas las filas sembradas)', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ id: string; active: boolean; suspendedAt: Date | null; endDate: Date | null; gracePeriodEndsAt: Date | null; sql: boolean }>
      >(Prisma.sql`
        SELECT vf."id", vf."active", vf."suspendedAt", vf."endDate", vf."gracePeriodEndsAt", ${ventanaDeAccesoSql('vf', NOW)} AS "sql"
        FROM "VenueFeature" vf WHERE vf."venueId" IN (${Prisma.join(seeded.map(s => s.venueId))})`)
      expect(rows.length).toBeGreaterThanOrEqual(15)
      expect(new Set(rows.map(r => r.sql))).toEqual(new Set([true, false]))
      for (const r of rows) expect({ id: r.id, sql: r.sql }).toEqual({ id: r.id, sql: daAcceso(r, NOW) })
    })

    it('🔴 concesionComercialSql = (getContractBaseTier(sucursal) === tier)', async () => {
      const rows = await prisma.$queryRaw<Array<{ id: string; pro: boolean; premium: boolean }>>(Prisma.sql`
        SELECT v."id", ${concesionComercialSql('v', NOW, 'PRO')} AS "pro", ${concesionComercialSql('v', NOW, 'PREMIUM')} AS "premium"
        FROM "Venue" v WHERE v."id" IN (${Prisma.join(seeded.map(s => s.venueId))})`)
      clockAt(NOW)
      const canonical = new Map<string, string | null>()
      for (const s of seeded) {
        // `getContractBaseTier` is private. On a venue WITHOUT classic plan rows, `getVenueBaseTier` is exactly it; a venue
        // seeded with classic rows has no grants, so its commercial tier is null by construction (asserted).
        const classic = await prisma.venueFeature.count({ where: { venueId: s.venueId } })
        if (classic) expect(await prisma.capabilityGrant.count({ where: { venueId: s.venueId } })).toBe(0)
        canonical.set(s.venueId, classic ? null : await getVenueBaseTier(s.venueId))
      }
      jest.useRealTimers()
      expect(rows.filter(r => r.pro || r.premium)).toHaveLength(2)
      for (const r of rows) {
        expect({ id: r.id, pro: r.pro, premium: r.premium }).toEqual({
          id: r.id,
          pro: canonical.get(r.id) === 'PRO',
          premium: canonical.get(r.id) === 'PREMIUM',
        })
      }
    })

    it('🔴 dos sucursales (Pro pagada y Premium de cortesía) → nivel de la organización PREMIUM', async () => {
      const organizationId = await org()
      await planRow(await venue(organizationId), 'PRO', { stripeSubscriptionId: `sub_mix_${suffix}` })
      await planRow(await venue(organizationId), 'PREMIUM')
      // A demo venue's plan never raises the level: a TRIAL Premium next to a real Free.
      const otra = await org()
      await venue(otra)
      await planRow(await venue(otra, { status: VenueStatus.TRIAL, demoExpiresAt: dentroDe(10 * DAY) }), 'PREMIUM')
      const facts = await factsOf([organizationId, otra])
      expect(facts.get(organizationId)!.nivel).toBe('PREMIUM')
      expect(facts.get(otra)!.nivel).toBe('FREE')
    })
  })

  // ── Estado ────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('Estado', () => {
    /** An organization whose signup is not finished, with one real venue and nothing charged. */
    async function altaSinTerminar() {
      const { organizationId, venueId } = await orgWithVenue()
      await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [] } })
      return { organizationId, venueId }
    }

    it('progreso sin terminar, sin cobros, sin Stripe ni contrato → ALTA_SIN_TARJETA', async () => {
      const { organizationId, venueId } = await altaSinTerminar()
      // A free trial without a card does not give a card.
      await planRow(venueId, 'PRO', { endDate: dentroDe(3 * DAY) })
      expect((await factOf(organizationId)).estado).toBe('ALTA_SIN_TARJETA')
    })

    it('🔴 el mismo con una fila de plan con Stripe → NUNCA (no es 🟠)', async () => {
      const { organizationId, venueId } = await altaSinTerminar()
      await planRow(venueId, 'PRO', { endDate: dentroDe(3 * DAY), stripeSubscriptionId: `sub_alta_${suffix}` })
      expect((await factOf(organizationId)).estado).toBe('NUNCA')
    })

    it('el mismo con un contrato sin terminar → NUNCA', async () => {
      const { organizationId, venueId } = await altaSinTerminar()
      await contract(venueId, 'PRO', hace(10 * DAY), dentroDe(20 * DAY))
      expect((await factOf(organizationId)).estado).toBe('NUNCA')
    })

    it('alta terminada en los dos lados → NUNCA', async () => {
      const organizationId = await org({ onboardingCompletedAt: hace(DAY) })
      await venue(organizationId)
      await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [], completedAt: hace(DAY) } })
      expect((await factOf(organizationId)).estado).toBe('NUNCA')
    })

    it('sin OnboardingProgress y sin cobros → NUNCA', async () => {
      const { organizationId } = await orgWithVenue()
      const f = await factOf(organizationId)
      expect([f.estado, f.ultimoCobroAt, f.usaMedido]).toEqual(['NUNCA', null, 'NINGUNO'])
    })

    it('cobró ayer → COBRA con ultimoCobroAt', async () => {
      const { organizationId, venueId } = await altaSinTerminar()
      await sale(venueId, { source: 'TPV', at: hace(2 * DAY), payment: { source: 'TPV', at: hace(DAY) } })
      const f = await factOf(organizationId)
      expect([f.estado, f.ultimoCobroAt]).toEqual(['COBRA', hace(DAY)])
    })

    it('cobró hace 40 días → SIN_COBROS', async () => {
      const { organizationId, venueId } = await orgWithVenue()
      await sale(venueId, { source: 'TPV', at: hace(40 * DAY), payment: { source: 'TPV' } })
      const f = await factOf(organizationId)
      expect([f.estado, f.ultimoCobroAt]).toEqual(['SIN_COBROS', hace(40 * DAY)])
    })

    it('un cobro de $0.00 o PENDING no es cobro', async () => {
      const { organizationId, venueId } = await altaSinTerminar()
      await sale(venueId, { source: 'TPV', payment: { source: 'TPV', amount: '0.00' } })
      await sale(venueId, { source: 'AVOQADO_ANDROID', paymentStatus: 'PENDING', payment: { source: 'APP', status: 'PENDING' } })
      const f = await factOf(organizationId)
      expect([f.estado, f.ultimoCobroAt]).toEqual(['ALTA_SIN_TARJETA', null])
    })
  })
})
