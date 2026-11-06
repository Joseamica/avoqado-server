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
import type { CrmAccess } from '@/services/crm/access.service'
import { clientFactsLateral, concesionComercialSql, ventanaDeAccesoSql } from '@/services/crm/clientFacts'
import { scopeWhere } from '@/services/crm/access.service'
import {
  ensureClientAccount,
  setAltaMotivo,
  setUsa,
  clientsFilter,
  getClientLive,
  listClients,
  scopeSql,
  type ClientFilters,
} from '@/services/crm/clients.service'
import { erasedAtTx, erasedHashes } from '@/services/crm/erase.service'
import { getReports } from '@/services/crm/reports.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { planDeLaPagina, planesPorSucursal } from '@/services/crm/clientPage'
import * as planStateService from '@/services/dashboard/planState.service'
import * as stripeService from '@/services/stripe.service'
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
/** Task 4: the CRM rows this file made (accounts, its stage, the two sellers). */
const crmAccountIds: string[] = []
const crmStageIds: string[] = []
const sellerIds: string[] = []
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
    if (organizationIds.length) await prisma.crmHiddenClient.deleteMany({ where: { organizationId: { in: organizationIds } } })
    if (crmAccountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: crmAccountIds } } })
    if (crmStageIds.length) await prisma.crmStage.deleteMany({ where: { id: { in: crmStageIds } } })
    if (sellerIds.length) await prisma.staff.deleteMany({ where: { id: { in: sellerIds } } })
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
      // Bordes (T2-1/2): el segundo exacto de vencimiento y de gracia, dos filas vigentes, y concesiones que ya no valen.
      await add('prueba que vence justo ahora (endDate = now)', 'PRO', v => planRow(v, 'PRO', { endDate: NOW }))
      await add('gracia que vence justo ahora (grace = now)', 'PRO', v =>
        planRow(v, 'PRO', { endDate: hace(DAY), gracePeriodEndsAt: NOW, stripeSubscriptionId: `sub_gnow_${suffix}` }),
      )
      await add('Pro y Premium vigentes a la vez', 'PREMIUM', async v => {
        await planRow(v, 'PRO', { stripeSubscriptionId: `sub_both_${suffix}` })
        await planRow(v, 'PREMIUM')
      })
      await add('contrato con la concesión revocada', 'FREE', async v => {
        await contract(v, 'PRO', hace(10 * DAY), dentroDe(20 * DAY))
        await prisma.capabilityGrant.updateMany({ where: { venueId: v }, data: { revokedAt: hace(DAY) } })
      })
      await add('contrato con la concesión en el futuro', 'FREE', v => contract(v, 'PRO', dentroDe(2 * DAY), dentroDe(30 * DAY)))
      await add('contrato terminado con la concesión vigente', 'FREE', async v => {
        await contract(v, 'PREMIUM', hace(10 * DAY), dentroDe(20 * DAY))
        await prisma.hybridContract.updateMany({ where: { venueId: v }, data: { endedAt: hace(DAY) } })
      })
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
  // ── Las altas sin tarjeta entran a «Clientes» (Tarea 3) ───────────────────────────────────────────────────────────

  describe('altas sin tarjeta en «Clientes»', () => {
    // Lazy: `staffId` is set in `beforeAll`.
    const sa = () => ({ staffId, isSuperadmin: true, ver: 'todos', editar: 'todos', configurar: true }) as unknown as CrmAccess
    /** Ids of the organizations this file made that «Clientes» lists, newest first, walking every page. */
    async function listed(filters: { altas?: boolean; ocultos?: boolean } = {}) {
      const out: string[] = []
      let cursor: string | undefined
      let total = 0
      do {
        const page = await listClients(sa(), { ...filters, q: suffix, limit: 100, cursor })
        out.push(...page.rows.map(r => r.id))
        total = page.total
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { ids: out, total }
    }
    /** A signup that stopped at the plan screen: own acquisition source, a real venue, no card. */
    async function altaPropia(source: string | null = 'landing') {
      const organizationId = await org()
      const venueId = await venue(organizationId)
      await prisma.onboardingProgress.create({
        data: { organizationId, completedSteps: [], ...(source ? { acquisitionSource: source } : {}) },
      })
      return { organizationId, venueId }
    }

    it('🔴 sin altas=1 la lista y el total son exactamente los de hoy: una alta sin tarjeta no sale (SUPERADMIN viejo)', async () => {
      const { organizationId } = await altaPropia()
      const sin = await listed()
      expect(sin.ids).not.toContain(organizationId)
      const con = await listed({ altas: true })
      expect(con.ids).toContain(organizationId)
      expect(con.total).toBe(sin.total + 1)
    })

    it('una alta de la landing sin tarjeta sale en la lista con altas=1 y en getClientLive', async () => {
      const { organizationId } = await altaPropia('landing')
      expect((await listed({ altas: true })).ids).toContain(organizationId)
      await expect(getClientLive(sa(), organizationId, NOW)).resolves.toBeDefined()
    })

    it('una alta directa del panel sin tarjeta también', async () => {
      const { organizationId } = await altaPropia('dashboard_signup')
      expect((await listed({ altas: true })).ids).toContain(organizationId)
    })

    it('🔴 una organización hecha por el superadmin sin cobros ni progreso NO sale', async () => {
      const { organizationId } = await orgWithVenue()
      expect((await listed({ altas: true })).ids).not.toContain(organizationId)
      await expect(getClientLive(sa(), organizationId, NOW)).rejects.toMatchObject({ code: 'CRM_NO_ES_CLIENTE' })
    })

    it('🔴 una alta con progreso pero sin acquisitionSource (hecha a mano) NO sale', async () => {
      const { organizationId } = await altaPropia(null)
      expect((await listed({ altas: true })).ids).not.toContain(organizationId)
    })

    it('🔴 una alta que nunca creó su negocio (sin sucursal) NO sale', async () => {
      const organizationId = await org()
      await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [], acquisitionSource: 'landing' } })
      expect((await listed({ altas: true })).ids).not.toContain(organizationId)
    })

    it('🔴 una alta sin tarjeta pero oculta NO sale; con ocultos=true y «Configurar» sí', async () => {
      const { organizationId } = await altaPropia()
      await prisma.crmHiddenClient.create({ data: { organizationId } })
      expect((await listed({ altas: true })).ids).not.toContain(organizationId)
      expect((await listed({ altas: true, ocultos: true })).ids).toContain(organizationId)
    })

    it('🔴 la organización del equipo nunca sale (aunque tenga la forma de un alta sin tarjeta)', async () => {
      // The test's own organization, with the 🟠 shape, is injected as the team: never touches the shared `CrmTeam` row.
      const { organizationId } = await altaPropia()
      const ids = async (teamOrgId: string | null) =>
        (
          await prisma.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT o."id" FROM "Organization" o WHERE o."id" = ${organizationId} AND ${clientsFilter(teamOrgId, NOW, { onlyHidden: false, conAltas: true })}`,
          )
        ).map(r => r.id)
      expect(await ids(null)).toEqual([organizationId]) // control: with no team it does come out
      expect(await ids(organizationId)).toEqual([])
    })

    it('al activar su plan (fila con Stripe) sigue saliendo si es cliente por clientSql, y deja de ser ALTA_SIN_TARJETA', async () => {
      const { organizationId, venueId } = await altaPropia()
      await sale(venueId, { source: 'TPV', at: hace(60 * DAY), payment: { source: 'TPV' } })
      await planRow(venueId, 'PRO', { stripeSubscriptionId: `sub_act_${suffix}` })
      const sin = await listed()
      expect(sin.ids).toContain(organizationId)
      expect((await listed({ altas: true })).ids).toContain(organizationId)
      expect((await factOf(organizationId)).estado).not.toBe('ALTA_SIN_TARJETA')
    })
  })

  // ── La lista con filtros, columnas y total (Tarea 4) ──────────────────────────────────────────────────────────────

  describe('filtros, columnas y total de «Clientes» (Tarea 4)', () => {
    /** This block's organizations carry their own name key, so `q` lists only them (the blocks above made many more). */
    const LEG = `leg${Date.now()}`
    const o: Record<string, string> = {}
    let A: string
    let B: string
    let stageId: string
    const propios = (me: string) => ({ staffId: me, isSuperadmin: false, ver: 'propios', editar: 'propios' }) as unknown as CrmAccess
    const todos = () => ({ staffId, isSuperadmin: true, ver: 'todos', editar: 'todos' }) as unknown as CrmAccess
    type Row = Awaited<ReturnType<typeof listClients>>['rows'][number]

    async function orgL(key: string) {
      const { id } = await prisma.organization.create({
        data: { name: `Leg ${LEG} ${key}`, email: `leg-${LEG}-${key}@test.mx`, phone: '5555555555' },
      })
      organizationIds.push(id)
      o[key] = id
      return { organizationId: id, venueId: await venue(id) }
    }
    async function altaL(key: string) {
      const made = await orgL(key)
      await prisma.onboardingProgress.create({
        data: { organizationId: made.organizationId, completedSteps: [], acquisitionSource: 'landing' },
      })
      return made
    }
    async function account(
      organizationId: string,
      ownerStaffId: string | null,
      extra: Partial<Prisma.CrmAccountUncheckedCreateInput> = {},
    ) {
      const { id } = await prisma.crmAccount.create({
        data: { name: `Cuenta ${LEG}`, source: 'MANUAL', stageId, organizationId, ownerStaffId, ...extra },
      })
      crmAccountIds.push(id)
      return id
    }

    /** Every page of «Clientes» for `access`, `limit` at a time, with the total each page said. */
    async function walk(access: CrmAccess, filters: ClientFilters = {}, limit = 2) {
      const rows: Row[] = []
      const totals = new Set<number>()
      let cursor: string | undefined
      do {
        const page = await listClients(access, { ...filters, q: LEG, altas: true, limit, cursor }, NOW)
        expect(page.legible).toBe(1)
        rows.push(...page.rows)
        totals.add(page.total)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      expect(totals.size).toBe(1)
      return { rows, total: [...totals][0], ids: rows.map(row => row.id) }
    }

    beforeAll(async () => {
      A = (await prisma.staff.create({ data: { email: `a-${LEG}@test.mx`, firstName: 'Ana', lastName: 'Propios' } })).id
      B = (await prisma.staff.create({ data: { email: `b-${LEG}@test.mx`, firstName: 'Beto', lastName: 'Propios' } })).id
      sellerIds.push(A, B)
      stageId = (await prisma.crmStage.create({ data: { name: `Etapa ${LEG}`, order: 900, kind: 'ABIERTA' } })).id
      crmStageIds.push(stageId)

      // 1 · terminal, cobra, Gratis; B wrote ✋ POS (≠ lo medido → aviso).
      const t = await orgL('terminal')
      await sale(t.venueId, { source: 'TPV', payment: { source: 'TPV' } })
      await account(t.organizationId, B, {
        usaManual: 'POS',
        usaManualPorque: 'Lo vi en su local',
        usaManualById: B,
        usaManualAt: hace(DAY),
      })
      // 2 · POS, cobra, Pro; A wrote ✋ POS (= lo medido → sin aviso).
      const p = await orgL('pos')
      await sale(p.venueId, { source: 'AVOQADO_ANDROID', payment: { source: 'APP' } })
      await planRow(p.venueId, 'PRO')
      await account(p.organizationId, A, { usaManual: 'POS', usaManualById: A, usaManualAt: hace(DAY) })
      // 3 · los dos, cobra, Premium; cuenta sin dueño.
      const ambos = await orgL('ambos')
      await sale(ambos.venueId, { source: 'TPV', payment: { source: 'TPV' } })
      await sale(ambos.venueId, { source: 'AVOQADO_IOS', payment: { source: 'APP' } })
      await planRow(ambos.venueId, 'PREMIUM')
      await account(ambos.organizationId, null)
      // 4 · cobró por una liga: aparato no identificado.
      const liga = await orgL('liga')
      await sale(liga.venueId, { source: 'PAYMENT_LINK', payment: { source: 'WEB', method: 'CREDIT_CARD' } })
      // 5 · cobró hace 40 días: sin cobros.
      const viejo = await orgL('viejo')
      await sale(viejo.venueId, { source: 'TPV', at: hace(40 * DAY), payment: { source: 'TPV' } })
      // 6, 7, 8 · altas sin tarjeta: de B con PRECIO, de A con PRECIO, sin cuenta.
      await account((await altaL('altaB')).organizationId, B, { altaMotivo: 'PRECIO' })
      await account((await altaL('altaA')).organizationId, A, { altaMotivo: 'PRECIO' })
      await altaL('altaSin')
      // 9 · Pro sin cobrar nunca.
      await planRow((await orgL('soloPlan')).venueId, 'PRO')
    })

    it('las 9 organizaciones pintan lo sembrado (control)', async () => {
      const { rows, total } = await walk(todos(), {}, 100)
      expect(total).toBe(9)
      const by = new Map(rows.map(row => [row.id, row]))
      const pinta = (key: string) => {
        const row = by.get(o[key])!
        return [row.usa.visto, row.usa.medido, row.plan.nivel, row.estado.codigo]
      }
      expect(pinta('terminal')).toEqual(['POS', 'TERMINAL', 'FREE', 'COBRA'])
      expect(pinta('pos')).toEqual(['POS', 'POS', 'PRO', 'COBRA'])
      expect(pinta('ambos')).toEqual(['AMBOS', 'AMBOS', 'PREMIUM', 'COBRA'])
      expect(pinta('liga')).toEqual(['NO_IDENTIFICADO', 'NO_IDENTIFICADO', 'FREE', 'COBRA'])
      expect(pinta('viejo')).toEqual(['NINGUNO', 'NINGUNO', 'FREE', 'SIN_COBROS'])
      for (const key of ['altaB', 'altaA', 'altaSin']) expect(pinta(key)).toEqual(['NINGUNO', 'NINGUNO', 'FREE', 'ALTA_SIN_TARJETA'])
      expect(pinta('soloPlan')).toEqual(['NINGUNO', 'NINGUNO', 'PRO', 'NUNCA'])
      expect(by.get(o.pos)!.estado.ultimoCobroAt).toEqual(hace(3 * DAY))
      expect(by.get(o.soloPlan)!.estado.ultimoCobroAt).toBeNull()
    })

    it('🔴 para cada valor de cada filtro, total = filas recorridas página por página (limit 2) cuyo valor pintado es ése; la suma por valores = total sin filtro', async () => {
      const filtros: Array<{ key: 'usa' | 'nivel' | 'estado'; values: readonly string[]; pinta: (row: Row, value: string) => boolean }> = [
        {
          key: 'usa',
          values: ['AMBOS', 'TERMINAL', 'POS', 'NO_IDENTIFICADO', 'NINGUNO', 'AVISO'],
          pinta: (row, value) => (value === 'AVISO' ? row.usa.aviso : row.usa.visto === value),
        },
        { key: 'nivel', values: ['FREE', 'PRO', 'PREMIUM'], pinta: (row, value) => row.plan.nivel === value },
        { key: 'estado', values: ['ALTA_SIN_TARJETA', 'COBRA', 'SIN_COBROS', 'NUNCA'], pinta: (row, value) => row.estado.codigo === value },
      ]
      for (const access of [propios(A), propios(B), todos()]) {
        const base = await walk(access)
        expect(base.rows).toHaveLength(base.total)
        for (const { key, values, pinta } of filtros) {
          let suma = 0
          for (const value of values) {
            const filtered = await walk(access, { [key]: value } as ClientFilters)
            expect({ key, value, total: filtered.total }).toEqual({ key, value, total: filtered.rows.length })
            expect(filtered.rows.every(row => pinta(row, value))).toBe(true)
            expect({ key, value, total: filtered.total }).toEqual({ key, value, total: base.rows.filter(row => pinta(row, value)).length })
            if (value !== 'AVISO') suma += filtered.total
          }
          expect({ key, suma }).toEqual({ key, suma: base.total })
        }
        // Dueño, pintado con lo que la fila dice de la cuenta.
        const me = access.staffId
        for (const [value, pinta] of [
          ['MIOS', (row: Row) => row.cuenta?.owner?.id === me],
          ['SIN_DUENO', (row: Row) => !row.cuentaAjena && !row.cuenta?.owner],
        ] as const) {
          const filtered = await walk(access, { dueno: value })
          expect(filtered.total).toBe(filtered.rows.length)
          expect(filtered.rows.every(row => pinta(row))).toBe(true)
          expect(filtered.total).toBe(base.rows.filter(row => pinta(row)).length)
        }
      }
    })

    it('usa=AVISO trae sólo las de ✋ distinto de lo medido', async () => {
      expect((await walk(todos(), { usa: 'AVISO' })).ids).toEqual([o.terminal])
      // A's ✋ equals what was measured: no warning, the value is still «escrito».
      const pos = (await walk(todos(), { usa: 'POS' })).rows.find(row => row.id === o.pos)!
      expect(pos.usa).toMatchObject({ visto: 'POS', medido: 'POS', manual: true, aviso: false })
    })

    it('🔴 A con dueno=SIN_DUENO no ve la cuenta de B; con MIOS sólo las suyas', async () => {
      const sinDueno = (await walk(propios(A), { dueno: 'SIN_DUENO' })).ids
      expect(sinDueno).not.toContain(o.terminal)
      expect(sinDueno).not.toContain(o.altaB)
      expect(new Set(sinDueno)).toEqual(new Set([o.ambos, o.liga, o.viejo, o.altaSin, o.soloPlan]))
      expect(new Set((await walk(propios(A), { dueno: 'MIOS' })).ids)).toEqual(new Set([o.pos, o.altaA]))
      await expect(listClients(propios(A), { dueno: B, q: LEG, altas: true }, NOW)).rejects.toMatchObject({ code: 'CRM_FILTRO_DE_DUENO' })
      // «Ver: todos» may filter by a colleague.
      expect(new Set((await walk(todos(), { dueno: B })).ids)).toEqual(new Set([o.terminal, o.altaB]))
    })

    it('🔴 A ve el valor y manual=true del ✋ que puso B en su cuenta, pero detalle = null', async () => {
      const seenByA = (await walk(propios(A))).rows.find(row => row.id === o.terminal)!
      expect(seenByA).toMatchObject({ cuenta: null, cuentaAjena: true })
      expect(seenByA.usa).toEqual({
        visto: 'POS',
        medido: 'TERMINAL',
        manual: true,
        aviso: true,
        detalle: null,
        aparatos: { terminales: 0, pos: 0 },
      })

      const seenByB = (await walk(propios(B))).rows.find(row => row.id === o.terminal)!
      expect(seenByB.usa.detalle).toEqual({ porque: 'Lo vi en su local', por: { id: B, name: 'Beto Propios' }, at: hace(DAY) })
      const seenByAll = (await walk(todos())).rows.find(row => row.id === o.terminal)!
      expect(seenByAll.usa.detalle).toEqual(seenByB.usa.detalle)
    })

    it('🔴 motivo=PRECIO para A no trae la cuenta de B con motivo PRECIO', async () => {
      expect((await walk(propios(A), { motivo: 'PRECIO' })).ids).toEqual([o.altaA])
      expect(new Set((await walk(todos(), { motivo: 'PRECIO' })).ids)).toEqual(new Set([o.altaA, o.altaB]))
      // «Sin hablarle»: sin cuenta, o una visible sin motivo; la de B no es «sin motivo» para A.
      expect((await walk(propios(A), { motivo: 'SIN_MOTIVO' })).ids).toEqual([o.altaSin])
      // A reason only ever lists a 🟠.
      expect((await walk(todos(), { motivo: 'OTRO' })).ids).toEqual([])
    })

    it('el cursor con filtros no repite ni salta filas', async () => {
      for (const filters of [{ estado: 'COBRA' }, { usa: 'NINGUNO' }, { nivel: 'FREE', dueno: 'SIN_DUENO' }] as ClientFilters[]) {
        const all = await walk(todos(), filters, 100)
        const oneByOne = await walk(todos(), filters, 1)
        expect(oneByOne.ids).toEqual(all.ids)
        expect(new Set(oneByOne.ids).size).toBe(oneByOne.ids.length)
      }
    })

    it('🔴 scopeSql = scopeWhere para propios y todos (dos vendedores)', async () => {
      for (const access of [propios(A), propios(B), todos()]) {
        const sql = await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT ca."id" FROM "CrmAccount" ca WHERE ca."id" IN (${Prisma.join(crmAccountIds)}) AND ${scopeSql(access, 'ca')}`,
        )
        const where = await prisma.crmAccount.findMany({
          where: { AND: [{ id: { in: crmAccountIds } }, scopeWhere(access, 'ver')] },
          select: { id: true },
          take: crmAccountIds.length,
        })
        expect(new Set(sql.map(row => row.id))).toEqual(new Set(where.map(row => row.id)))
      }
      // And it is not vacuous: A and B see different accounts.
      const de = async (me: string) =>
        prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT ca."id" FROM "CrmAccount" ca WHERE ca."id" IN (${Prisma.join(crmAccountIds)}) AND ${scopeSql(propios(me), 'ca')}`,
        )
      expect((await de(A)).length).toBe(3)
      expect((await de(B)).length).toBe(3)
    })

    it('conteos de los 🟠 por motivo, en el alcance de quien mira (DE_OTRO y perdidos llegan con la Tarea 5)', async () => {
      const deA = await listClients(propios(A), { q: LEG, usa: 'TERMINAL', altas: true }, NOW)
      expect(deA.conteos).toMatchObject({ altaSinTarjeta: 3, porMotivo: { PRECIO: 1, SIN_MOTIVO: 1 } })
      const deTodos = await listClients(todos(), { q: LEG, altas: true }, NOW)
      expect(deTodos.conteos).toMatchObject({ altaSinTarjeta: 3, porMotivo: { PRECIO: 2, SIN_MOTIVO: 1 } })
    })
  })

  // ── Lo de la página: plan con las reglas canónicas, aparatos, datos del alta, último comentario y conteos (Tarea 5) ─

  describe('lo de la página (Tarea 5)', () => {
    const PAG = `pag${Date.now()}`
    let A: string
    let B: string
    let stageId: string
    const launchCampaignIds: string[] = []
    const propios = (me: string) => ({ staffId: me, isSuperadmin: false, ver: 'propios', editar: 'propios' }) as unknown as CrmAccess
    const todos = () => ({ staffId, isSuperadmin: true, ver: 'todos', editar: 'todos', configurar: true }) as unknown as CrmAccess
    let stripeCaido: jest.SpyInstance

    async function orgP(key: string, over: { seatCapExempt?: boolean } = {}) {
      const { id } = await prisma.organization.create({
        data: { name: `Pag ${PAG} ${key}`, email: `pag-${PAG}-${key}@test.mx`, phone: '5555555555' },
      })
      organizationIds.push(id)
      return { organizationId: id, venueId: await venue(id, over) }
    }
    async function altaP(key: string, progress: Partial<Prisma.OnboardingProgressUncheckedCreateInput> = {}) {
      const made = await orgP(key)
      await prisma.onboardingProgress.create({
        data: { organizationId: made.organizationId, completedSteps: [], acquisitionSource: 'landing', ...progress },
      })
      return made
    }
    async function cuenta(organizationId: string, ownerStaffId: string | null, extra: Partial<Prisma.CrmAccountUncheckedCreateInput> = {}) {
      const { id } = await prisma.crmAccount.create({
        data: { name: `Cuenta ${PAG}`, source: 'MANUAL', stageId, organizationId, ownerStaffId, ...extra },
      })
      crmAccountIds.push(id)
      return id
    }
    async function campana(name: string) {
      const key = `lc${PAG}${++n}`
      const { id } = await prisma.launchCampaign.create({
        data: {
          code: key,
          name,
          landingSlug: key,
          planTier: 'PRO',
          advertisedPriceCents: 1000,
          discountMonths: 3,
          validFrom: hace(30 * DAY),
          validUntil: dentroDe(30 * DAY),
          redemptionCap: 10,
        },
      })
      launchCampaignIds.push(id)
      return id
    }
    async function canje(organizationId: string, campaignId: string, over: Partial<Prisma.LaunchCampaignRedemptionUncheckedCreateInput>) {
      await prisma.launchCampaignRedemption.create({
        data: {
          campaignId,
          organizationId,
          offerVersion: 1,
          planTier: 'PRO',
          advertisedPriceCents: 1000,
          // The amounts check of the table: list − discount = advertised, at least $10.
          discountAmountCents: 15000,
          discountMonths: 3,
          listPriceCents: 16000,
          stripeCouponId: `coupon_${PAG}_${++n}`,
          // APPLIED means Stripe charged: it carries its subscription (a check of the table).
          stripeSubscriptionId: over.status === 'APPLIED' ? `sub_lc_${PAG}_${n}` : null,
          ...over,
        },
      })
    }
    /** One page of «Clientes» for this block's key (or a narrower one), with the canonical clock at `NOW`. */
    async function pagina(access: CrmAccess, filters: ClientFilters = {}) {
      clockAt(NOW)
      try {
        return await listClients(access, { q: PAG, altas: true, limit: 100, ...filters }, NOW)
      } finally {
        jest.useRealTimers()
      }
    }
    const filaDe = async (organizationId: string, access: CrmAccess = todos(), filters: ClientFilters = {}) =>
      (await pagina(access, filters)).rows.find(row => row.id === organizationId)

    beforeAll(async () => {
      A = (await prisma.staff.create({ data: { email: `a-${PAG}@test.mx`, firstName: 'Ana', lastName: 'Página' } })).id
      B = (await prisma.staff.create({ data: { email: `b-${PAG}@test.mx`, firstName: 'Beto', lastName: 'Página' } })).id
      sellerIds.push(A, B)
      stageId = (await prisma.crmStage.create({ data: { name: `Etapa ${PAG}`, order: 901, kind: 'ABIERTA' } })).id
      crmStageIds.push(stageId)
      // The oracle runs with Stripe down: `getPlanState` degrades to nulls, and that is what the list mirrors.
      stripeCaido = jest.spyOn(stripeService, 'retrievePlanSubscription').mockRejectedValue(new Error('Stripe caído (prueba)'))
    })

    afterAll(async () => {
      stripeCaido.mockRestore()
      // A redemption holds its organization (`Restrict`): out before the outer cleanup.
      if (organizationIds.length) await prisma.launchCampaignRedemption.deleteMany({ where: { organizationId: { in: organizationIds } } })
      if (launchCampaignIds.length) {
        await prisma.onboardingProgress.updateMany({
          where: { launchCampaignId: { in: launchCampaignIds } },
          data: { launchCampaignId: null },
        })
        await prisma.launchCampaign.deleteMany({ where: { id: { in: launchCampaignIds } } })
      }
    })

    afterEach(() => jest.useRealTimers())

    describe('plan: sólo reglas canónicas (rediseño r3)', () => {
      type Sembrada = { name: string; organizationId: string; venueId: string; condicion: string | null }
      const sembradas: Sembrada[] = []

      beforeAll(async () => {
        const add = async (
          name: string,
          condicion: string | null,
          build: (venueId: string) => Promise<unknown>,
          over: { seatCapExempt?: boolean } = {},
        ) => {
          const made = await orgP(`or${sembradas.length}`, over)
          await build(made.venueId)
          sembradas.push({ name, condicion, ...made })
        }
        await add('Pro con Stripe', 'PAGADO', v => planRow(v, 'PRO', { stripeSubscriptionId: `sub_opro_${PAG}` }))
        await add('Premium de cortesía', 'CORTESIA', v => planRow(v, 'PREMIUM'))
        await add('prueba vigente sin Stripe', 'PRUEBA_SIN_TARJETA', v => planRow(v, 'PRO', { endDate: dentroDe(3 * DAY) }))
        await add('prueba vigente con Stripe', 'PRUEBA_CON_TARJETA', v =>
          planRow(v, 'PRO', { endDate: dentroDe(3 * DAY), stripeSubscriptionId: `sub_otrial_${PAG}` }),
        )
        await add('gracia vigente con prueba vencida, con Stripe', 'PAGADO', v =>
          planRow(v, 'PRO', { endDate: hace(DAY), gracePeriodEndsAt: dentroDe(2 * DAY), stripeSubscriptionId: `sub_ograce_${PAG}` }),
        )
        await add('gracia vigente con prueba vencida, sin Stripe', 'CORTESIA', v =>
          planRow(v, 'PRO', { endDate: hace(DAY), gracePeriodEndsAt: dentroDe(2 * DAY) }),
        )
        await add('prueba vencida sin Stripe', 'GRATIS', v => planRow(v, 'PRO', { endDate: hace(DAY) }))
        await add('primer pago fallido', 'GRATIS', v =>
          planRow(v, 'PRO', { active: false, suspendedAt: hace(DAY), stripeSubscriptionId: `sub_ofail1_${PAG}`, paymentFailureCount: 1 }),
        )
        await add('cuarto intento', 'GRATIS', v =>
          planRow(v, 'PREMIUM', {
            active: false,
            suspendedAt: hace(2 * DAY),
            gracePeriodEndsAt: dentroDe(DAY),
            stripeSubscriptionId: `sub_ofail4_${PAG}`,
            paymentFailureCount: 4,
          }),
        )
        await add('corte de los 14 días', 'GRATIS', v => planRow(v, 'PRO', { active: false, suspendedAt: hace(15 * DAY) }))
        await add('suscripción borrada', 'GRATIS', v => planRow(v, 'PRO', { active: false, stripeSubscriptionId: `sub_ogone_${PAG}` }))
        await add('cortesía y luego Gratis', 'GRATIS', v => planRow(v, 'PREMIUM', { active: false, endDate: hace(3_600_000) }))
        await add('dos filas (retirada + vigente)', 'PAGADO', async v => {
          await planRow(v, 'PREMIUM', { active: false, endDate: hace(5 * DAY) })
          await planRow(v, 'PRO', { stripeSubscriptionId: `sub_otwo_${PAG}` })
        })
        await add('🔴 Codex r3 #1: prueba Pro cancelada con endDate futuro + Premium suspendido después', 'GRATIS', async v => {
          await planRow(v, 'PRO', { active: false, endDate: dentroDe(10 * DAY) })
          await planRow(v, 'PREMIUM', { active: false, suspendedAt: hace(DAY), stripeSubscriptionId: `sub_or3_${PAG}` })
        })
        await add('🔴 Codex r3 #2: contrato Premium con concesión vigente y SIN fila clásica', 'CAMPANA', v =>
          contract(v, 'PREMIUM', hace(10 * DAY), dentroDe(20 * DAY)),
        )
        await add('contrato Pro con concesión vigente y la fila clásica retirada', 'CAMPANA', async v => {
          await planRow(v, 'PRO', { active: false, endDate: hace(5 * DAY) })
          await contract(v, 'PRO', hace(10 * DAY), dentroDe(20 * DAY))
        })
        await add('contrato con la concesión vencida', 'GRATIS', v => contract(v, 'PREMIUM', hace(40 * DAY), hace(10 * DAY)))
        await add('grandfather sin plan', 'DE_ANTES', async () => undefined, { seatCapExempt: true })
      })

      it('🔴 oráculo: con Stripe caído, estado, origen y nivel de cada sucursal = getPlanState y getVenuePlanInfo', async () => {
        clockAt(NOW)
        const leidas = await planesPorSucursal(
          sembradas.map(s => s.organizationId),
          NOW,
        )
        const oraculo: Record<string, { nivel: string; estado: string; origen: string }> = {}
        for (const s of sembradas) {
          const state = await planStateService.getPlanState(s.venueId)
          oraculo[s.venueId] = { nivel: (await getVenuePlanInfo(s.venueId)).tier, estado: state.state, origen: state.origin!.kind }
        }
        jest.useRealTimers()
        // The degraded path of the oracle really ran (rows with a Stripe subscription asked and failed).
        expect(stripeCaido).toHaveBeenCalled()
        expect(leidas).toHaveLength(sembradas.length)
        const porSucursal = new Map(leidas.map(leida => [leida.venueId, leida]))
        for (const s of sembradas) {
          const leida = porSucursal.get(s.venueId)!
          expect({ name: s.name, nivel: leida.nivel, estado: leida.estado, origen: leida.origen }).toEqual({
            name: s.name,
            ...oraculo[s.venueId],
          })
          expect({ name: s.name, condicion: leida.condicion }).toEqual({ name: s.name, condicion: s.condicion })
        }
        // Every origin and several levels are covered, so the parity is not vacuous.
        expect(new Set(leidas.map(leida => leida.origen))).toEqual(new Set(['CLASSIC', 'CONTRACT', 'COMP', 'NONE']))
        expect(new Set(leidas.map(leida => leida.nivel))).toEqual(new Set(['FREE', 'PRO', 'PREMIUM']))
      })

      it('pagoVencido: prueba vencida con gracia vigente → PRO, condición según su origen (PAGADO / CORTESIA) y pagoVencido', async () => {
        const conStripe = sembradas.find(s => s.name === 'gracia vigente con prueba vencida, con Stripe')!
        const sinStripe = sembradas.find(s => s.name === 'gracia vigente con prueba vencida, sin Stripe')!
        clockAt(NOW)
        const planes = await planDeLaPagina([conStripe.organizationId, sinStripe.organizationId], NOW)
        jest.useRealTimers()
        expect(planes.get(conStripe.organizationId)).toMatchObject({ nivel: 'PRO', condicion: 'PAGADO', pagoVencido: true })
        expect(planes.get(sinStripe.organizationId)).toMatchObject({ nivel: 'PRO', condicion: 'CORTESIA', pagoVencido: true })
      })

      it('🔴 Codex r3 #1: prueba Pro cancelada con endDate futuro + Premium suspendido después → GRATIS sin marca', async () => {
        const caso = sembradas.find(s => s.name.startsWith('🔴 Codex r3 #1'))!
        clockAt(NOW)
        const plan = (await planDeLaPagina([caso.organizationId], NOW)).get(caso.organizationId)!
        jest.useRealTimers()
        expect(plan).toEqual({
          nivel: 'FREE',
          condicion: 'GRATIS',
          campana: null,
          campanaAceptada: null,
          pagoVencido: false,
          variaPorSucursal: false,
          sucursalesLeidas: 1,
          sucursalesTotales: 1,
        })
      })

      it('el contrato sin fila clásica lleva el nombre de su publicación como campaña', async () => {
        const caso = sembradas.find(s => s.name.startsWith('🔴 Codex r3 #2'))!
        clockAt(NOW)
        const plan = (await planDeLaPagina([caso.organizationId], NOW)).get(caso.organizationId)!
        jest.useRealTimers()
        const { name } = await prisma.hybridOfferPublication.findFirstOrThrow({
          where: { contracts: { some: { venueId: caso.venueId } } },
          select: { name: true },
        })
        expect(plan).toMatchObject({ nivel: 'PREMIUM', condicion: 'CAMPANA', campana: name })
      })

      it('dos sucursales: la del nivel más alto manda y «varía por sucursal»; pagoVencido si alguna', async () => {
        const { organizationId, venueId } = await orgP('mix')
        await planRow(venueId, 'PRO', { endDate: hace(DAY), gracePeriodEndsAt: dentroDe(2 * DAY), stripeSubscriptionId: `sub_mix1_${PAG}` })
        await planRow(await venue(organizationId), 'PREMIUM')
        clockAt(NOW)
        const plan = (await planDeLaPagina([organizationId], NOW)).get(organizationId)!
        jest.useRealTimers()
        expect(plan).toMatchObject({
          nivel: 'PREMIUM',
          condicion: 'CORTESIA',
          pagoVencido: true,
          variaPorSucursal: true,
          sucursalesLeidas: 2,
        })
      })
    })

    describe('la campaña de lanzamiento ($10): una nota, no una condición', () => {
      it('🔴 canje APPLIED de $10 × 3 meses → condición canónica PAGADO (igual que getPlanState) y campanaAceptada con lo aceptado', async () => {
        const { organizationId, venueId } = await orgP('canje')
        await planRow(venueId, 'PRO', { stripeSubscriptionId: `sub_canje_${PAG}` })
        const reservedAt = hace(2 * DAY)
        await canje(organizationId, await campana(`Lanzamiento ${PAG}`), {
          status: 'APPLIED',
          reservedAt,
          appliedAt: hace(2 * DAY - 60_000),
        })
        const row = await filaDe(organizationId)
        clockAt(NOW)
        const oraculo = await planStateService.getPlanState(venueId)
        jest.useRealTimers()
        expect([oraculo.origin!.kind, oraculo.state]).toEqual(['CLASSIC', 'active'])
        expect(row!.plan).toMatchObject({
          nivel: 'PRO',
          condicion: 'PAGADO',
          campanaAceptada: { nombre: `Lanzamiento ${PAG}`, precioMensual: 10, meses: 3, aceptadaEl: reservedAt },
        })
      })

      it('🔴 Codex r4 #2: reservado el 6-nov y recuperado (APPLIED) el 9-nov → aceptadaEl = 6-nov; sin «vigente», «hasta» ni fin calculado', async () => {
        const { organizationId, venueId } = await orgP('recuperado')
        await planRow(venueId, 'PRO', { stripeSubscriptionId: `sub_recup_${PAG}` })
        const seis = new Date('2026-11-06T16:00:00.000Z')
        await canje(organizationId, await campana(`Recuperada ${PAG}`), {
          status: 'APPLIED',
          reservedAt: seis,
          appliedAt: new Date('2026-11-09T16:00:00.000Z'),
        })
        const row = await filaDe(organizationId)
        expect(row!.plan.campanaAceptada).toEqual({ nombre: `Recuperada ${PAG}`, precioMensual: 10, meses: 3, aceptadaEl: seis })
        const texto = JSON.stringify(row!.plan)
        expect(texto).not.toMatch(/vigente|hasta|fin|ends|until|appliedAt/i)
        expect(Object.keys(row!.plan.campanaAceptada!).sort()).toEqual(['aceptadaEl', 'meses', 'nombre', 'precioMensual'])
      })

      it('canje RELEASED o sólo RESERVED → campanaAceptada null', async () => {
        const liberado = await orgP('liberado')
        await planRow(liberado.venueId, 'PRO', { stripeSubscriptionId: `sub_lib_${PAG}` })
        await canje(liberado.organizationId, await campana(`Liberada ${PAG}`), { status: 'RELEASED', releasedAt: hace(DAY) })
        const reservado = await orgP('reservado')
        await planRow(reservado.venueId, 'PRO', { stripeSubscriptionId: `sub_res_${PAG}` })
        await canje(reservado.organizationId, await campana(`Reservada ${PAG}`), { status: 'RESERVED' })
        expect((await filaDe(liberado.organizationId))!.plan.campanaAceptada).toBeNull()
        expect((await filaDe(reservado.organizationId))!.plan.campanaAceptada).toBeNull()
      })
    })

    it('con 21 sucursales → sucursalesLeidas 20 y el nivel sigue siendo el de SQL (la condición queda vacía)', async () => {
      const { organizationId } = await orgP('veintiuno')
      // Twenty more, older-to-newer, the newest (21st) with Premium: SQL sees it, the page does not read it.
      let ultima = ''
      for (let i = 0; i < 20; i++) {
        const key = `${PAG}v21x${i}`
        ultima = (
          await prisma.venue.create({
            data: {
              organizationId,
              name: `N ${key}`,
              slug: `v-${key}`,
              status: VenueStatus.ACTIVE,
              createdAt: new Date(Date.now() + (i + 1) * 60_000),
            },
          })
        ).id
        venueIds.push(ultima)
      }
      await planRow(ultima, 'PREMIUM')
      const row = await filaDe(organizationId)
      expect(row!.plan).toMatchObject({ nivel: 'PREMIUM', condicion: null, sucursalesLeidas: 20, sucursalesTotales: 21 })
    })

    it('🔴 una página de 100 organizaciones no llama a Stripe ni a getPlanState', async () => {
      const CIEN = `cien${Date.now()}`
      const orgs = await prisma.organization.createManyAndReturn({
        data: Array.from({ length: 100 }, (_, i) => ({
          name: `Cien ${CIEN} ${i}`,
          email: `cien-${CIEN}-${i}@test.mx`,
          phone: '5555555555',
        })),
        select: { id: true },
      })
      organizationIds.push(...orgs.map(o => o.id))
      const venues = await prisma.venue.createManyAndReturn({
        data: orgs.map((o, i) => ({ organizationId: o.id, name: `N ${CIEN}${i}`, slug: `v-${CIEN}-${i}`, status: VenueStatus.ACTIVE })),
        select: { id: true },
      })
      venueIds.push(...venues.map(v => v.id))
      await prisma.venueFeature.createMany({
        data: venues.map((v, i) => ({
          venueId: v.id,
          featureId: planProId,
          monthlyPrice: 999,
          active: true,
          stripeSubscriptionId: `sub_cien_${CIEN}_${i}`,
          startDate: hace(30 * DAY),
        })),
      })
      const planState = jest.spyOn(planStateService, 'getPlanState')
      stripeCaido.mockClear()
      try {
        const page = await pagina(todos(), { q: CIEN })
        expect(page.rows).toHaveLength(100)
        expect(page.rows.every(row => row.plan.condicion === 'PAGADO')).toBe(true)
        expect(planState).not.toHaveBeenCalled()
        expect(stripeCaido).not.toHaveBeenCalled()
      } finally {
        planState.mockRestore()
      }
    })

    it('aparatos: 3 TPV_ANDROID (1 RETIRED), 1 POS_ANDROID, 1 PRINTER_KITCHEN → { terminales: 2, pos: 1 }', async () => {
      const { organizationId, venueId } = await orgP('aparatos')
      await sale(venueId, { source: 'TPV', payment: { source: 'TPV' } })
      await terminal(venueId, 'TPV_ANDROID')
      await terminal(venueId, 'TPV_ANDROID')
      await prisma.terminal.update({ where: { id: await terminal(venueId, 'TPV_ANDROID') }, data: { status: 'RETIRED' } })
      await terminal(venueId, 'POS_ANDROID')
      await terminal(venueId, 'PRINTER_KITCHEN')
      expect((await filaDe(organizationId))!.usa.aparatos).toEqual({ terminales: 2, pos: 1 })
    })

    describe('datos del alta (sólo en las filas 🟠)', () => {
      it('una alta con campaña de $10 → oferta CAMPANA con su nombre; una sin campaña → LISTA; C8: con oferta híbrida → OFERTA con su slug', async () => {
        const conCampana = await altaP('altaCampana', { launchCampaignId: await campana(`Diez ${PAG}`) })
        const lista = await altaP('altaLista')
        const oferta = await altaP('altaOferta', { v2SetupData: { hybrid: { hybridOfferSlug: 'combo-pro-10' } } })
        expect((await filaDe(conCampana.organizationId))!.alta!.oferta).toEqual({ tipo: 'CAMPANA', nombre: `Diez ${PAG}` })
        expect((await filaDe(lista.organizationId))!.alta!.oferta).toEqual({ tipo: 'LISTA', nombre: null })
        expect((await filaDe(oferta.organizationId))!.alta!.oferta).toEqual({ tipo: 'OFERTA', nombre: 'combo-pro-10' })
      })

      it('acquisitionSource landing_oferta → LANDING; dashboard_signup → DIRECTO; con negocioCreadoAt y ultimaVezAt', async () => {
        const landing = await altaP('altaLanding', { acquisitionSource: 'landing_oferta' })
        const directo = await altaP('altaDirecto', { acquisitionSource: 'dashboard_signup' })
        const row = (await filaDe(landing.organizationId))!
        expect(row.alta!.origen).toBe('LANDING')
        expect((await filaDe(directo.organizationId))!.alta!.origen).toBe('DIRECTO')
        const [{ createdAt }, { updatedAt }] = await Promise.all([
          prisma.venue.findUniqueOrThrow({ where: { id: landing.venueId }, select: { createdAt: true } }),
          prisma.onboardingProgress.findUniqueOrThrow({ where: { organizationId: landing.organizationId }, select: { updatedAt: true } }),
        ])
        expect([row.alta!.negocioCreadoAt, row.alta!.ultimaVezAt]).toEqual([createdAt, updatedAt])
      })

      it('planActivationStatus DECLINED → RECHAZADA; IN_PROGRESS → SIN_TERMINAR; attempt 0 → NO_INTENTO (sin inventar el motivo del banco)', async () => {
        const rechazada = await altaP('altaRechazada', { planActivationStatus: 'DECLINED', planActivationAttempt: 1 })
        const enCurso = await altaP('altaEnCurso', { planActivationStatus: 'IN_PROGRESS' })
        const nada = await altaP('altaNada')
        const alta = (await filaDe(rechazada.organizationId))!.alta!
        expect(alta.tarjeta).toBe('RECHAZADA')
        expect(Object.keys(alta)).not.toContain('motivoDelBanco')
        expect((await filaDe(enCurso.organizationId))!.alta!.tarjeta).toBe('SIN_TERMINAR')
        expect((await filaDe(nada.organizationId))!.alta!.tarjeta).toBe('NO_INTENTO')
      })

      it('una fila que no es 🟠 trae alta null', async () => {
        const { organizationId, venueId } = await orgP('cobra')
        await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [], acquisitionSource: 'landing' } })
        await sale(venueId, { source: 'TPV', payment: { source: 'TPV' } })
        const row = (await filaDe(organizationId))!
        expect([row.estado.codigo, row.alta]).toEqual(['COBRA', null])
      })

      it('el motivo y «Perdido» de una cuenta ajena no salen (cuentaAjena lo explica)', async () => {
        const deB = await altaP('altaMotivoB')
        await cuenta(deB.organizationId, B, { altaMotivo: 'OTRO', altaMotivoTexto: 'Lo pensará', altaPerdido: true })
        const paraA = (await filaDe(deB.organizationId, propios(A)))!
        expect(paraA.cuentaAjena).toBe(true)
        expect(paraA.alta).toMatchObject({ motivo: null, motivoTexto: null, perdido: false })
        const paraB = (await filaDe(deB.organizationId, propios(B)))!
        expect(paraB.alta).toMatchObject({ motivo: 'OTRO', motivoTexto: 'Lo pensará', perdido: true })
      })

      it('liveOf de una alta sin tarjeta trae sus datos del alta', async () => {
        const { organizationId } = await altaP('altaVivo', { acquisitionSource: 'dashboard_signup', planActivationStatus: 'DECLINED' })
        const live = await getClientLive(todos(), organizationId, NOW)
        expect(live).toMatchObject({
          alta: { terminada: false, origen: 'DIRECTO', tarjeta: 'RECHAZADA', oferta: { tipo: 'LISTA', nombre: null } },
        })
      })

      it('🔴 liveOf de un negocio que PAGA con su alta sin cerrar (cobro real, o plan con Stripe) no trae los hechos del alta; un 🟠 sí', async () => {
        const cobra = await altaP('vivoCobra', { acquisitionSource: null })
        await sale(cobra.venueId, { source: 'TPV', payment: { source: 'TPV' } })
        const conStripe = await altaP('vivoStripe', { acquisitionSource: null })
        await planRow(conStripe.venueId, 'PRO', { stripeSubscriptionId: `sub_vivo_${PAG}` })
        const naranja = await altaP('vivoNaranja')
        const HECHOS = ['negocioCreadoAt', 'ultimaVezAt', 'oferta', 'origen', 'tarjeta']

        for (const { organizationId } of [cobra, conStripe]) {
          const { alta } = (await getClientLive(todos(), organizationId, NOW)) as { alta: Record<string, unknown> }
          expect(alta).toMatchObject({ terminada: false, totales: 8 })
          for (const hecho of HECHOS) expect(alta).not.toHaveProperty(hecho)
        }
        const { alta } = (await getClientLive(todos(), naranja.organizationId, NOW)) as { alta: Record<string, unknown> }
        for (const hecho of HECHOS) expect(alta).toHaveProperty(hecho)
        expect(alta).toMatchObject({ tarjeta: 'NO_INTENTO', origen: 'LANDING' })
      })
    })

    describe('último comentario', () => {
      it('🔴 el último comentario de la cuenta de B no le sale a A (ni el texto ni el autor); a B, el más nuevo', async () => {
        const { organizationId } = await altaP('notaB')
        const accountId = await cuenta(organizationId, B)
        await prisma.crmTimelineEvent.create({
          data: { accountId, kind: 'NOTE', actorStaffId: B, data: { text: 'La vieja' }, createdAt: hace(2 * DAY) },
        })
        await prisma.crmTimelineEvent.create({
          data: { accountId, kind: 'NOTE', actorStaffId: B, data: { text: 'Quiere Pro' }, createdAt: hace(DAY) },
        })
        await prisma.crmTimelineEvent.create({
          data: { accountId, kind: 'STAGE_CHANGE', actorStaffId: B, data: {}, createdAt: hace(1000) },
        })
        const paraA = (await filaDe(organizationId, propios(A)))!
        expect([paraA.cuentaAjena, paraA.ultimoComentario]).toEqual([true, null])
        expect(JSON.stringify(paraA)).not.toContain('Quiere Pro')
        expect((await filaDe(organizationId, propios(B)))!.ultimoComentario).toEqual({
          texto: 'Quiere Pro',
          autor: { id: B, name: 'Beto Página' },
          at: hace(DAY),
        })
      })

      it('un comentario de 300 letras sale recortado a 140 con «…»', async () => {
        const { organizationId } = await altaP('notaLarga')
        const accountId = await cuenta(organizationId, A)
        await prisma.crmTimelineEvent.create({ data: { accountId, kind: 'NOTE', actorStaffId: A, data: { text: 'ñ'.repeat(300) } } })
        const { texto } = (await filaDe(organizationId, propios(A)))!.ultimoComentario!
        expect([...texto]).toHaveLength(140)
        expect(texto).toBe(`${'ñ'.repeat(139)}…`)
      })
    })

    describe('conteos por motivo (sobre el universo con q y ocultos)', () => {
      const CONT = `cont${Date.now()}`
      beforeAll(async () => {
        const alta = async (key: string) => {
          const { id } = await prisma.organization.create({
            data: { name: `Cont ${CONT} ${key}`, email: `cont-${CONT}-${key}@test.mx`, phone: '5555555555' },
          })
          organizationIds.push(id)
          await venue(id)
          await prisma.onboardingProgress.create({ data: { organizationId: id, completedSteps: [], acquisitionSource: 'landing' } })
          return id
        }
        await cuenta(await alta('a1'), A, { altaMotivo: 'PRECIO' })
        await cuenta(await alta('a2'), A, { altaMotivo: 'PRECIO' })
        await cuenta(await alta('a3'), A)
        await cuenta(await alta('b1'), B, { altaMotivo: 'PRECIO' })
      })
      const conteosDe = async (access: CrmAccess, filters: ClientFilters = {}) =>
        (await listClients(access, { q: CONT, altas: true, ...filters }, NOW)).conteos!

      it('🔴 3 🟠 de A (PRECIO, PRECIO, sin motivo) y 1 de B con PRECIO → para A PRECIO 2, SIN_MOTIVO 1, DE_OTRO 1; para «todos» PRECIO 3', async () => {
        const deA = await conteosDe(propios(A))
        expect(deA).toMatchObject({ altaSinTarjeta: 4, porMotivo: { PRECIO: 2, SIN_MOTIVO: 1, DE_OTRO: 1, OTRO: 0 }, perdidos: 0 })
        const deTodos = await conteosDe(todos())
        expect(deTodos).toMatchObject({ altaSinTarjeta: 4, porMotivo: { PRECIO: 3, SIN_MOTIVO: 1, DE_OTRO: 0 } })
        // The reasons add up to the stalled signups for each viewer.
        for (const c of [deA, deTodos]) expect(Object.values(c.porMotivo).reduce((a, b) => a + b, 0)).toBe(c.altaSinTarjeta)
      })

      it('conteos no cambia al filtrar por usa o por motivo', async () => {
        const base = await conteosDe(propios(A))
        expect(await conteosDe(propios(A), { usa: 'TERMINAL' })).toEqual(base)
        expect(await conteosDe(propios(A), { motivo: 'PRECIO' })).toEqual(base)
        expect(await conteosDe(propios(A), { estado: 'COBRA', altas: true })).toEqual(base)
      })

      it('🔴 A busca por nombre la organización de B marcada perdida → perdidos = 0, DE_OTRO = 1, y la fila no dice «Perdido»', async () => {
        const PERD = `perd${Date.now()}`
        const { id } = await prisma.organization.create({
          data: { name: `Perd ${PERD}`, email: `perd-${PERD}@test.mx`, phone: '5555555555' },
        })
        organizationIds.push(id)
        await venue(id)
        await prisma.onboardingProgress.create({ data: { organizationId: id, completedSteps: [], acquisitionSource: 'landing' } })
        await cuenta(id, B, { altaMotivo: 'PRECIO', altaPerdido: true })
        const paraA = await listClients(propios(A), { q: PERD, altas: true }, NOW)
        expect(paraA.conteos).toMatchObject({ altaSinTarjeta: 1, perdidos: 0, porMotivo: { DE_OTRO: 1, PRECIO: 0 } })
        expect(paraA.rows[0].alta).toMatchObject({ perdido: false, motivo: null })
        const paraB = await listClients(propios(B), { q: PERD, altas: true }, NOW)
        expect(paraB.conteos).toMatchObject({ perdidos: 1, porMotivo: { DE_OTRO: 0, PRECIO: 1 } })
        expect(paraB.rows[0].alta).toMatchObject({ perdido: true })
      })
    })
  })

  // ── Asegurar la cuenta de un cliente que no la tiene (Tarea 6) ───────────────────────────────────────────────────────

  describe('asegurar la cuenta (Tarea 6)', () => {
    const CU = `cu${Date.now()}`
    const todos = () => ({ staffId, isSuperadmin: true, ver: 'todos', editar: 'todos', configurar: true }) as unknown as CrmAccess
    const erasedHashesMade: string[] = []

    async function cliente() {
      const made = await orgWithVenue()
      await sale(made.venueId, { source: 'TPV', payment: { source: 'TPV' } })
      return made.organizationId
    }
    async function cuentaDe(organizationId: string) {
      const account = await prisma.crmAccount.findUniqueOrThrow({ where: { organizationId }, include: { stage: true } })
      crmAccountIds.push(account.id)
      return account
    }
    const eventos = (accountId: string) =>
      prisma.crmTimelineEvent.findMany({ where: { accountId, kind: 'SYSTEM' }, select: { data: true, actorStaffId: true }, take: 10 })

    beforeAll(async () => {
      // The shared catalog may hold no «Ganado» (only stages other suites made): this file's own, first by order.
      const stage = await prisma.crmStage.create({ data: { name: `Ganado ${CU}`, order: -1000, kind: 'GANADA' } })
      const abierta = await prisma.crmStage.create({ data: { name: `Abierta ${CU}`, order: -1000, kind: 'ABIERTA' } })
      crmStageIds.push(stage.id, abierta.id)
    })

    afterAll(async () => {
      if (erasedHashesMade.length) await prisma.crmErased.deleteMany({ where: { keyHash: { in: erasedHashesMade } } })
    })

    it('cliente → etapa GANADA, sin dueño, wonAt nulo, fuente CLIENTE y su evento', async () => {
      const organizationId = await cliente()
      const out = await ensureClientAccount(todos(), organizationId)
      expect(out.creada).toBe(true)
      const account = await cuentaDe(organizationId)
      expect(account).toMatchObject({ id: out.accountId, source: 'CLIENTE', ownerStaffId: null, wonAt: null })
      expect(account.stage.kind).toBe('GANADA')
      expect(account.name).toContain('Org ')
      expect(await eventos(account.id)).toEqual([{ data: { event: 'CLIENT_ACCOUNT_OPENED' }, actorStaffId: staffId }])
      // `logAction` is mocked in this project: what is audited is what the mock received.
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CRM_CLIENT_ACCOUNT_CREATED',
          entityId: account.id,
          venueId: null,
          organizationId,
          data: { organizationId, source: 'CLIENTE' },
        }),
      )
      // The second call finds it: nothing new.
      await expect(ensureClientAccount(todos(), organizationId)).resolves.toEqual({ accountId: account.id, creada: false })
      expect(await eventos(account.id)).toHaveLength(1)
    })

    it('alta sin tarjeta → etapa ABIERTA, fuente ALTA', async () => {
      const organizationId = await org()
      await venue(organizationId)
      await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [], acquisitionSource: 'landing' } })
      await ensureClientAccount(todos(), organizationId)
      const account = await cuentaDe(organizationId)
      expect(account).toMatchObject({ source: 'ALTA', ownerStaffId: null, wonAt: null })
      expect(account.stage.kind).toBe('ABIERTA')
    })

    it('🔴 una organización que no es cliente es 404 CRM_NO_ES_CLIENTE y no crea nada', async () => {
      const { organizationId } = await orgWithVenue()
      await expect(ensureClientAccount(todos(), organizationId)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_NO_ES_CLIENTE' })
      expect(await prisma.crmAccount.count({ where: { organizationId } })).toBe(0)
    })

    it('🔴 con una lápida de esa organización se crea igual (es una persona a propósito), y la lápida sigue frenando al barrido', async () => {
      const organizationId = await cliente()
      const { organization } = erasedHashes({ keys: [], emails: [], phones: [], organizationId })
      await prisma.crmErased.create({ data: { keyHash: organization!, scope: '', erasedAt: hace(DAY) } })
      erasedHashesMade.push(organization!)
      await expect(ensureClientAccount(todos(), organizationId)).resolves.toMatchObject({ creada: true })
      await cuentaDe(organizationId)
      // The tombstone is untouched: every automatic writer still meets it.
      expect(await erasedAtTx(prisma, { keys: [], emails: [], phones: [], organizationId })).not.toBeNull()
    })

    it('🔴 la cuenta ya es de B y A es «propios» → 404 CRM_ACCOUNT_NOT_FOUND, sin evento ni bitácora nuevos', async () => {
      const A = (await prisma.staff.create({ data: { email: `a-${CU}@test.mx`, firstName: 'Ana', lastName: 'Cuenta' } })).id
      const B = (await prisma.staff.create({ data: { email: `b-${CU}@test.mx`, firstName: 'Beto', lastName: 'Cuenta' } })).id
      sellerIds.push(A, B)
      const organizationId = await cliente()
      await ensureClientAccount(todos(), organizationId)
      const account = await cuentaDe(organizationId)
      await prisma.crmAccount.update({ where: { id: account.id }, data: { ownerStaffId: B } })
      const propios = { staffId: A, isSuperadmin: false, ver: 'propios', editar: 'propios' } as unknown as CrmAccess
      await expect(ensureClientAccount(propios, organizationId)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_ACCOUNT_NOT_FOUND' })
      expect(await eventos(account.id)).toHaveLength(1)
      expect(jest.mocked(logAction).mock.calls.filter(([call]) => call.entityId === account.id)).toHaveLength(1)
    })

    it('vecina: los reportes de ganados del mes no cuentan la cuenta creada (lee wonAt)', async () => {
      const desde = '2026-11-01'
      const hasta = '2026-11-30'
      const antes = await getReports(todos(), { desde, hasta }, NOW)
      const organizationId = await cliente()
      await ensureClientAccount(todos(), organizationId)
      await cuentaDe(organizationId)
      const despues = await getReports(todos(), { desde, hasta }, NOW)
      expect(despues.ganados).toEqual(antes.ganados)
    })
  })
  describe('«✋ a mano» en Usa (Tarea 7)', () => {
    const todos = () => ({ staffId, isSuperadmin: true, ver: 'todos', editar: 'todos', configurar: true }) as unknown as CrmAccess

    /** A client (it sold) with its CRM account; `ventas` = how many days ago its sales were (the source decides what is measured). */
    async function cliente(ventas: Array<{ source: OrderSource; dias: number }>) {
      const made = await orgWithVenue()
      for (const v of ventas)
        await sale(made.venueId, { source: v.source, at: hace(v.dias * DAY), payment: { source: v.source === 'TPV' ? 'TPV' : 'APP' } })
      const { accountId } = await ensureClientAccount(todos(), made.organizationId)
      crmAccountIds.push(accountId)
      const { name } = await prisma.organization.findUniqueOrThrow({ where: { id: made.organizationId }, select: { name: true } })
      const fila = async () => (await listClients(todos(), { q: name }, NOW)).rows.find(row => row.id === made.organizationId)!
      return { ...made, accountId, fila }
    }
    const usaEvents = (accountId: string) =>
      prisma.crmTimelineEvent.findMany({
        where: { accountId, kind: 'USA_CHANGE' },
        orderBy: { createdAt: 'asc' },
        select: { data: true, actorStaffId: true },
        take: 10,
      })

    it('✋ POS con lo medido TERMINAL → la lista dice visto POS, manual, aviso; el ActivityLog no lleva el porqué', async () => {
      const c = await cliente([{ source: 'TPV', dias: 3 }])
      await expect(setUsa(todos(), c.accountId, { valor: 'POS', porque: 'Lo vi en su local' })).resolves.toEqual({
        accountId: c.accountId,
        usaManual: 'POS',
      })
      expect((await c.fila()).usa).toMatchObject({ visto: 'POS', medido: 'TERMINAL', manual: true, aviso: true })
      expect(await usaEvents(c.accountId)).toEqual([{ data: { valor: 'POS', porque: 'Lo vi en su local' }, actorStaffId: staffId }])
      const call = jest
        .mocked(logAction)
        .mock.calls.map(([x]) => x)
        .find(x => x.entityId === c.accountId && x.action === 'CRM_CLIENT_USA_SET')!
      expect(call).toMatchObject({ venueId: null, organizationId: c.organizationId, data: { valor: 'POS' } })
      expect(JSON.stringify(call)).not.toContain('local')
    })

    it('🔴 lo medido cambia después (sale una venta POS): visto sigue POS y el aviso se apaga solo', async () => {
      const c = await cliente([{ source: 'TPV', dias: 40 }])
      await setUsa(todos(), c.accountId, { valor: 'POS', porque: 'Usa la tableta' })
      expect((await c.fila()).usa).toMatchObject({ visto: 'POS', medido: 'NINGUNO', aviso: true })
      await sale(c.venueId, { source: 'AVOQADO_ANDROID', payment: { source: 'APP' } })
      expect((await c.fila()).usa).toMatchObject({ visto: 'POS', medido: 'POS', manual: true, aviso: false })
    })

    it('✋ TERMINAL en un cliente que no vendió en 30 días → aviso', async () => {
      const c = await cliente([{ source: 'TPV', dias: 40 }])
      await setUsa(todos(), c.accountId, { valor: 'TERMINAL', porque: 'La tiene en caja' })
      expect((await c.fila()).usa).toMatchObject({ visto: 'TERMINAL', medido: 'NINGUNO', aviso: true })
    })

    it('«Leerlo solo» → manual false, visto = medido, su evento; repetirlo no deja otro', async () => {
      const c = await cliente([{ source: 'TPV', dias: 3 }])
      await setUsa(todos(), c.accountId, { valor: 'POS', porque: 'Lo vi en su local' })
      await setUsa(todos(), c.accountId, { valor: null })
      expect((await c.fila()).usa).toMatchObject({ visto: 'TERMINAL', medido: 'TERMINAL', manual: false, aviso: false })
      expect(
        await prisma.crmAccount.findUniqueOrThrow({
          where: { id: c.accountId },
          select: { usaManual: true, usaManualPorque: true, usaManualById: true, usaManualAt: true },
        }),
      ).toEqual({
        usaManual: null,
        usaManualPorque: null,
        usaManualById: null,
        usaManualAt: null,
      })
      expect((await usaEvents(c.accountId)).map(e => (e.data as { valor: string | null }).valor)).toEqual(['POS', null])
      await setUsa(todos(), c.accountId, { valor: null })
      expect(await usaEvents(c.accountId)).toHaveLength(2)
    })

    it('dos personas lo ponen a la vez → dos eventos USA_CHANGE y queda el último', async () => {
      const c = await cliente([{ source: 'TPV', dias: 3 }])
      await Promise.all([
        setUsa(todos(), c.accountId, { valor: 'POS', porque: 'Primera persona' }),
        setUsa(todos(), c.accountId, { valor: 'AMBOS', porque: 'Segunda persona' }),
      ])
      const eventos = await usaEvents(c.accountId)
      expect(eventos).toHaveLength(2)
      const guardado = await prisma.crmAccount.findUniqueOrThrow({
        where: { id: c.accountId },
        select: { usaManual: true, usaManualPorque: true },
      })
      expect(eventos[1].data).toEqual({ valor: guardado.usaManual, porque: guardado.usaManualPorque })
    })

    it('🔴 copia vieja: A abre con TERMINAL, B guarda AMBOS, A guarda con lo que vio → 409 CRM_CAMBIO_AL_EDITAR y queda lo de B', async () => {
      const c = await cliente([{ source: 'TPV', dias: 3 }])
      await setUsa(todos(), c.accountId, { valor: 'TERMINAL', porque: 'La tiene en caja' })
      const vioA = { valor: 'TERMINAL' as const, porque: 'La tiene en caja' }
      await setUsa(todos(), c.accountId, { valor: 'AMBOS', porque: 'Lo cambió B', vio: vioA })
      const leer = () =>
        prisma.crmAccount.findUniqueOrThrow({
          where: { id: c.accountId },
          select: { usaManual: true, usaManualPorque: true, lastTouchAt: true },
        })
      const deB = await leer()
      await expect(setUsa(todos(), c.accountId, { valor: 'POS', porque: 'Lo dijo A', vio: vioA })).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_CAMBIO_AL_EDITAR',
        message: 'Cambió mientras lo editabas: revisa y guarda otra vez.',
      })
      expect(await leer()).toEqual(deB)
      expect(deB).toMatchObject({ usaManual: 'AMBOS', usaManualPorque: 'Lo cambió B' })
      expect((await usaEvents(c.accountId)).map(e => (e.data as { valor: string }).valor)).toEqual(['TERMINAL', 'AMBOS'])
      // Con lo que hay ahora (lo fresco), A sí guarda.
      await setUsa(todos(), c.accountId, { valor: 'POS', porque: 'Lo dijo A', vio: { valor: 'AMBOS', porque: 'Lo cambió B' } })
      expect(await leer()).toMatchObject({ usaManual: 'POS', usaManualPorque: 'Lo dijo A' })
    })
  })
  describe('«¿Por qué se quedó?» (Tarea 8)', () => {
    const todos = () => ({ staffId, isSuperadmin: true, ver: 'todos', editar: 'todos', configurar: true }) as unknown as CrmAccess
    async function altaConCuenta() {
      const organizationId = await org()
      const venueId = await venue(organizationId)
      await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [], acquisitionSource: 'landing' } })
      const { accountId } = await ensureClientAccount(todos(), organizationId)
      crmAccountIds.push(accountId)
      return { organizationId, venueId, accountId }
    }
    const eventos = (accountId: string) =>
      prisma.crmTimelineEvent.findMany({
        where: { accountId, kind: 'ALTA_MOTIVO' },
        orderBy: { createdAt: 'asc' },
        select: { data: true },
        take: 10,
      })

    it('escribe motivo, texto y Perdido; el ActivityLog no lleva el texto; repetirlo no deja otro evento', async () => {
      const c = await altaConCuenta()
      await setAltaMotivo(todos(), c.accountId, { motivo: 'OTRO', texto: 'Se fue con su cuñado', perdido: true })
      expect(
        await prisma.crmAccount.findUniqueOrThrow({
          where: { id: c.accountId },
          select: { altaMotivo: true, altaMotivoTexto: true, altaPerdido: true },
        }),
      ).toEqual({
        altaMotivo: 'OTRO',
        altaMotivoTexto: 'Se fue con su cuñado',
        altaPerdido: true,
      })
      expect(await eventos(c.accountId)).toEqual([{ data: { motivo: 'OTRO', texto: 'Se fue con su cuñado', perdido: true } }])
      const call = jest
        .mocked(logAction)
        .mock.calls.map(([x]) => x)
        .find(x => x.entityId === c.accountId && x.action === 'CRM_CLIENT_ALTA_MOTIVO_SET')!
      expect(call).toMatchObject({ venueId: null, organizationId: c.organizationId, data: { motivo: 'OTRO', perdido: true } })
      expect(JSON.stringify(call)).not.toContain('cuñado')
      await setAltaMotivo(todos(), c.accountId, { motivo: 'OTRO', texto: 'Se fue con su cuñado', perdido: true })
      expect(await eventos(c.accountId)).toHaveLength(1)
    })

    const filaDe = async (c: { organizationId: string }) => {
      const { name } = await prisma.organization.findUniqueOrThrow({ where: { id: c.organizationId }, select: { name: true } })
      const r = await listClients(todos(), { q: name, altas: true }, NOW)
      // Con altas=true el SERVIDOR siempre manda conteos.
      if (!r.conteos) throw new Error('faltan conteos con altas=true')
      return { fila: r.rows.find(row => row.id === c.organizationId)!, conteos: r.conteos }
    }

    it('PRECIO → la fila 🟠 dice PRECIO y conteos.porMotivo.PRECIO sube', async () => {
      const c = await altaConCuenta()
      const antes = (await filaDe(c)).conteos
      await setAltaMotivo(todos(), c.accountId, { motivo: 'PRECIO', perdido: false })
      const { fila, conteos } = await filaDe(c)
      expect(fila.alta).toMatchObject({ motivo: 'PRECIO', perdido: false })
      expect(conteos.porMotivo.PRECIO).toBe(antes.porMotivo.PRECIO + 1)
    })

    it('perdido:true → perdidos sube y la fila sigue 🟠 con «Perdido»', async () => {
      const c = await altaConCuenta()
      const antes = (await filaDe(c)).conteos
      await setAltaMotivo(todos(), c.accountId, { motivo: null, perdido: true })
      const { fila, conteos } = await filaDe(c)
      expect(fila.alta).toMatchObject({ perdido: true, motivo: null })
      expect(conteos.perdidos).toBe(antes.perdidos + 1)
      expect(conteos.altaSinTarjeta).toBe(antes.altaSinTarjeta)
    })

    it('🔴 al activar después, la fila deja de ser 🟠 y el motivo queda sólo en la Historia', async () => {
      const c = await altaConCuenta()
      await setAltaMotivo(todos(), c.accountId, { motivo: 'OTRO', texto: 'Esperaba a su socio', perdido: false })
      await sale(c.venueId, { source: 'TPV', payment: { source: 'TPV' } })
      const { fila } = await filaDe(c)
      expect(fila.alta).toBeNull()
      expect(JSON.stringify(fila)).not.toContain('socio')
      expect(await eventos(c.accountId)).toEqual([{ data: { motivo: 'OTRO', texto: 'Esperaba a su socio', perdido: false } }])
    })

    it('un 🟠 que no es alta propia (sin acquisitionSource y sin sucursal real) acepta el motivo: manda la misma regla que lo pinta', async () => {
      const organizationId = await org()
      await venue(organizationId)
      await prisma.onboardingProgress.create({ data: { organizationId, completedSteps: [] } })
      const { accountId } = await ensureClientAccount(todos(), organizationId).catch(async () => {
        // Not listed as an «alta propia»: the account is made by hand, as a seller linking the organization would.
        const stage = await prisma.crmStage.findFirstOrThrow({ where: { kind: 'ABIERTA' }, select: { id: true } })
        const made = await prisma.crmAccount.create({
          data: { name: `Mano ${suffix}`, source: 'MANUAL', stageId: stage.id, organizationId },
          select: { id: true },
        })
        return { accountId: made.id }
      })
      crmAccountIds.push(accountId)
      await expect(setAltaMotivo(todos(), accountId, { motivo: 'DESPUES', perdido: false })).resolves.toMatchObject({ motivo: 'DESPUES' })
    })

    it('un no-op no mueve lastTouchAt', async () => {
      const c = await altaConCuenta()
      await setAltaMotivo(todos(), c.accountId, { motivo: 'PRECIO', perdido: false })
      const leer = () => prisma.crmAccount.findUniqueOrThrow({ where: { id: c.accountId }, select: { lastTouchAt: true } })
      const antes = await leer()
      await new Promise(r => setTimeout(r, 20))
      await setAltaMotivo(todos(), c.accountId, { motivo: 'PRECIO', perdido: false })
      expect(await leer()).toEqual(antes)
    })

    it('🔴 cuando el negocio ya activó (cobró) → 409 CRM_ALTA_TERMINADA y no escribe', async () => {
      const c = await altaConCuenta()
      await sale(c.venueId, { source: 'TPV', payment: { source: 'TPV' } })
      await expect(setAltaMotivo(todos(), c.accountId, { motivo: 'PRECIO', perdido: false })).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_ALTA_TERMINADA',
      })
      expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: c.accountId }, select: { altaMotivo: true } })).toEqual({
        altaMotivo: null,
      })
      expect(await eventos(c.accountId)).toHaveLength(0)
    })

    it('🔴 copia vieja: A abre sin motivo, B guarda DESPUES, A guarda con lo que vio → 409 CRM_CAMBIO_AL_EDITAR y queda lo de B', async () => {
      const c = await altaConCuenta()
      const vioA = { motivo: null, texto: null, perdido: false }
      await setAltaMotivo(todos(), c.accountId, { motivo: 'DESPUES', perdido: false, vio: vioA })
      const leer = () =>
        prisma.crmAccount.findUniqueOrThrow({
          where: { id: c.accountId },
          select: { altaMotivo: true, altaMotivoTexto: true, altaPerdido: true, lastTouchAt: true },
        })
      const deB = await leer()
      await expect(setAltaMotivo(todos(), c.accountId, { motivo: null, perdido: true, vio: vioA })).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_CAMBIO_AL_EDITAR',
      })
      expect(await leer()).toEqual(deB)
      expect(deB).toMatchObject({ altaMotivo: 'DESPUES', altaPerdido: false })
      expect(await eventos(c.accountId)).toEqual([{ data: { motivo: 'DESPUES', perdido: false } }])
    })

    it('🔴 una cuenta del CRM sin organización → 409 CRM_NO_ES_ALTA', async () => {
      const { organizationId } = await altaConCuenta()
      const solo = await prisma.crmAccount.findFirstOrThrow({ where: { organizationId }, select: { stageId: true } })
      const sinOrg = await prisma.crmAccount.create({
        data: { name: `Sin org ${suffix}`, source: 'MANUAL', stageId: solo.stageId },
        select: { id: true },
      })
      crmAccountIds.push(sinOrg.id)
      await expect(setAltaMotivo(todos(), sinOrg.id, { motivo: null, perdido: true })).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_NO_ES_ALTA',
      })
    })
  })
})
