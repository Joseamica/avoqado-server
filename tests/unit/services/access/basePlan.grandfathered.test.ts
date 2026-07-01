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
import {
  venueHasFeatureAccess,
  venueIsGrandfathered,
  venueIsExemptFromPlanGating,
  DEMO_VENUE_STATUSES,
  PREMIUM_ONLY_CODES,
} from '../../../../src/services/access/basePlan.service'

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

describe('venueIsExemptFromPlanGating — grandfathered OR demo-status', () => {
  it.each(DEMO_VENUE_STATUSES.map(s => [s]))('true for a demo venue (status %s) even when NOT grandfathered', async status => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status })
    expect(await venueIsExemptFromPlanGating('v')).toBe(true)
  })

  it('true for a grandfathered venue regardless of status', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })
    expect(await venueIsExemptFromPlanGating('v')).toBe(true)
  })

  it.each([['ACTIVE'], ['ONBOARDING'], ['PENDING_ACTIVATION'], ['SUSPENDED'], ['ADMIN_SUSPENDED'], ['CLOSED']])(
    'false for a non-grandfathered venue with production status %s',
    async status => {
      venueFindUnique.mockResolvedValue({ seatCapExempt: false, status })
      expect(await venueIsExemptFromPlanGating('v')).toBe(false)
    },
  )

  it('false when the venue does not exist', async () => {
    venueFindUnique.mockResolvedValue(null)
    expect(await venueIsExemptFromPlanGating('v')).toBe(false)
  })
})

describe('venueHasFeatureAccess — demo short-circuit (path 0, same as grandfathered)', () => {
  it.each(DEMO_VENUE_STATUSES.map(s => [s]))(
    '%s venue → ANY feature code = true, with NO grant and NO base plan, before any VenueFeature lookup',
    async status => {
      venueFindUnique.mockResolvedValue({ seatCapExempt: false, status })
      vfFindFirst.mockResolvedValue(null)

      expect(await venueHasFeatureAccess('v', 'RESERVATIONS')).toBe(true)
      expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(true)
      expect(vfFindFirst).not.toHaveBeenCalled()
    },
  )
})

/**
 * Catalog mirror (plan-catalog.ts ←→ basePlan.service): FREE_TIER_CODES are promised to every
 * venue (even with no plan), and the EXPANDED PREMIUM_ONLY_CODES are never blanket-granted to PRO.
 */
describe('catalog mirror: FREE_TIER_CODES + expanded PREMIUM_ONLY_CODES', () => {
  const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

  it('venue with NO plan → CHATBOT (free promise) = true, but AVAILABLE_BALANCE (now PRO) = false', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    vfFindFirst.mockResolvedValue(null)
    vfFindMany.mockResolvedValue([])

    expect(await venueHasFeatureAccess('v', 'CHATBOT')).toBe(true)
    // AVAILABLE_BALANCE was moved out of FREE_TIER_CODES to PRO — a no-plan venue must NOT get it.
    expect(await venueHasFeatureAccess('v', 'AVAILABLE_BALANCE')).toBe(false)
  })

  it('PRO venue → the 4 newly-premium-only catalog codes are NOT blanket-granted', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    vfFindFirst.mockResolvedValue(null)
    vfFindMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])

    for (const code of ['SERIALIZED_INVENTORY', 'TRANSACTION_EXPORT', 'COMMISSIONS', 'ATTENDANCE_TRACKING']) {
      expect(await venueHasFeatureAccess('v', code)).toBe(false)
    }
    // ...while regular Pro-tier features stay blanket-granted.
    expect(await venueHasFeatureAccess('v', 'RESERVATIONS')).toBe(true)
  })

  it('PREMIUM venue → premium-only catalog codes ARE granted', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    vfFindFirst.mockResolvedValue(null)
    vfFindMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PREMIUM' } }])

    expect(await venueHasFeatureAccess('v', 'SERIALIZED_INVENTORY')).toBe(true)
    expect(await venueHasFeatureAccess('v', 'TRANSACTION_EXPORT')).toBe(true)
  })
})
