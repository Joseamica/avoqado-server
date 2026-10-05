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
import { addUtcMonths } from '@/services/launchCampaigns/hybridCoverage'
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
    purpose: 'PROMOTION',
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

describe('spec §4.2: the quote checks dependencies over the whole purchase, with dates', () => {
  const listId = 'cm523456789012345678901234'
  const listCampaign = 'cm623456789012345678901234'
  const upsellAiList = {
    ...publication,
    id: listId,
    campaignId: listCampaign,
    name: 'Sugerencias con IA',
    includedFeatureCodes: ['UPSELL_AI'],
    definition: { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['UPSELL_AI'], terms: { ...publication.definition.terms, price: 299 } },
    campaign: { ...publication.campaign, id: listCampaign, purpose: 'LIST', endsAt: null, capacity: null, currentPublicationId: listId },
  }
  const classicPro = (terminaEn: string | null) => ({
    vivas: [{ subscriptionId: 'sub_classic', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
    detalle: { sub_classic: { customerId: 'cus_test', terminaEn } },
    conCambiosProgramados: [],
  })
  const buy = () => createHybridQuote('venue', 'staff', { lines: [{ publicationId: listId }] })
  beforeEach(() => prismaMock.hybridOfferPublication.findMany.mockResolvedValue([upsellAiList]))

  it('a classic Pro ending in 10 days cannot hold a permanent UPSELL_AI list', async () => {
    inventory.mockResolvedValue(classicPro(new Date(now + 10 * 86400000).toISOString()))
    await expect(buy()).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_DEPENDENCY_TERM',
      message: expect.stringContaining('mientras la conserves'),
      details: [
        { featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL', requiredUntil: null, unit: { kind: 'RETAINED', source: 'sub_classic' } },
      ],
    })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })

  it('the same Pro without a scheduled end holds it', async () => {
    inventory.mockResolvedValue(classicPro(null))
    await expect(buy()).resolves.toMatchObject({ status: 'QUOTED' })
  })

  it('without the dependency anywhere the quote names it and offers no unit', async () => {
    await expect(buy()).rejects.toMatchObject({
      code: 'HYBRID_DEPENDENCY_TERM',
      details: [{ featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL', requiredUntil: null, unit: null }],
    })
  })
})

// Codex C2: an END line runs `promotionCycles` months from its Stripe period start, which provisioning may open well
// after the acceptance (journal retries). Validation must hold for every start the code allows, not only for `now`.
describe('an END line is checked for the latest start the purchase may still get, and for the earliest', () => {
  const endId = 'cm923456789012345678901234'
  const endCampaign = 'cma23456789012345678901234'
  const endLine = (featureCode: string) => ({
    ...publication,
    id: endId,
    campaignId: endCampaign,
    name: 'Un mes',
    includedFeatureCodes: [featureCode],
    definition: {
      schemaVersion: 1,
      kind: 'FEATURES',
      featureCodes: [featureCode],
      terms: { ...publication.definition.terms, price: 99, promotionCycles: 1, renewal: { kind: 'END' } },
    },
    campaign: { ...publication.campaign, id: endCampaign, currentPublicationId: endId },
  })
  const buy = () => createHybridQuote('venue', 'staff', { lines: [{ publicationId: endId }] })
  const minute = 60000

  it('a one-month UPSELL_AI over a Pro ending a minute after that month is refused: a late start outlives the Pro', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([endLine('UPSELL_AI')])
    const proEnds = new Date(addUtcMonths(new Date(), 1).getTime() + minute)
    inventory.mockResolvedValue({
      vivas: [{ subscriptionId: 'sub_classic', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
      detalle: { sub_classic: { customerId: 'cus_test', terminaEn: proEnds.toISOString() } },
      conCambiosProgramados: [],
    })
    await expect(buy()).rejects.toMatchObject({
      code: 'HYBRID_DEPENDENCY_TERM',
      details: [expect.objectContaining({ featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL' })],
    })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })

  it('a one-month INVENTORY_TRACKING under a kept AUTO_REORDER ending an hour after that month is refused: an immediate start ends first', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([endLine('INVENTORY_TRACKING')])
    prismaMock.venueFeature.findMany.mockResolvedValue([
      {
        stripeSubscriptionId: null,
        endDate: new Date(addUtcMonths(new Date(), 1).getTime() + 60 * minute),
        feature: { code: 'AUTO_REORDER' },
      },
    ])
    await expect(buy()).rejects.toMatchObject({
      code: 'HYBRID_DEPENDENCY_TERM',
      details: [expect.objectContaining({ featureCode: 'AUTO_REORDER', requiredFeatureCode: 'INVENTORY_TRACKING' })],
    })
  })

  it('a dependency the venue keeps past every possible end holds the line', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([endLine('UPSELL_AI')])
    inventory.mockResolvedValue({
      vivas: [{ subscriptionId: 'sub_classic', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
      detalle: { sub_classic: { customerId: 'cus_test', terminaEn: addUtcMonths(new Date(), 2).toISOString() } },
      conCambiosProgramados: [],
    })
    await expect(buy()).resolves.toMatchObject({ status: 'QUOTED' })
  })
})

// Spec §4.5 (option A): a function re-quoted out of a replaced contract moves to today's offer, and the quote says so.
describe('quote.repriced: what a replaced contract charged against today', () => {
  const listId = 'cm723456789012345678901234'
  const listCampaign = 'cm823456789012345678901234'
  const loyaltyAt = (price: number) => ({
    ...publication,
    id: listId,
    campaignId: listCampaign,
    name: 'Lealtad',
    includedFeatureCodes: ['LOYALTY_PROGRAM'],
    definition: {
      schemaVersion: 1,
      kind: 'FEATURES',
      featureCodes: ['LOYALTY_PROGRAM'],
      terms: { ...publication.definition.terms, price },
    },
    campaign: { ...publication.campaign, id: listCampaign, purpose: 'LIST', endsAt: null, capacity: null, currentPublicationId: listId },
  })
  const replace = { lines: [{ publicationId: listId }], replaceSubscriptionIds: ['sub_hybrid'] }
  beforeEach(() => {
    inventory.mockResolvedValue({
      vivas: [{ subscriptionId: 'sub_hybrid', proyecciones: [{ tipo: 'PAQUETE', featureCodes: ['LOYALTY_PROGRAM'] }] }],
      detalle: { sub_hybrid: { customerId: 'cus_test', terminaEn: null } },
      conCambiosProgramados: [],
    })
    creditSource.mockReset().mockResolvedValue({ sourceSubscriptionId: 'sub_hybrid', amount: new Prisma.Decimal('0') })
    prismaMock.hybridContract.findMany.mockImplementation(async ({ where }: any) =>
      where.stripeSubscriptionId.in.includes('sub_hybrid') ? [{ id: 'contract_old', stripeSubscriptionId: 'sub_hybrid' }] : [],
    )
    prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue({
      composition: [
        { contractId: 'contract_old', itemId: 'si_old', featureCodes: ['LOYALTY_PROGRAM'], priceId: 'price_old', amount: '599.00' },
      ],
    })
  })

  it('replacing a contract at 599 with a line at 699 shows the difference', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([loyaltyAt(699)])
    const quote = await createHybridQuote('venue', 'staff', replace)
    expect((quote.quote as any).repriced).toEqual([{ featureCode: 'LOYALTY_PROGRAM', from: '599.00', to: '699.00' }])
    expect(prismaMock.hybridPaymentPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue', stripeSubscriptionId: 'sub_hybrid' } }),
    )
  })

  it('the same price is not a change: the quote carries no repriced field (and keeps its old hash shape)', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([loyaltyAt(599)])
    const quote = await createHybridQuote('venue', 'staff', replace)
    expect(quote.quote).not.toHaveProperty('repriced')
  })

  // A function that came inside a plan never had a standalone rate (spec §4.5): only one function against itself compares.
  describe('a plan price is never presented as a function rate', () => {
    const planTerms = publication.definition.terms
    const plan = (planTier: 'PRO' | 'PREMIUM') => compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier, terms: planTerms })
    const proCodes = plan('PRO').includedFeatureCodes
    beforeEach(() => {
      inventory.mockResolvedValue({
        vivas: [{ subscriptionId: 'sub_hybrid', proyecciones: [{ tipo: 'PLAN', tier: 'PRO', featureCodes: proCodes }] }],
        detalle: { sub_hybrid: { customerId: 'cus_test', terminaEn: null } },
        conCambiosProgramados: [],
      })
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue({
        composition: [{ contractId: 'contract_old', itemId: 'si_old', featureCodes: proCodes, priceId: 'price_pro', amount: '1158.84' }],
      })
    })

    it('a single-function contract absorbed by a plan line shows no repriced function either', async () => {
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue({
        composition: [{ contractId: 'contract_old', itemId: 'si_old', featureCodes: ['LOYALTY_PROGRAM'], priceId: 'p', amount: '599.00' }],
      })
      inventory.mockResolvedValue({
        vivas: [{ subscriptionId: 'sub_hybrid', proyecciones: [{ tipo: 'PAQUETE', featureCodes: ['LOYALTY_PROGRAM'] }] }],
        detalle: { sub_hybrid: { customerId: 'cus_test', terminaEn: null } },
        conCambiosProgramados: [],
      })
      const pro = plan('PRO')
      prismaMock.hybridOfferPublication.findMany.mockResolvedValue([
        { ...loyaltyAt(1158.84), name: 'Pro', definition: pro.definition, includedFeatureCodes: pro.includedFeatureCodes },
      ])
      const quote = await createHybridQuote('venue', 'staff', replace)
      expect(quote.quote).toMatchObject({ replaces: ['sub_hybrid'] })
      expect(quote.quote).not.toHaveProperty('repriced')
    })

    it('a hybrid Pro replaced by a Premium line shows no repriced function', async () => {
      const premium = plan('PREMIUM')
      prismaMock.hybridOfferPublication.findMany.mockResolvedValue([
        {
          ...loyaltyAt(1970.84),
          name: 'Premium',
          definition: premium.definition,
          includedFeatureCodes: premium.includedFeatureCodes,
        },
      ])
      const quote = await createHybridQuote('venue', 'staff', replace)
      expect(quote.quote).toMatchObject({ replaces: ['sub_hybrid'], droppedFeatureCodes: [] })
      expect(quote.quote).not.toHaveProperty('repriced')
    })

    it('a hybrid Pro dropped to Free keeping one function as a list line shows no repriced function', async () => {
      prismaMock.hybridOfferPublication.findMany.mockResolvedValue([loyaltyAt(699)])
      const dropFeatureCodes = proCodes.filter(code => code !== 'LOYALTY_PROGRAM' && code !== 'CHATBOT')
      const quote = await createHybridQuote('venue', 'staff', { ...replace, dropFeatureCodes })
      expect(quote.quote).toMatchObject({ featureCodes: ['LOYALTY_PROGRAM'], droppedFeatureCodes: dropFeatureCodes })
      expect(quote.quote).not.toHaveProperty('repriced')
    })
  })
})
