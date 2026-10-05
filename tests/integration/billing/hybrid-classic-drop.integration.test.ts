import prisma from '@/utils/prismaClient'
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: jest.fn() }))
// The origin invoice is mocked the way the hybridSources tests do: one paid charge, no credit notes, clover periods.
const mockSubscriptionRetrieve = jest.fn()
const mockInvoicePayments = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: { retrieve: jest.fn(async (id: string) => ({ id, balance: 0 })) },
    subscriptions: { retrieve: (...args: unknown[]) => mockSubscriptionRetrieve(...args) },
    invoicePayments: { list: (...args: unknown[]) => mockInvoicePayments(...args) },
    creditNotes: { list: jest.fn(async () => ({ has_more: false, data: [] })) },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { Prisma } from '@prisma/client'
import { FREE_TIER_CODES } from '@/services/access/basePlan.service'
import { inventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'
import { projectionCodes } from '@/services/launchCampaigns/hybridCoverage'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { createHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'

// Spec §4.2: dropping a classic plan to Gratis while keeping a function is self-service (HYBRID_DROP). The classic
// subscription is replaced and its unused paid time becomes credit, for a monthly and for an annual classic.
const stamp = `${Date.now()}${process.pid}`
const MARK = 'test:hybrid-classic-drop'
const KEPT = 'CUSTOMER_CAMPAIGNS' // a Pro function no other suite lists
const LIST_PRICE = 199
const DAY = 86400
let staffId: string
let listPub: string

async function retireCatalog() {
  const lists = await prisma.hybridCampaign.findMany({ where: { createdById: MARK, purpose: 'LIST' }, select: { id: true }, take: 50 })
  for (const { id } of lists)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey: `FEATURE:RETIRED_${id}`, status: 'PAUSED' } })
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  await retireCatalog()
  staffId = (await prisma.staff.create({ data: { email: `classic-drop-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  const compiled = compileHybridPublication({
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: [KEPT],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: LIST_PRICE,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  })
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: `CD${stamp}`,
      slug: `cd-${stamp}`,
      name: `Lista ${KEPT} ${stamp}`,
      purpose: 'LIST',
      listProductKey: `FEATURE:${KEPT}`,
      draftDefinition: compiled.definition,
      startsAt: new Date(Date.now() - DAY * 1000),
      endsAt: null,
      capacity: null,
      audience: 'ALL',
      listed: true,
      status: 'ACTIVE',
      revision: 2,
      createdById: MARK,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: campaign.name,
      definition: compiled.definition,
      definitionHash: compiled.definitionHash,
      includedFeatureCodes: compiled.includedFeatureCodes,
      stripePriceId: `price_cd_${stamp}`,
      stripeProductId: `prod_cd_${stamp}`,
      createdById: MARK,
    },
  })
  await prisma.hybridCampaign.update({ where: { id: campaign.id }, data: { currentPublicationId: publication.id } })
  listPub = publication.id
})

afterAll(async () => {
  await retireCatalog()
  delete process.env.HYBRID_BILLING_ENABLED
})

/** A venue on a classic Pro whose last invoice paid `cents` for [start, end). */
async function classicPro(label: string, cents: number, start: number, end: number) {
  const customerId = `cus_cd_${label}_${stamp}`
  const subscriptionId = `sub_cd${label}${stamp}` // Stripe ids: `sub_` + alphanumerics
  const org = await prisma.organization.create({ data: { name: stamp, email: `cd-${label}-${stamp}@example.test`, phone: '5550000000' } })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: stamp, slug: `cd-${label}-${stamp}`, stripeCustomerId: customerId },
  })
  jest.mocked(inventarioDeObligaciones).mockResolvedValue({
    vivas: [{ subscriptionId, proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
    detalle: {
      [subscriptionId]: {
        status: 'active',
        customerId,
        variosItems: false,
        pausaDeCobranza: false,
        metodoDeCobro: 'card',
        terminaEn: null,
      },
    },
    conCambiosProgramados: [],
  })
  const item = `si_cd_${label}_${stamp}`
  mockSubscriptionRetrieve.mockResolvedValue({
    id: subscriptionId,
    customer: customerId,
    status: 'active',
    latest_invoice: {
      id: `in_cd_${label}_${stamp}`,
      customer: customerId,
      status: 'paid',
      currency: 'mxn',
      total: cents,
      starting_balance: 0,
      ending_balance: 0,
      post_payment_credit_notes_amount: 0,
      lines: {
        has_more: false,
        data: [{ amount: cents, parent: { subscription_item_details: { subscription_item: item } }, period: { start, end } }],
      },
    },
    items: { has_more: false, data: [{ id: item, current_period_start: start, current_period_end: end }] },
  })
  mockInvoicePayments.mockResolvedValue({
    has_more: false,
    data: [
      {
        status: 'paid',
        amount_paid: cents,
        currency: 'mxn',
        payment: {
          type: 'charge',
          charge: { id: `ch_cd_${label}_${stamp}`, amount: cents, amount_refunded: 0, disputed: false, paid: true, currency: 'mxn' },
        },
      },
    ],
  })
  return { venueId: venue.id, subscriptionId }
}

const now = Math.floor(Date.now() / 1000)
// Everything a classic Pro brings except the free functions (everyone keeps them) and the one the owner keeps.
const dropped = projectionCodes({ tipo: 'PLAN', tier: 'PRO' }).filter(
  code => code !== KEPT && !(FREE_TIER_CODES as readonly string[]).includes(code),
)

describe('classic Pro → Gratis keeping one function (spec §4.2: HYBRID_DROP is self-service)', () => {
  it.each([
    // Two days left of a $1,158.84 month: the credit does not cover the function, so something is due today.
    { label: 'monthly', cents: 115884, start: now - 28 * DAY, end: now + 2 * DAY },
    // 265 days left of a $11,588.40 year: the credit covers the function and the rest stays as balance.
    { label: 'annual', cents: 1158840, start: now - 100 * DAY, end: now + 265 * DAY },
  ])('a $label classic: replaces it and credits its unused paid time', async ({ label, cents, start, end }) => {
    const { venueId, subscriptionId } = await classicPro(label, cents, start, end)
    const purchase = await createHybridQuote(venueId, staffId, {
      lines: [{ publicationId: listPub, selectedFeatureCodes: [] }],
      replaceSubscriptionIds: [subscriptionId],
      dropFeatureCodes: dropped,
    })
    const quote = purchase.quote as {
      replaces: string[]
      credit: string
      dueNow: string
      creditBalanceAfter: string
      total: string
      effectiveAt: number
    }
    expect(quote.replaces).toEqual([subscriptionId])
    expect(quote.total).toBe(LIST_PRICE.toFixed(2))
    // Paid × unused share of the period, rounded down to the cent (what the source invoice still owes the venue).
    const credit = new Prisma.Decimal(cents)
      .div(100)
      .mul(end - Math.max(start, quote.effectiveAt))
      .div(end - start)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN)
    expect(quote.credit).toBe(credit.toFixed(2))
    expect(quote.dueNow).toBe(Prisma.Decimal.max(0, new Prisma.Decimal(LIST_PRICE).sub(credit)).toFixed(2))
    expect(quote.creditBalanceAfter).toBe(Prisma.Decimal.max(0, credit.sub(LIST_PRICE)).toFixed(2))
    if (label === 'monthly') expect(Number(quote.dueNow)).toBeGreaterThan(0)
    else expect(quote.dueNow).toBe('0.00')
  })
})
