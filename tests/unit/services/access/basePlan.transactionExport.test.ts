/**
 * TRANSACTION_EXPORT is a PREMIUM-only differentiator (detailed sales export).
 * PLAN_PREMIUM venues get it; PLAN_PRO venues do NOT (unless they hold their own
 * active VenueFeature grant). Mirrors basePlan.tierAware.test.ts mocking style.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))
import prisma from '../../../../src/utils/prismaClient'
import { venueHasFeatureAccess, PREMIUM_ONLY_CODES } from '../../../../src/services/access/basePlan.service'

const findFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const findMany = (prisma as any).venueFeature.findMany as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const ACTIVE = { active: true, suspendedAt: null, endDate: null }

function codeFilter(where: any): { single?: string; list?: string[] } {
  const code = where?.feature?.code
  if (typeof code === 'string') return { single: code }
  if (code && Array.isArray(code.in)) return { list: code.in }
  return {}
}

/** Describe a non-grandfathered venue with a single active tier row (PLAN_PRO or PLAN_PREMIUM). */
function mockTierVenue(tierCode: string) {
  venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, status: 'ACTIVE' })
  findFirst.mockResolvedValue(null) // no own grant for TRANSACTION_EXPORT
  findMany.mockImplementation(async ({ where }: any) => {
    const { list } = codeFilter(where)
    if (list && list.includes(tierCode)) return [{ ...ACTIVE, feature: { code: tierCode } }]
    return []
  })
}

beforeEach(() => jest.clearAllMocks())

describe('TRANSACTION_EXPORT premium gating', () => {
  it('is registered as a Premium-only differentiator', () => {
    expect(PREMIUM_ONLY_CODES).toContain('TRANSACTION_EXPORT')
  })

  it('grants TRANSACTION_EXPORT to a PLAN_PREMIUM venue', async () => {
    mockTierVenue('PLAN_PREMIUM')
    await expect(venueHasFeatureAccess('v1', 'TRANSACTION_EXPORT')).resolves.toBe(true)
  })

  it('denies TRANSACTION_EXPORT to a PLAN_PRO venue with no own grant', async () => {
    mockTierVenue('PLAN_PRO')
    await expect(venueHasFeatureAccess('v1', 'TRANSACTION_EXPORT')).resolves.toBe(false)
  })
})
