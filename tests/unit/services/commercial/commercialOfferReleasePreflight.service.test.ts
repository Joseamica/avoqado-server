import {
  CommercialOfferReleasePreflightError,
  assertNoProhibitedCommercialOfferV3Q3AReferences,
  countAllowedCommercialOfferV3Q3BReferences,
  countProhibitedCommercialOfferV3Q3AReferences,
  createCommercialOfferReleasePreflightService,
  type CommercialOfferV3AllowedQ3BReferences,
  type CommercialOfferV3ProhibitedQ3BReferences,
  type CommercialOfferReleasePreflightTransaction,
  type CommercialOfferV3ProhibitedReferences,
} from '@/services/commercial/offers/commercialOfferReleasePreflight.service'

const allowed = { offerControlEvents: 2, directQuotes: 3, directQuoteAcceptances: 1 }
const prohibited: CommercialOfferV3ProhibitedReferences = {
  campaignActivations: 0,
  campaignClaims: 0,
  acquisitionContexts: 0,
  legacyCampaignLinkedQuotes: 0,
  invalidOfferQuoteShapes: 0,
  previewBridges: 0,
  stripeOperations: 0,
  subscriptionEvents: 0,
}
const allowedQ3B: CommercialOfferV3AllowedQ3BReferences = {
  offerControlEvents: 2,
  dedicatedClaims: 3,
  pinnedAcquisitionContexts: 2,
  acquisitionBindings: 1,
  directQuotes: 4,
  bridgedQuotes: 2,
  previewBridges: 2,
  quoteAcceptances: 3,
  acquisitionRedemptions: 1,
}
const prohibitedQ3B: CommercialOfferV3ProhibitedQ3BReferences = {
  campaignActivations: 0,
  legacyCampaignClaims: 0,
  legacyAcquisitionContexts: 0,
  legacyCampaignLinkedQuotes: 0,
  invalidOfferQuoteShapes: 0,
  stripeOperations: 0,
  subscriptionEvents: 0,
  entitlementEffects: 0,
  hardwareOrderEffects: 0,
}

function harness(
  prohibitedReferences: CommercialOfferV3ProhibitedReferences = prohibited,
  prohibitedQ3BReferences: CommercialOfferV3ProhibitedQ3BReferences = prohibitedQ3B,
  schemaPhase: 'Q3A' | 'Q3B' = 'Q3B',
) {
  const tx = {
    readSchemaPhase: jest.fn(async () => schemaPhase),
    countPublishedV3Versions: jest.fn(async () => 3),
    countAllowedQ3AReferences: jest.fn(async () => allowed),
    countProhibitedQ3AReferences: jest.fn(async () => prohibitedReferences),
    countAllowedQ3BReferences: jest.fn(async () => allowedQ3B),
    countProhibitedQ3BReferences: jest.fn(async () => prohibitedQ3BReferences),
  }
  const runInRepeatableRead = jest.fn(async operation => operation(tx))
  return {
    service: createCommercialOfferReleasePreflightService({
      now: () => new Date('2026-08-29T18:00:00.000Z'),
      runInRepeatableRead,
    } as never),
    tx,
    runInRepeatableRead,
  }
}

describe('Commercial Offer v3 Q3-A release preflight', () => {
  describe('behavior', () => {
    it('reports populated allowed Q3-A buckets and zero prohibited buckets in one repeatable-read snapshot', async () => {
      const { service, tx, runInRepeatableRead } = harness()
      const receipt = await service.run()

      expect(receipt).toEqual({
        status: 'PASS',
        schemaVersion: 3,
        publishedVersions: 3,
        q3a: { allowed, prohibited },
        q3b: { allowed: allowedQ3B, prohibited: prohibitedQ3B },
        checkedAt: '2026-08-29T18:00:00.000Z',
      })
      expect(runInRepeatableRead).toHaveBeenCalledTimes(1)
      expect(tx.countPublishedV3Versions).toHaveBeenCalledTimes(1)
      expect(tx.countAllowedQ3AReferences).toHaveBeenCalledTimes(1)
      expect(tx.countProhibitedQ3AReferences).toHaveBeenCalledTimes(1)
      expect(Object.isFrozen(receipt)).toBe(true)
      expect(Object.isFrozen(receipt.q3a)).toBe(true)
      expect(Object.isFrozen(receipt.q3a.allowed)).toBe(true)
      expect(Object.isFrozen(receipt.q3a.prohibited)).toBe(true)
      const q3b = (receipt as { q3b?: { allowed: unknown; prohibited: unknown } }).q3b
      if (!q3b) throw new Error('COMMERCIAL_OFFER_V3_Q3B_RECEIPT_EXPECTED')
      expect(Object.isFrozen(q3b)).toBe(true)
      expect(Object.isFrozen(q3b.allowed)).toBe(true)
      expect(Object.isFrozen(q3b.prohibited)).toBe(true)
    })

    it('keeps the historical Q3-A receipt usable without touching Q3-B tables or columns', async () => {
      const { service, tx } = harness(prohibited, prohibitedQ3B, 'Q3A')

      await expect(service.run()).resolves.toEqual({
        status: 'PASS',
        schemaVersion: 3,
        publishedVersions: 3,
        q3a: { allowed, prohibited },
        checkedAt: '2026-08-29T18:00:00.000Z',
      })
      expect(tx.countAllowedQ3BReferences).not.toHaveBeenCalled()
      expect(tx.countProhibitedQ3BReferences).not.toHaveBeenCalled()
    })

    it('counts every allowed Q3-B lineage bucket explicitly', async () => {
      const count = jest.fn(async () => 0)
      const tx = {
        commercialOfferControlEvent: { count },
        commercialCampaignClaim: { count },
        commercialAcquisitionContext: { count },
        commercialAcquisitionContextBinding: { count },
        commercialQuote: { count },
        commercialQuotePreviewBridge: { count },
        commercialQuoteAcceptance: { count },
        commercialAcquisitionRedemption: { count },
      }

      await expect(countAllowedCommercialOfferV3Q3BReferences(tx as never)).resolves.toEqual({
        offerControlEvents: 0,
        dedicatedClaims: 0,
        pinnedAcquisitionContexts: 0,
        acquisitionBindings: 0,
        directQuotes: 0,
        bridgedQuotes: 0,
        previewBridges: 0,
        quoteAcceptances: 0,
        acquisitionRedemptions: 0,
      })
      expect(count).toHaveBeenCalledTimes(9)
    })
  })

  describe('regression', () => {
    it('classifies every Offer-linked quote outside the exact schema-3 direct shape, including schema 1/2 rows', async () => {
      const count = jest.fn(async () => 0)
      const quoteCount = jest.fn(async (_input: unknown) => 0)
      const tx = {
        commercialCampaignActivation: { count },
        commercialCampaignClaim: { count },
        commercialAcquisitionContext: { count },
        commercialQuote: { count: quoteCount },
        commercialQuotePreviewBridge: { count },
        commercialStripeOperation: { count },
        commercialSubscriptionEvent: { count },
      }

      await countProhibitedCommercialOfferV3Q3AReferences(tx as never)

      const invalidShapeCall = quoteCount.mock.calls
        .map(([input]) => input as { where: Record<string, unknown> })
        .find(input => input.where.offerVersionId)
      if (!invalidShapeCall) throw new Error('COMMERCIAL_Q3A_INVALID_SHAPE_QUERY_NOT_OBSERVED')
      expect(invalidShapeCall.where).not.toHaveProperty('schemaVersion')
      expect(invalidShapeCall.where).toMatchObject({
        offerVersionId: { not: null },
        commercialQuotePreviewBridge: { is: null },
      })
      expect(invalidShapeCall.where.OR).toEqual(
        expect.arrayContaining([
          { schemaVersion: { not: 3 } },
          { offerSchemaVersion: { not: 3 } },
          { offerSchemaVersion: null },
          { campaignVersionId: { not: null } },
          { acquisitionContextId: { not: null } },
          { organizationId: null },
          { venueId: null },
          { createdById: null },
        ]),
      )
    })

    it.each(Object.keys(prohibited) as Array<keyof CommercialOfferV3ProhibitedReferences>)(
      'fails closed when the prohibited %s bucket is populated',
      async key => {
        const references = { ...prohibited, [key]: 1 }
        expect(() => assertNoProhibitedCommercialOfferV3Q3AReferences(references)).toThrow(
          CommercialOfferReleasePreflightError,
        )
        try {
          assertNoProhibitedCommercialOfferV3Q3AReferences(references)
          throw new Error('EXPECTED_Q3A_PREFLIGHT_REJECTION')
        } catch (error) {
          expect(error).toMatchObject({
            code: 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3A_REFERENCE',
            references,
          })
        }
      },
    )

    it.each(Object.keys(prohibitedQ3B) as Array<keyof CommercialOfferV3ProhibitedQ3BReferences>)(
      'fails closed when the prohibited Q3-B %s bucket is populated',
      async key => {
        const references = { ...prohibitedQ3B, [key]: 1 }
        const { service } = harness(prohibited, references)

        await expect(service.run()).rejects.toBeInstanceOf(CommercialOfferReleasePreflightError)
        await expect(service.run()).rejects.toMatchObject({
          code: 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3B_REFERENCE',
          references,
        })
      },
    )

    it('does not translate infrastructure failures into a false business diagnosis', async () => {
      const infrastructureFailure = new Error('connection closed')
      const service = createCommercialOfferReleasePreflightService({
        now: () => new Date('2026-08-29T18:00:00.000Z'),
        runInRepeatableRead: async <T>(operation: (tx: CommercialOfferReleasePreflightTransaction) => Promise<T>) =>
          operation({
            readSchemaPhase: async () => 'Q3B',
            countPublishedV3Versions: async () => 0,
            countAllowedQ3AReferences: async () => allowed,
            countProhibitedQ3AReferences: async () => {
              throw infrastructureFailure
            },
            countAllowedQ3BReferences: async () => allowedQ3B,
            countProhibitedQ3BReferences: async () => prohibitedQ3B,
          }),
      })
      await expect(service.run()).rejects.toBe(infrastructureFailure)
    })
  })
})
