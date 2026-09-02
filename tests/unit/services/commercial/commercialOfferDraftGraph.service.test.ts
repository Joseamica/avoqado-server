import { loadCommercialOfferDraftGraphV3 } from '@/services/commercial/offers/commercialOfferDraftGraph.service'

const parent = {
  id: 'draft-1',
  code: 'SUMMER_2026',
  name: 'Summer 2026',
  description: null,
  revision: 2,
  offerSchemaVersion: 3,
  status: 'ACTIVE' as const,
  startsAt: new Date('2026-08-01T06:00:00.000Z'),
  endsAt: new Date('2026-09-01T06:00:00.000Z'),
  allowedRuleCodeGroups: null,
  allowedRuleCodeGroupsKind: 'SQL_NULL',
  stackingGroups: [],
  stackingGroupsKind: 'array',
  transactionIsolation: 'repeatable read',
  createdAt: new Date('2026-07-31T06:00:00.000Z'),
  updatedAt: new Date('2026-07-31T06:00:00.000Z'),
}
const rule = {
  code: 'POS_FIXED_50',
  type: 'FIXED_PRICE' as const,
  priority: 100,
  target: { productCodes: ['POS'] },
  amountMinor: 5000n,
  percentBasisPoints: null,
  cycles: 3,
}
const fixedBenefit = {
  benefitCode: 'HARDWARE_N62_FIXED',
  kind: 'HARDWARE_FIXED_PRICE' as const,
  priority: 50,
  hardwareCatalogKey: 'NEXGO_N62',
  percentBasisPoints: null,
  unitAmountMinor: 150000n,
  quantityLimit: 2,
  benefitStartsAt: new Date('2026-08-01T06:00:00.000Z'),
  benefitEndsAt: new Date('2026-09-01T06:00:00.000Z'),
  paymentsRateScheduleVersionId: null,
}

function graphTx(parentRow: any = parent, benefits: any[] = [fixedBenefit]) {
  return {
    $queryRaw: jest.fn(async () => [parentRow]),
    commercialCampaignRuleDraft: { findMany: jest.fn(async () => [rule]) },
    commercialOfferBenefitDraft: { findMany: jest.fn(async () => benefits) },
  }
}

describe('Commercial Offer v3 draft graph', () => {
  it('projects exact SaaS money and normalized non-SaaS benefits from Prisma storage', async () => {
    const result = await loadCommercialOfferDraftGraphV3(graphTx() as never, parent.id, { consistency: 'SNAPSHOT' })
    expect(result).toMatchObject({
      id: parent.id,
      revision: 2,
      offerSchemaVersion: 3,
      rules: [expect.objectContaining({ code: 'POS_FIXED_50', amount: '50.00' })],
      offerBenefits: [
        {
          benefitCode: 'HARDWARE_N62_FIXED',
          kind: 'HARDWARE_FIXED_PRICE',
          priority: 50,
          hardwareCatalogKey: 'NEXGO_N62',
          unitAmountMinor: '150000',
          quantityLimit: 2,
          benefitStartsAt: '2026-08-01T06:00:00.000Z',
          benefitEndsAt: '2026-09-01T06:00:00.000Z',
        },
      ],
    })
  })

  it('rejects v2, corrupt provenance and insufficient snapshot isolation before reading children', async () => {
    const cases = [
      graphTx({ ...parent, offerSchemaVersion: 2 }),
      graphTx({ ...parent, stackingGroupsKind: 'object' }),
      graphTx({ ...parent, transactionIsolation: 'read committed' }),
    ]
    for (const tx of cases) {
      await expect(loadCommercialOfferDraftGraphV3(tx as never, parent.id, { consistency: 'SNAPSHOT' })).rejects.toBeDefined()
      expect(tx.commercialCampaignRuleDraft.findMany).not.toHaveBeenCalled()
      expect(tx.commercialOfferBenefitDraft.findMany).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['non-bigint fixed amount', { ...fixedBenefit, unitAmountMinor: 150000 }],
    ['mixed discriminants', { ...fixedBenefit, percentBasisPoints: 1000 }],
    ['unknown SKU', { ...fixedBenefit, hardwareCatalogKey: 'UNKNOWN' }],
    ['inverted window', { ...fixedBenefit, benefitEndsAt: fixedBenefit.benefitStartsAt }],
  ])('rejects %s as invalid storage', async (_label, stored) => {
    await expect(loadCommercialOfferDraftGraphV3(graphTx(parent, [stored]) as never, parent.id, { consistency: 'FOR_UPDATE' })).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_DRAFT_STORAGE_INVALID',
    })
  })
})
