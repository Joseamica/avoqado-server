/**
 * Grandfathered short-circuit (path 0) of venueHasFeatureAccess.
 *
 * A GRANDFATHERED venue (Venue.seatCapExempt === true) is exempt from EVERY feature paywall —
 * it operates as it did before tier monetization. venueHasFeatureAccess must return true for ANY
 * feature code (including a Premium-only differentiator like CFDI) with NO own VenueFeature grant
 * and NO active base plan, BEFORE the tier logic runs. This guards the legacy-venue invariant.
 *
 * Self-contained prisma mock (mirrors basePlan.tierAware.test.ts) — we additionally mock
 * venue.findUnique so venueIsGrandfathered (path 0) is exercised.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))
import prisma from '../../../../src/utils/prismaClient'
import { venueHasFeatureAccess, venueIsGrandfathered, PREMIUM_ONLY_CODES } from '../../../../src/services/access/basePlan.service'

const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock

const PREMIUM_FEATURE = PREMIUM_ONLY_CODES[0] // 'CFDI'

beforeEach(() => jest.clearAllMocks())

describe('venueIsGrandfathered', () => {
  it('true when seatCapExempt === true', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true })
    expect(await venueIsGrandfathered('v')).toBe(true)
  })
  it('false when seatCapExempt === false', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false })
    expect(await venueIsGrandfathered('v')).toBe(false)
  })
  it('false when the venue does not exist', async () => {
    venueFindUnique.mockResolvedValue(null)
    expect(await venueIsGrandfathered('v')).toBe(false)
  })
})

describe('venueHasFeatureAccess — grandfathered short-circuit (path 0)', () => {
  it('grandfathered venue → Premium-only code (CFDI) = true, with NO grant and NO base plan', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true }) // grandfathered
    // No own VenueFeature grant; no base plan.
    vfFindFirst.mockResolvedValue(null)

    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(true)
    // The short-circuit must fire BEFORE any VenueFeature lookup.
    expect(vfFindFirst).not.toHaveBeenCalled()
  })

  it('grandfathered venue → arbitrary feature code = true (full access, no paywall)', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true })
    vfFindFirst.mockResolvedValue(null)

    expect(await venueHasFeatureAccess('v', 'SOME_RANDOM_FEATURE')).toBe(true)
    expect(vfFindFirst).not.toHaveBeenCalled()
  })

  it('NON-grandfathered, no plan, no grant → Premium-only code = false (control)', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false })
    // No own grant for the code; base-plan lookups return null/empty → no tier.
    vfFindFirst.mockResolvedValue(null)
    ;((prisma as any).venueFeature.findMany as jest.Mock).mockResolvedValue([])

    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(false)
  })
})
