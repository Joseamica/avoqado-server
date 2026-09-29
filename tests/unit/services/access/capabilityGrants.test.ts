import prisma from '@/utils/prismaClient'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import {
  elPlanConcede,
  getVenueGrantedFeatureCodes,
  getVenuePlanInfo,
  venueHasFeatureAccess,
  venuesWithFeatureAccess,
} from '@/services/access/basePlan.service'

const db = prisma as any

describe('commercial grants by source', () => {
  beforeEach(() => {
    db.venue.findUnique.mockResolvedValue({ id: 'v1', status: 'ACTIVE', seatCapExempt: false, organization: { seatCapExempt: false } })
    db.venue.findMany.mockResolvedValue([])
    db.venueFeature.findFirst.mockResolvedValue(null)
    db.venueFeature.findMany.mockResolvedValue([])
    // The DB is the boundary: actual resolver/union logic remains real.
    db.capabilityGrant = { findFirst: jest.fn().mockResolvedValue(null), groupBy: jest.fn().mockResolvedValue([]) }
  })

  it('a paid package grants its feature without granting a paid tier', async () => {
    db.capabilityGrant.findFirst.mockImplementation(async ({ where }: any) =>
      where.venueId === 'v1' && where.featureCode === 'CFDI' ? { id: 'grant1' } : null,
    )
    await expect(venueHasFeatureAccess('v1', 'CFDI')).resolves.toBe(true)
    await expect(venueHasFeatureAccess('v1', 'INVENTORY_TRACKING')).resolves.toBe(false)
    await expect(venueHasFeatureAccess('v1', 'PLAN_PREMIUM')).resolves.toBe(false)
  })

  it('only consults current, non-revoked coverage belonging to this venue', async () => {
    await venueHasFeatureAccess('v1', 'CFDI')
    expect(db.capabilityGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: 'v1',
          featureCode: 'CFDI',
          revokedAt: null,
          startsAt: { lte: expect.any(Date) },
          endsAt: { gt: expect.any(Date) },
        }),
      }),
    )
  })

  it('unions legacy and commercial sources without returning prices or duplicate codes', async () => {
    db.venueFeature.findMany.mockResolvedValue([{ feature: { code: 'CFDI' } }])
    db.capabilityGrant.groupBy.mockResolvedValue([{ featureCode: 'CFDI' }, { featureCode: 'LOYALTY_PROGRAM' }])
    await expect(getVenueGrantedFeatureCodes('v1')).resolves.toEqual(['CFDI', 'LOYALTY_PROGRAM'])
  })

  it('the multi-venue gate includes package grants with the same validity and tenant filters', async () => {
    db.capabilityGrant.groupBy.mockResolvedValue([{ venueId: 'v2' }])
    await expect(venuesWithFeatureAccess(['v1', 'v2'], 'CFDI')).resolves.toEqual(new Set(['v2']))
    expect(db.capabilityGrant.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['venueId'],
        where: expect.objectContaining({ venueId: { in: ['v1', 'v2'] }, revokedAt: null, endsAt: { gt: expect.any(Date) } }),
      }),
    )
  })

  it('the mobile/TPV plan snapshot carries effective purchase codes without inflating the tier', async () => {
    db.capabilityGrant.groupBy.mockResolvedValue([{ featureCode: 'CFDI' }])
    const plan = await getVenuePlanInfo('v1')
    expect(plan).toMatchObject({ tier: 'FREE', exempt: false, grantedFeatureCodes: ['CFDI', 'CHATBOT'], accessSchemaVersion: 1 })
    expect(Number.isNaN(Date.parse((plan as any).accessObservedAt))).toBe(false)
  })

  it.each(['PRO', 'PREMIUM'] as const)('%s cannot grant a future unknown capability by fallback', tier => {
    expect(elPlanConcede(tier, 'FUTURE_NOT_PUBLISHED')).toBe(false)
  })

  it('the HTTP gate admits the package without a legacy VenueFeature', async () => {
    db.staffVenue.findFirst.mockResolvedValue(null)
    db.capabilityGrant.findFirst.mockResolvedValue({ id: 'grant1' })
    const req = { authContext: { userId: 'staff', venueId: 'v1' }, params: { venueId: 'v1' }, headers: {} } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()
    await checkFeatureAccess('CFDI')(req, res, next)
    expect(next).toHaveBeenCalledWith()
    expect(res.status).not.toHaveBeenCalled()
  })

  describe('legacy regressions', () => {
    it('preserves existing plan inclusions', () => {
      expect(elPlanConcede('PRO', 'PROMOTIONS')).toBe(true)
      expect(elPlanConcede('PRO', 'AREA_TICKETS')).toBe(true)
      expect(elPlanConcede('PRO', 'INVENTORY_TRACKING')).toBe(false)
      expect(elPlanConcede('PREMIUM', 'INVENTORY_TRACKING')).toBe(true)
    })
    it('a second source keeps the feature after the first source is revoked', async () => {
      db.venueFeature.findFirst.mockResolvedValue({ active: true, suspendedAt: null, endDate: null })
      await expect(venueHasFeatureAccess('v1', 'CFDI')).resolves.toBe(true)
      db.venueFeature.findFirst.mockResolvedValue({ active: false, suspendedAt: new Date(), endDate: null })
      db.capabilityGrant.findFirst.mockResolvedValue({ id: 'remaining-origin' })
      await expect(venueHasFeatureAccess('v1', 'CFDI')).resolves.toBe(true)
    })
  })
})
