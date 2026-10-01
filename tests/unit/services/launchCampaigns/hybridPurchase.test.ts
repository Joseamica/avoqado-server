import { prismaMock } from '../../../__helpers__/setup'
const inventory = jest.fn()
const customerBalance = jest.fn()
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: (...args: unknown[]) => inventory(...args) }))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: {
      retrieve: (...args: unknown[]) => customerBalance(...args),
      listBalanceTransactions: jest.fn().mockResolvedValue({ data: [], has_more: true }),
    },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
jest.mock('@/services/access/autorizarObligacionNueva', () => ({ autorizarObligacionNueva: jest.fn() }))
const keepCheck = jest.fn()
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({ assertKeepSelection: (...args: unknown[]) => keepCheck(...args) }))
const creditSource = jest.fn()
jest.mock('@/services/launchCampaigns/hybridSources', () => ({ readHybridCreditSource: (...args: unknown[]) => creditSource(...args) }))
import { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { createHybridQuote, getHybridReplacementOptions } from '@/services/launchCampaigns/hybridPurchase.service'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
const pubId = 'cm123456789012345678901234'
const campaignId = 'cm223456789012345678901234'
const now = Date.now()
const publication = {
  id: pubId,
  campaignId,
  name: 'Elige dos',
  version: 1,
  definitionHash: 'a'.repeat(64),
  includedFeatureCodes: [],
  stripePriceId: 'price_test',
  stripeRenewalPriceId: null,
  stripeProductId: 'prod_test',
  definition: {
    schemaVersion: 1,
    kind: 'CHOICE_BUNDLE',
    choiceCount: 2,
    eligibleFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM', 'PROMOTIONS'],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 379.5,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  },
  campaign: {
    id: campaignId,
    status: 'ACTIVE',
    startsAt: new Date(now - 10000),
    endsAt: new Date(now + 86400000),
    capacity: 10,
    reservedCount: 0,
    redeemedCount: 0,
    audience: 'ALL',
    eligibleOrganizationIds: [],
    currentPublicationId: pubId,
  },
}
const input = { lines: [{ publicationId: pubId, selectedFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }] }
beforeEach(() => {
  process.env.HYBRID_BILLING_ENABLED = 'true'
  customerBalance.mockReset().mockResolvedValue({ id: 'cus_test', balance: 0, currency: 'mxn' })
  keepCheck.mockReset().mockResolvedValue(undefined)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue',
    organizationId: 'org',
    stripeCustomerId: 'cus_test',
    organization: { id: 'org', createdAt: new Date(now), email: 'test@example.test', name: 'Test' },
  })
  prismaMock.hybridOfferPublication.findMany.mockResolvedValue([publication])
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.capabilityGrant.findMany.mockResolvedValue([])
  prismaMock.hybridContract.findMany.mockResolvedValue([])
  prismaMock.hybridRedemption.findMany.mockResolvedValue([])
  inventory.mockReset().mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
  prismaMock.hybridPurchase.create.mockImplementation(async ({ data }: any) => ({ id: 'quote', ...data }))
})
afterEach(() => {
  delete process.env.HYBRID_BILLING_ENABLED
})
describe('server-owned hybrid quotes', () => {
  it('does not quote customer credit whose funding history cannot be verified', async () => {
    customerBalance.mockResolvedValue({ id: 'cus_test', balance: -1000, currency: 'mxn' })
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toMatchObject({ code: 'HYBRID_FUNDING_UNVERIFIED' })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })
  it('quotes published terms and stores a hash without accepting or granting access', async () => {
    const quote = await createHybridQuote('venue', 'staff', input)
    expect(quote).toMatchObject({ status: 'QUOTED', quote: { total: '379.50', credit: '0.00', dueNow: '379.50' } })
    expect(quote.quoteHash).toMatch(/^[a-f0-9]{64}$/)
    expect(prismaMock.capabilityGrant.create).not.toHaveBeenCalled()
  })
  it('rejects browser prices and incomplete choice sets', async () => {
    await expect(createHybridQuote('venue', 'staff', { ...input, price: 1 })).rejects.toThrow()
    await expect(
      createHybridQuote('venue', 'staff', { lines: [{ publicationId: pubId, selectedFeatureCodes: ['CFDI'] }] }),
    ).rejects.toThrow()
  })
  it('requires a real active published offer in the venue cohort', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValueOnce([
      { ...publication, campaign: { ...publication.campaign, status: 'PAUSED' } },
    ])
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toThrow()
    prismaMock.hybridOfferPublication.findMany.mockResolvedValueOnce([
      { ...publication, campaign: { ...publication.campaign, audience: 'ORGANIZATIONS', eligibleOrganizationIds: ['foreign'] } },
    ])
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toThrow()
    // Only the publication the campaign points at is on sale, whatever its version.
    prismaMock.hybridOfferPublication.findMany.mockResolvedValueOnce([
      { ...publication, campaign: { ...publication.campaign, currentPublicationId: 'cm999999999999999999999999' } },
    ])
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toMatchObject({ code: 'HYBRID_OFFER_UNAVAILABLE' })
  })
  it('does not charge an already included capability or consume a used campaign twice', async () => {
    inventory.mockResolvedValueOnce({
      vivas: [{ subscriptionId: 'sub_old', proyecciones: [{ tipo: 'FUNCION', featureCode: 'CFDI' }] }],
      detalle: {},
      conCambiosProgramados: [],
    })
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toThrow(/incluida/i)
    prismaMock.hybridRedemption.findMany.mockResolvedValueOnce([{ campaignId, status: 'REDEEMED' }])
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toThrow(/utiliz/i)
  })
  it('keeps new sales closed when the rollout flag is off', async () => {
    process.env.HYBRID_BILLING_ENABLED = 'false'
    await expect(createHybridQuote('venue', 'staff', input)).rejects.toMatchObject({ code: 'HYBRID_SALES_CLOSED' })
  })
  it('carries a "who stays" choice, checked against the team before quoting', async () => {
    const quote = await createHybridQuote('venue', 'staff', { ...input, keepStaffVenueIds: ['sv_owner', 'sv_ana'] })
    expect(keepCheck).toHaveBeenCalledWith('venue', ['sv_owner', 'sv_ana'])
    expect((quote.quote as any).input.keepStaffVenueIds).toEqual(['sv_owner', 'sv_ana'])
  })

  it('refuses a choice that leaves the owner out, before creating anything', async () => {
    keepCheck.mockRejectedValue(new BadRequestError('El propietario debe conservar su acceso. Inclúyelo en la selección.'))
    await expect(createHybridQuote('venue', 'staff', { ...input, keepStaffVenueIds: ['sv_ana'] })).rejects.toThrow('propietario')
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })

  it('without a choice the quote input is unchanged, so quotes made before this field keep their hash', async () => {
    const quote = await createHybridQuote('venue', 'staff', input)
    expect(keepCheck).not.toHaveBeenCalled()
    expect((quote.quote as any).input).not.toHaveProperty('keepStaffVenueIds')
  })
})

// A classic plan brings what a published plan of its tier brings: never a function sold by quote (white label, master
// catalog), which a module or an organization entitlement grants, not the tier. Otherwise the quote lists them in
// «Funciones que dejarás» for a venue that never had them.
describe('what a classic plan brings when it is replaced', () => {
  const planTerms = { ...publication.definition.terms }
  const published = (planTier: 'PRO' | 'PREMIUM') =>
    compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier, terms: planTerms }).includedFeatureCodes
  const classic = (planTier: 'PRO' | 'PREMIUM') => ({
    vivas: [{ subscriptionId: 'sub_classic', proyecciones: [{ tipo: 'PLAN', tier: planTier }] }],
    detalle: { sub_classic: { customerId: 'cus_test' } },
    conCambiosProgramados: [],
  })

  it.each(['PRO', 'PREMIUM'] as const)('a classic %s lists exactly what a published plan of its tier includes', async tier => {
    inventory.mockResolvedValue(classic(tier))
    prismaMock.capabilityGrant.groupBy.mockResolvedValue([])
    const options = await getHybridReplacementOptions('venue')
    expect([...options.items[0].featureCodes].sort()).toEqual(published(tier))
    expect(options.items[0].featureCodes).not.toContain('WHITE_LABEL_DASHBOARD')
    expect(options.items[0].featureCodes).not.toContain('MASTER_CATALOG')
  })

  describe('Pro → Premium quote', () => {
    const premiumId = 'cm323456789012345678901234'
    const premiumCampaign = 'cm423456789012345678901234'
    const premium = {
      ...publication,
      id: premiumId,
      campaignId: premiumCampaign,
      name: 'Plan Premium',
      includedFeatureCodes: published('PREMIUM'),
      definition: { schemaVersion: 1, kind: 'PLAN', planTier: 'PREMIUM', terms: planTerms },
      campaign: { ...publication.campaign, id: premiumCampaign, currentPublicationId: premiumId },
    }
    const toPremium = (dropFeatureCodes: string[]) => ({
      lines: [{ publicationId: premiumId }],
      replaceSubscriptionIds: ['sub_classic'],
      dropFeatureCodes,
    })
    beforeEach(() => {
      inventory.mockResolvedValue(classic('PRO'))
      prismaMock.hybridOfferPublication.findMany.mockResolvedValue([premium])
      creditSource.mockReset().mockResolvedValue({ sourceSubscriptionId: 'sub_classic', amount: new Prisma.Decimal('1158.84') })
    })

    it('drops nothing: Premium keeps everything the classic Pro gave', async () => {
      const quote = await createHybridQuote('venue', 'staff', toPremium([]))
      expect(quote.quote).toMatchObject({ droppedFeatureCodes: [], credit: '1158.84' })
    })

    it('refuses to «drop» functions the venue never had', async () => {
      await expect(createHybridQuote('venue', 'staff', toPremium(['MASTER_CATALOG', 'WHITE_LABEL_DASHBOARD']))).rejects.toThrow(
        'no coincide',
      )
      expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
    })
  })
})
