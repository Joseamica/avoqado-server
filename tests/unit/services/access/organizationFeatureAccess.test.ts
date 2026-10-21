import { prismaMock } from '../../../__helpers__/setup'
import { organizationHasFeatureAccess } from '@/services/access/basePlan.service'

describe('organization capability access is a scoped existence query', () => {
  beforeEach(() => jest.clearAllMocks())
  it('denies an organization with no entitled venue, without hydrating its branches', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    expect(await organizationHasFeatureAccess('org-a', 'TABLE_SERVICE')).toBe(false)
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
    expect(prismaMock.venue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a' }), select: { id: true } }),
    )
  })
  it('uses Pro and Premium for TABLE_SERVICE with active-window and hybrid grants', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'paid' })
    expect(await organizationHasFeatureAccess('org-a', 'TABLE_SERVICE')).toBe(true)
    const where = prismaMock.venue.findFirst.mock.calls[0][0].where
    expect(where.OR).toContainEqual(
      expect.objectContaining({
        features: {
          some: expect.objectContaining({
            feature: { code: { in: ['TABLE_SERVICE', 'PLAN_PRO', 'PLAN_PREMIUM'] } },
            active: true,
            suspendedAt: null,
          }),
        },
      }),
    )
    expect(where.OR).toContainEqual(
      expect.objectContaining({ capabilityGrants: { some: expect.objectContaining({ featureCode: 'TABLE_SERVICE', revokedAt: null }) } }),
    )
  })
  it('does not blanket-grant a Premium-only capability from Pro', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    await organizationHasFeatureAccess('org-b', 'CFDI')
    expect(prismaMock.venue.findFirst.mock.calls[0][0].where.OR).toContainEqual(
      expect.objectContaining({ features: { some: expect.objectContaining({ feature: { code: { in: ['CFDI', 'PLAN_PREMIUM'] } } }) } }),
    )
  })
  it('includes organization/venue grandfathering and demo statuses in the same scoped lookup', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'grandfathered' })
    await organizationHasFeatureAccess('org-a', 'TABLE_SERVICE')
    const where = prismaMock.venue.findFirst.mock.calls[0][0].where
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { seatCapExempt: true },
        { organization: { seatCapExempt: true } },
        { status: { in: ['LIVE_DEMO', 'TRIAL'] } },
      ]),
    )
  })
})
