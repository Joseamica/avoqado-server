/**
 * C2 r1 — las DOS funciones que entraron tarde al plan (SERVICE_PAY y GIFT_CARDS) se ponen al día en el MISMO periodo de
 * cobro, en cualquier orden. Antes, la segunda encontraba la fila de selección que la primera dejó en `paidThrough`, el
 * historial es inmutable (trigger `hybrid_selection_immutable`) y saltaba el contrato SIN escribir su acceso: un Pro híbrido
 * pagado se quedaba sin tarjetas de regalo hasta la siguiente renovación + otra corrida.
 *
 * Contra Postgres real (el trigger es la base) y la renovación por la entrega REAL (Stripe simulado como en
 * tests/integration/staffPay/acceso.feature.test.ts, de donde sale este arnés).
 */
import prisma from '@/utils/prismaClient'

const subscriptions = new Map<string, any>()
const invoices = new Map<string, any>()
const payments = new Map<string, any[]>()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: { retrieve: jest.fn(async (id: string) => subscriptions.get(id)) },
    invoices: { retrieve: jest.fn(async (id: string) => invoices.get(id)) },
    invoicePayments: {
      list: jest.fn(async ({ invoice }: { invoice: string }) => ({ has_more: false, data: payments.get(invoice) ?? [] })),
    },
    disputes: { list: jest.fn(async () => ({ data: [], has_more: false })) },
    creditNotes: { list: jest.fn(async () => ({ has_more: false, data: [] })) },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))

import { reconcileHybridInvoice } from '@/services/launchCampaigns/hybridDelivery.service'
import { addPlanFeatureToLivePlanContracts, type PlanCatchUpCode } from '@/services/launchCampaigns/hybridPlanCatchUp'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

const DIA = 86400
const stamp = `${Date.now()}${process.pid}`
let n = 0
let organizationId: string
let staffId: string
/** La composición que se congeló ANTES de que las dos funciones entraran al plan. */
const ANTES = ['LOYALTY_PROGRAM', 'RESERVATIONS']
const CON_LAS_DOS = ['GIFT_CARDS', 'LOYALTY_PROGRAM', 'RESERVATIONS', 'SERVICE_PAY']

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({ data: { name: `gc2r1-${stamp}`, email: `gc2r1-${stamp}@example.test`, phone: '5550000000' } })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `gc2r1-${stamp}@example.test`, firstName: 'Planes', lastName: 'QA' } })).id
})

/** Un contrato comercial de plan ya entregado con la composición de antes; su periodo pagado P1 cubre hoy. */
async function contratoDePlan(planTier: 'PRO' | 'PREMIUM') {
  const key = `gc2r1${stamp}${++n}`
  const ahora = Math.floor(Date.now() / 1000)
  const p1 = { start: ahora - 20 * DIA, end: ahora + 10 * DIA }
  const venueId = (await prisma.venue.create({ data: { name: key, slug: key, organizationId } })).id
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
      startsAt: new Date(),
      endsAt: new Date(Date.now() + DIA * 1000),
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
      includedFeatureCodes: ANTES,
      createdById: staffId,
      stripePriceId: `price_${key}`,
      stripeProductId: `prod_${key}`,
    },
  })
  const line = {
    publicationId: publication.id,
    name: key,
    definitionHash: 'b'.repeat(64),
    kind: 'PLAN',
    planTier,
    featureCodes: ANTES,
    terms,
  }
  const quote = {
    schemaVersion: 1,
    lines: [line],
    featureCodes: ANTES,
    total: '999.00',
    credit: '0.00',
    dueNow: '999.00',
    sources: [],
    replaces: [],
    effectiveAt: p1.start,
  }
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: staffId,
      quote,
      quoteHash: key,
      quoteExpiresAt: new Date(Date.now() + 300000),
      status: 'COMPLETED',
      stripeCustomerId: `cus_${key}`,
      stripeSubscriptionId: `sub_${key}`,
      initialInvoiceId: `in_${key}`,
    },
  })
  const contract = await prisma.hybridContract.create({
    data: {
      venueId,
      purchaseId: purchase.id,
      publicationId: publication.id,
      stripeSubscriptionId: `sub_${key}`,
      stripeItemId: `si_${key}`,
      featureCodes: ANTES,
      planTier,
      startsAt: new Date(p1.start * 1000),
      paidThrough: new Date(p1.end * 1000),
    },
  })
  const period = await prisma.hybridPaymentPeriod.create({
    data: {
      venueId,
      stripeSubscriptionId: `sub_${key}`,
      stripeInvoiceId: `in_${key}`,
      startsAt: new Date(p1.start * 1000),
      endsAt: new Date(p1.end * 1000),
      fundedAmount: '999.00',
      composition: [{ contractId: contract.id, itemId: `si_${key}`, featureCodes: ANTES, priceId: `price_${key}`, amount: '999.00' }],
    },
  })
  await prisma.capabilityGrant.createMany({
    data: ANTES.map(featureCode => ({
      venueId,
      featureCode,
      sourceId: `${period.id}:${contract.id}`,
      contractId: contract.id,
      paymentPeriodId: period.id,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
    })),
  })
  subscriptions.set(`sub_${key}`, {
    id: `sub_${key}`,
    customer: `cus_${key}`,
    status: 'active',
    metadata: { kind: 'HYBRID_PURCHASE', hybridPurchaseId: purchase.id, venueId, quoteHash: key },
    schedule: null,
    items: { has_more: false, data: [{ id: `si_${key}`, price: { id: `price_${key}` }, quantity: 1 }] },
  })
  return { key, venueId, purchase, contract, period, p1 }
}
type Contrato = Awaited<ReturnType<typeof contratoDePlan>>

/** Factura pagada de la suscripción de `f` por `periodo`. */
function factura(f: Contrato, id: string, periodo: { start: number; end: number }) {
  invoices.set(id, {
    id,
    customer: `cus_${f.key}`,
    parent: { subscription_details: { subscription: `sub_${f.key}` } },
    status: 'paid',
    currency: 'mxn',
    total: 99900,
    amount_remaining: 0,
    starting_balance: 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${id}`,
          amount: 99900,
          quantity: 1,
          pricing: { price_details: { price: `price_${f.key}` } },
          parent: { subscription_item_details: { subscription_item: `si_${f.key}`, proration: false } },
          period: periodo,
        },
      ],
    },
  })
  payments.set(id, [
    {
      status: 'paid',
      currency: 'mxn',
      amount_paid: 99900,
      payment: {
        type: 'charge',
        charge: { id: `ch_${id}`, amount: 99900, amount_refunded: 0, currency: 'mxn', paid: true, disputed: false },
      },
    },
  ])
  return id
}

const accesosVivos = (paymentPeriodId: string, featureCode: string) =>
  prisma.capabilityGrant.count({ where: { paymentPeriodId, featureCode, revokedAt: null } })

describe('C2 r1 — SERVICE_PAY y GIFT_CARDS en el mismo periodo, en cualquier orden', () => {
  it.each([
    ['PRO', 'SERVICE_PAY', 'GIFT_CARDS'],
    ['PREMIUM', 'GIFT_CARDS', 'SERVICE_PAY'],
    ['PRO', 'GIFT_CARDS', 'SERVICE_PAY'],
  ] as Array<['PRO' | 'PREMIUM', PlanCatchUpCode, PlanCatchUpCode]>)(
    'contrato %s: %s y luego %s → los dos accesos HOY, repetir no duplica, y la renovación los conserva',
    async (planTier, primera, segunda) => {
      const f = await contratoDePlan(planTier)
      const frontera = f.contract.paidThrough!

      await addPlanFeatureToLivePlanContracts(primera)
      const r = await addPlanFeatureToLivePlanContracts(segunda)

      // AHORA: el periodo pagado trae los dos accesos y el negocio entra a las dos funciones.
      expect(r.skippedContracts.map(s => s.contractId)).not.toContain(f.contract.id)
      expect(await accesosVivos(f.period.id, 'SERVICE_PAY')).toBe(1)
      expect(await accesosVivos(f.period.id, 'GIFT_CARDS')).toBe(1)
      await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(true)
      await expect(venueHasFeatureAccess(f.venueId, 'GIFT_CARDS')).resolves.toBe(true)

      // El historial: la fila de la primera NO se tocó; la segunda agregó una fila después, dentro del segundo de la frontera.
      const filas = await prisma.hybridContractSelection.findMany({
        where: { contractId: f.contract.id },
        orderBy: { effectiveAt: 'asc' },
        take: 10,
      })
      expect(filas.map(s => [s.effectiveAt.getTime() - frontera.getTime(), s.featureCodes])).toEqual([
        [0, [...ANTES, primera].sort()],
        [1, CON_LAS_DOS],
      ])
      expect(await prisma.hybridContract.findUniqueOrThrow({ where: { id: f.contract.id } })).toMatchObject({
        featureCodes: CON_LAS_DOS,
        revision: f.contract.revision,
      })

      // Repetir cualquiera de las dos no cambia nada.
      await addPlanFeatureToLivePlanContracts(primera)
      await addPlanFeatureToLivePlanContracts(segunda)
      expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(2)
      expect(await prisma.capabilityGrant.count({ where: { contractId: f.contract.id, featureCode: { in: [primera, segunda] } } })).toBe(2)
      expect(await prisma.activityLog.count({ where: { action: 'HYBRID_PLAN_FEATURE_ADDED', entityId: f.contract.id } })).toBe(2)

      // La renovación, por la entrega REAL: su composición y sus accesos traen las dos.
      const id = factura(f, `in_${f.key}_r`, { start: f.p1.end, end: f.p1.end + 30 * DIA })
      await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'ACTIVE' })
      const p2 = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: id } })
      expect(p2.composition).toEqual([expect.objectContaining({ contractId: f.contract.id, featureCodes: CON_LAS_DOS })])
      expect(await accesosVivos(p2.id, 'SERVICE_PAY')).toBe(1)
      expect(await accesosVivos(p2.id, 'GIFT_CARDS')).toBe(1)
    },
  )
})
