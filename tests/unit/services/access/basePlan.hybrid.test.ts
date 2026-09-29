import { getFeatureMetadataForVenue } from '@/services/access/feature-metadata.service'
import { prismaMock } from '../../../__helpers__/setup'
import { getVenueBaseTier, getVenuePlanInfo, venueHasFeatureAccess } from '@/services/access/basePlan.service'
beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({ status: 'ACTIVE', seatCapExempt: false, organization: { seatCapExempt: false } })
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.venueFeature.findFirst.mockResolvedValue(null)
  prismaMock.capabilityGrant.findFirst.mockImplementation(async ({ where }: any) =>
    where.contract ? { contract: { planTier: 'PREMIUM' } } : where.featureCode === 'CFDI' ? { id: 'grant' } : null,
  )
  prismaMock.hybridContract.findFirst.mockResolvedValue({ planTier: 'PREMIUM' })
  prismaMock.capabilityGrant.groupBy.mockResolvedValue([{ featureCode: 'CFDI' }])
})
describe('commercial plans keep tier identity separate from frozen inclusions', () => {
  it('keeps billing ownership visible while a commercial plan has no funded access', async () => {
    prismaMock.capabilityGrant.findFirst.mockResolvedValue(null)
    prismaMock.capabilityGrant.groupBy.mockResolvedValue([])
    await expect(getVenuePlanInfo('venue')).resolves.toMatchObject({ tier: 'FREE', commercialPlanTier: 'PREMIUM' })
  })
  it('exposes the paid tier for seats and clients while honoring only its granted capabilities', async () => {
    await expect(getVenueBaseTier('venue')).resolves.toBe('PREMIUM')
    await expect(venueHasFeatureAccess('venue', 'CFDI')).resolves.toBe(true)
    await expect(venueHasFeatureAccess('venue', 'INVENTORY_TRACKING')).resolves.toBe(false)
  })
  it('sends a complete versioned access snapshot including free and legacy tier coverage', async () => {
    prismaMock.venueFeature.findMany.mockImplementation(async ({ where }: any) =>
      where.feature.code.in ? [{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }] : [],
    )
    const info = await getVenuePlanInfo('venue')
    expect(info).toMatchObject({ accessSchemaVersion: 1, tier: 'PREMIUM', commercialPlanTier: 'PREMIUM' })
    expect(info.grantedFeatureCodes).toEqual(expect.arrayContaining(['CHATBOT', 'CFDI', 'LOYALTY_PROGRAM', 'PRICE_LABELS']))
    expect(info.grantedFeatureCodes).not.toContain('INVENTORY_TRACKING')
  })
  it('a plan contract whose cancellation already took effect is no longer the commercial plan', async () => {
    await getVenuePlanInfo('venue')
    expect(prismaMock.hybridContract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ endedAt: null, OR: [{ cancelAt: null }, { cancelAt: { gt: expect.any(Date) } }] }),
      }),
    )
  })
})

it('feature metadata agrees with the exact grants, not the commercial tier label', async () => {
  prismaMock.feature.findMany.mockResolvedValue(
    ['CFDI', 'INVENTORY_TRACKING'].map(code => ({ code, name: code, monthlyPrice: '379.50', stripePriceId: 'price_test' })),
  )
  const metadata = await getFeatureMetadataForVenue('venue')
  expect(metadata.CFDI.state).toBe('ACTIVE')
  expect(metadata.INVENTORY_TRACKING.state).toBe('LOCKED')
})
