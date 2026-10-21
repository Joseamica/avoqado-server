import prisma from '@/utils/prismaClient'
// What each venue has live in Stripe (by venueId); nothing unless a test says so.
const live: Record<string, unknown> = {}
jest.mock('@/services/access/inventarioDeObligaciones', () => ({
  inventarioDeObligaciones: jest.fn(async (venueId: string) => live[venueId] ?? { vivas: [], detalle: {}, conCambiosProgramados: [] }),
}))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: { retrieve: jest.fn(async (id: string) => ({ id, balance: 0 })) },
    checkout: { sessions: { list: jest.fn(async () => ({ data: [], has_more: false })) } },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
// Preparing a list price links fake Stripe ids (what the real preparation writes), so the list is on sale.
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async (id: string) =>
    jest.requireActual('@/utils/prismaClient').default.hybridOfferPublication.update({
      where: { id },
      data: { stripeProductId: `prod_${id}`, stripePriceId: `price_${id}` },
    }),
  ),
}))
// The real purchase rule (lock, pending purchase, compatibility) unless a test swaps one call.
jest.mock('@/services/access/autorizarObligacionNueva', () => {
  const actual = jest.requireActual('@/services/access/autorizarObligacionNueva')
  return { autorizarObligacionNueva: jest.fn(actual.autorizarObligacionNueva) }
})
import { autorizarObligacionNueva } from '@/services/access/autorizarObligacionNueva'
import { saveListPrice } from '@/services/launchCampaigns/hybridListPrice.service'
import { acceptHybridQuote, createHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'

const stamp = `${Date.now()}${process.pid}`
const OURS = ['AUTO_REORDER', 'INVENTORY_TRACKING']
let staffId: string
const venues: string[] = []
const pub: Record<string, string> = {}

/** Lists are never deleted (their publications cannot be): free the product key and the code/slug a new list would claim. */
async function retire() {
  const rows = await prisma.hybridCampaign.findMany({
    where: {
      purpose: 'LIST',
      OR: [{ listProductKey: { in: OURS.map(code => `FEATURE:${code}`) } }, { code: { in: OURS.map(code => `L_${code}`) } }],
    },
    select: { id: true },
    take: 20,
  })
  for (const { id } of rows)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:RETIRED_${id}`, code: `RETIRED_${id}`, slug: `retired-${id}`, status: 'PAUSED' },
    })
}

const quote = (venue: number, codes: string[]) =>
  createHybridQuote(venues[venue], staffId, { lines: codes.map(code => ({ publicationId: pub[code] })) })
const accept = (venue: number, q: { id: string; quoteHash: string }, key: string) =>
  acceptHybridQuote(venues[venue], staffId, q.id, { quoteHash: q.quoteHash, clientKey: `${key}-${stamp}` })
const statusOf = async (purchaseId: string) => (await prisma.hybridPurchase.findUniqueOrThrow({ where: { id: purchaseId } })).status

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  await retire()
  staffId = (await prisma.staff.create({ data: { email: `deps-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  for (let i = 0; i < 4; i++) {
    const org = await prisma.organization.create({ data: { name: stamp, email: `deps-${stamp}-${i}@example.test`, phone: '5550000000' } })
    const venue = await prisma.venue.create({
      data: { organizationId: org.id, name: stamp, slug: `deps-${stamp}-${i}`, stripeCustomerId: `cus_deps_${stamp}_${i}` },
    })
    venues.push(venue.id)
  }
})
afterAll(async () => {
  await retire()
  delete process.env.HYBRID_BILLING_ENABLED
})

// Task 5 showed AUTO_REORDER as editable while saving it failed: a single function now publishes without its dependency.
it('(0) a dependent function takes a list price on its own', async () => {
  for (const [code, price] of [
    ['AUTO_REORDER', 349],
    ['INVENTORY_TRACKING', 899],
  ] as const) {
    const saved = await saveListPrice({ productKey: `FEATURE:${code}`, price, expectedRevision: null }, staffId)
    expect(saved).toMatchObject({ featureCode: code, status: 'ACTIVE', price, pendingPrice: null })
    const list = await prisma.hybridCampaign.findFirstOrThrow({ where: { purpose: 'LIST', listProductKey: `FEATURE:${code}` } })
    pub[code] = list.currentPublicationId!
  }
})

describe('the quote checks dependencies over the whole purchase (spec §4.2, Review Focus 6)', () => {
  it('(1) a venue without Inventory cannot buy Reorden automático alone', async () => {
    const before = await prisma.hybridPurchase.count({ where: { venueId: venues[0] } })
    await expect(quote(0, ['AUTO_REORDER'])).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_DEPENDENCY_TERM',
      message:
        'Reorden automático necesita Inventario FIFO, recetas y costeo mientras la conserves: agrégalo con precio de lista o consérvalo.',
      details: [{ featureCode: 'AUTO_REORDER', requiredFeatureCode: 'INVENTORY_TRACKING', requiredUntil: null, unit: null }],
    })
    expect(await prisma.hybridPurchase.count({ where: { venueId: venues[0] } })).toBe(before)
  })

  it('(2) both list lines in one cart pass, and the purchase is accepted', async () => {
    const q = await quote(1, ['AUTO_REORDER', 'INVENTORY_TRACKING'])
    expect((q.quote as any).featureCodes).toEqual(['AUTO_REORDER', 'INVENTORY_TRACKING'])
    await expect(accept(1, q, 'both')).resolves.toMatchObject({ status: 'ACCEPTED' })
  })
})

describe('the acceptance revalidates the dated coverage under the purchase lock (spec §4.2 rule 5)', () => {
  const subscription = `sub_deps_inv_${stamp}`
  let contractId: string

  beforeAll(async () => {
    // Inventory kept from an earlier hybrid purchase: one live contract, no scheduled end.
    const venueId = venues[2]
    const purchase = await prisma.hybridPurchase.create({
      data: {
        venueId,
        quotedById: staffId,
        quote: { schemaVersion: 1 },
        quoteHash: `deps-${stamp}`,
        quoteExpiresAt: new Date(Date.now() - 86400000),
        status: 'COMPLETED',
        stripeCustomerId: `cus_deps_${stamp}_2`,
        stripeSubscriptionId: subscription,
      },
    })
    contractId = (
      await prisma.hybridContract.create({
        data: {
          venueId,
          purchaseId: purchase.id,
          publicationId: pub.INVENTORY_TRACKING,
          stripeSubscriptionId: subscription,
          stripeItemId: `si_deps_${stamp}`,
          featureCodes: ['INVENTORY_TRACKING'],
          startsAt: new Date(Date.now() - 5 * 86400000),
        },
      })
    ).id
    live[venueId] = {
      vivas: [{ subscriptionId: subscription, proyecciones: [{ tipo: 'PAQUETE', featureCodes: ['INVENTORY_TRACKING'] }] }],
      detalle: {
        [subscription]: {
          status: 'active',
          customerId: `cus_deps_${stamp}_2`,
          variosItems: false,
          pausaDeCobranza: false,
          metodoDeCobro: 'charge_automatically',
          terminaEn: null,
        },
      },
      conCambiosProgramados: [],
    }
  })

  it('(3) the kept Inventory holds the new list; a cancellation scheduled after the re-observation fails the acceptance', async () => {
    const q = await quote(2, ['AUTO_REORDER'])
    const cancelAt = new Date(Date.now() + 10 * 86400000)
    // The re-observation before the lock still sees the contract without an end: only the in-lock check can catch this.
    jest.mocked(autorizarObligacionNueva).mockImplementationOnce(async (...args) => {
      await prisma.hybridContract.update({ where: { id: contractId }, data: { cancelAt } })
      return jest.requireActual('@/services/access/autorizarObligacionNueva').autorizarObligacionNueva(...args)
    })
    await expect(accept(2, q, 'cancel')).rejects.toMatchObject({
      code: 'HYBRID_DEPENDENCY_TERM',
      message: expect.stringContaining('Reorden automático necesita Inventario FIFO'),
      details: [
        {
          featureCode: 'AUTO_REORDER',
          requiredFeatureCode: 'INVENTORY_TRACKING',
          requiredUntil: null,
          unit: { kind: 'RETAINED', source: subscription },
        },
      ],
    })
    expect(await statusOf(q.id)).toBe('QUOTED')

    // With the cancellation in place, a fresh quote is refused up front.
    await expect(quote(2, ['AUTO_REORDER'])).rejects.toMatchObject({ code: 'HYBRID_DEPENDENCY_TERM' })
    // Undoing it, the same kind of purchase goes through again.
    await prisma.hybridContract.update({ where: { id: contractId }, data: { cancelAt: null } })
    await expect(accept(2, await quote(2, ['AUTO_REORDER']), 'kept')).resolves.toMatchObject({ status: 'ACCEPTED' })
  })
})
