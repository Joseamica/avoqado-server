import prisma from '@/utils/prismaClient'
jest.mock('@/services/access/inventarioDeObligaciones', () => ({
  inventarioDeObligaciones: jest.fn(async () => ({ vivas: [], detalle: {}, conCambiosProgramados: [] })),
}))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: { retrieve: jest.fn(async (id: string) => ({ id, balance: 0 })) },
    checkout: { sessions: { list: jest.fn(async () => ({ data: [], has_more: false })) } },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { createHybridCampaign, publishHybridCampaign } from '@/services/launchCampaigns/hybridCampaign.service'
import { createHybridQuote, acceptHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'
const stamp = `${Date.now()}${process.pid}`
let staffId: string
let venues: string[]
let publicationId: string
let campaignId: string
beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  process.env.HYBRID_BILLING_ENABLED = 'true'
  staffId = (await prisma.staff.create({ data: { email: `accept-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
  venues = []
  for (const i of [1, 2, 3]) {
    const org = await prisma.organization.create({ data: { name: stamp, email: `accept-${stamp}-${i}@example.test`, phone: '5550000000' } })
    venues.push(
      (
        await prisma.venue.create({
          data: { organizationId: org.id, name: stamp, slug: `accept-${stamp}-${i}`, stripeCustomerId: `cus_hybrid_${stamp}_${i}` },
        })
      ).id,
    )
  }
  const campaign = await createHybridCampaign(
    {
      code: `A${stamp}`,
      slug: `accept-${stamp}`,
      name: 'Oferta de aceptación',
      startsAt: new Date(Date.now() - 86400000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      audience: 'ALL',
      capacity: 1,
      definition: {
        schemaVersion: 1,
        kind: 'FEATURES',
        featureCodes: ['CFDI'],
        terms: {
          currency: 'MXN',
          interval: 'MONTHLY',
          price: 179.9,
          taxIncluded: true,
          promotionCycles: null,
          renewal: { kind: 'SAME_PRICE' },
        },
      },
    },
    staffId,
  )
  campaignId = campaign.id
  const publication = await publishHybridCampaign(campaignId, 1, staffId)
  publicationId = publication.id
  await prisma.hybridOfferPublication.update({
    where: { id: publicationId },
    data: { stripePriceId: `price_${stamp}`, stripeProductId: `prod_${stamp}` },
  })
  await prisma.hybridCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE' } })
})
afterAll(() => {
  delete process.env.HYBRID_BILLING_ENABLED
})
describe('atomic hybrid acceptance before any provider write', () => {
  it('serializes acceptance behind the real organization row used by onboarding completion', async () => {
    const venueId = venues[2]
    const venue = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })
    await prisma.onboardingProgress.create({ data: { organizationId: venue.organizationId, completedSteps: [] } })
    const quote = await createHybridQuote(venueId, staffId, { lines: [{ publicationId }] })
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const acquired = new Promise<void>(resolve => {
      entered = resolve
    })
    const completion = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${venue.organizationId} FOR UPDATE`
        entered()
        await blocked
        await tx.onboardingProgress.update({ where: { organizationId: venue.organizationId }, data: { completedAt: new Date() } })
      },
      { timeout: 15000 },
    )
    await acquired
    const acceptance = acceptHybridQuote(venueId, staffId, quote.id, { quoteHash: quote.quoteHash, clientKey: `race-${stamp}` }).then(
      value => ({ value, error: null }),
      error => ({ value: null, error }),
    )
    try {
      const deadline = Date.now() + 10000
      let waiting = false
      while (!waiting && Date.now() < deadline) {
        const rows = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF o%'`
        waiting = Number(rows[0].count) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(waiting).toBe(true)
    } finally {
      release()
    }
    await completion
    const result = await acceptance
    expect(result.error).toMatchObject({ code: 'ONBOARDING_BILLING_IN_PROGRESS' })
    expect(await prisma.hybridPurchase.findUnique({ where: { id: quote.id } })).toMatchObject({ status: 'QUOTED' })
    expect(await prisma.hybridCampaign.findUnique({ where: { id: campaignId } })).toMatchObject({ reservedCount: 0 })
    await prisma.onboardingProgress.delete({ where: { organizationId: venue.organizationId } })
  })
  it('reserves the final place exactly once across organizations and replays the same accepted quote', async () => {
    const quotes = await Promise.all(venues.slice(0, 2).map(id => createHybridQuote(id, staffId, { lines: [{ publicationId }] })))
    const results = await Promise.allSettled(
      quotes.map((quote, i) =>
        acceptHybridQuote(venues[i], staffId, quote.id, { quoteHash: quote.quoteHash, clientKey: `accept-${stamp}-${i}` }),
      ),
    )
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const index = results.findIndex(result => result.status === 'fulfilled')
    const accepted = (results[index] as PromiseFulfilledResult<any>).value
    expect(accepted.status).toBe('ACCEPTED')
    const replay = await acceptHybridQuote(venues[index], staffId, quotes[index].id, {
      quoteHash: quotes[index].quoteHash,
      clientKey: `accept-${stamp}-${index}`,
    })
    expect(replay.id).toBe(accepted.id)
    expect(await prisma.hybridCampaign.findUnique({ where: { id: campaignId } })).toMatchObject({ reservedCount: 1, redeemedCount: 0 })
    expect(await prisma.activityLog.count({ where: { entityId: accepted.id, action: 'HYBRID_PURCHASE_ACCEPTED' } })).toBe(1)
    expect(await prisma.capabilityGrant.count({ where: { venueId: venues[index] } })).toBe(0)
    await expect(
      acceptHybridQuote(venues[2], staffId, accepted.id, { quoteHash: quotes[index].quoteHash, clientKey: 'foreign-key' }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
  it('rolls back the reservation and acceptance if audit fails after both writes', async () => {
    await prisma.hybridCampaign.update({ where: { id: campaignId }, data: { capacity: 2 } })
    const quote = await createHybridQuote(venues[2], staffId, { lines: [{ publicationId }] })
    await expect(
      acceptHybridQuote(venues[2], 'missing-staff', quote.id, { quoteHash: quote.quoteHash, clientKey: `rollback-${stamp}` }),
    ).rejects.toThrow()
    expect(await prisma.hybridPurchase.findUnique({ where: { id: quote.id } })).toMatchObject({ status: 'QUOTED', clientKey: null })
    expect(await prisma.hybridCampaign.findUnique({ where: { id: campaignId } })).toMatchObject({ reservedCount: 1 })
  })
  it('rechecks campaign eligibility if the audience changes between quote observation and acceptance', async () => {
    const quote = await createHybridQuote(venues[2], staffId, { lines: [{ publicationId }] })
    const provider = jest.requireMock('@/services/stripe.service')
    provider.stripe.customers.retrieve.mockImplementationOnce(async (id: string) => {
      await prisma.hybridCampaign.update({
        where: { id: campaignId },
        data: { audience: 'ORGANIZATIONS', eligibleOrganizationIds: ['cm000000000000000000000000'], revision: { increment: 1 } },
      })
      return { id, balance: 0 }
    })
    await expect(
      acceptHybridQuote(venues[2], staffId, quote.id, { quoteHash: quote.quoteHash, clientKey: `cohort-${stamp}` }),
    ).rejects.toMatchObject({ code: 'HYBRID_OFFER_INELIGIBLE' })
    expect(await prisma.hybridPurchase.findUnique({ where: { id: quote.id } })).toMatchObject({ status: 'QUOTED' })
  })
})
