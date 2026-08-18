/**
 * GRANDFATHERING INHERITED FROM THE ORGANIZATION.
 *
 * A venue is grandfathered when ITS OWN `Venue.seatCapExempt` is true **or** when its
 * `Organization.seatCapExempt` is true. The org-level flag is what makes a legacy/white-label
 * client's brand-new stores exempt the moment they are created, instead of each one being born
 * on the Free seat cap until someone notices (the PlayTelecom incident: the seat-cap migration
 * backfilled every venue that existed at rollout, so the 6 stores opened afterwards silently
 * inherited nothing and blocked the third promoter invite).
 *
 * This mirrors how `Module` gating already works — `isModuleEnabled` falls back to
 * `OrganizationModule` — so both gating systems now answer "who does this apply to?" the same way.
 *
 * Mocking mirrors basePlan.tierAware.test.ts: prismaClient is fully mocked and venueFeature
 * queries are routed by their `feature.code` filter.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn(), findMany: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import {
  venueIsGrandfathered,
  venueIsExemptFromPlanGating,
  getVenuePlanInfo,
  venueHasFeatureAccess,
  venuesWithFeatureAccess,
  PREMIUM_ONLY_CODES,
} from '../../../../src/services/access/basePlan.service'

const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const venueFindMany = (prisma as any).venue.findMany as jest.Mock
const featureFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const featureFindMany = (prisma as any).venueFeature.findMany as jest.Mock

/** A Premium-only differentiator — the hardest code to be entitled to without a plan. */
const PREMIUM_FEATURE = PREMIUM_ONLY_CODES[0]

/**
 * Shape a `venue.findUnique` result the way the service selects it: the venue's own flag, its
 * status, and the parent organization's flag.
 */
function venueRow(opts: { own?: boolean; org?: boolean; status?: string }) {
  return {
    seatCapExempt: opts.own ?? false,
    status: opts.status ?? 'ACTIVE',
    organization: { seatCapExempt: opts.org ?? false },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  // Default: the venue holds no plan of its own. Tests that need one override it.
  featureFindFirst.mockResolvedValue(null)
  featureFindMany.mockResolvedValue([])
})

describe('Grandfathering inherited from the organization', () => {
  // ─── NEW BEHAVIOR: the org flag exempts every venue under it ───

  it('venueIsGrandfathered: an exempt ORGANIZATION grandfathers a venue that carries no flag', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: false, org: true }))
    await expect(venueIsGrandfathered('v1')).resolves.toBe(true)
  })

  it('venueIsExemptFromPlanGating: an exempt ORGANIZATION exempts a plain ACTIVE venue', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: false, org: true, status: 'ACTIVE' }))
    await expect(venueIsExemptFromPlanGating('v1')).resolves.toBe(true)
  })

  it('getVenuePlanInfo: reports grandfathered + exempt when only the ORGANIZATION is flagged', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: false, org: true }))
    const info = await getVenuePlanInfo('v1')
    expect(info.grandfathered).toBe(true)
    expect(info.exempt).toBe(true)
    // No paid base plan exists → the tier itself is still FREE; exemption is the separate axis.
    expect(info.tier).toBe('FREE')
  })

  it('venueHasFeatureAccess: an exempt ORGANIZATION grants even a PREMIUM-only code with no plan', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: false, org: true }))
    await expect(venueHasFeatureAccess('v1', PREMIUM_FEATURE)).resolves.toBe(true)
  })

  it('venuesWithFeatureAccess: entitles the venues whose ORGANIZATION is exempt, and only those', async () => {
    venueFindMany.mockResolvedValue([
      { id: 'orgExempt', seatCapExempt: false, status: 'ACTIVE', organization: { seatCapExempt: true } },
      { id: 'ownExempt', seatCapExempt: true, status: 'ACTIVE', organization: { seatCapExempt: false } },
      { id: 'plain', seatCapExempt: false, status: 'ACTIVE', organization: { seatCapExempt: false } },
    ])

    const entitled = await venuesWithFeatureAccess(['orgExempt', 'ownExempt', 'plain'], PREMIUM_FEATURE)

    expect(entitled.has('orgExempt')).toBe(true)
    expect(entitled.has('ownExempt')).toBe(true)
    expect(entitled.has('plain')).toBe(false)
  })

  // ─── REGRESSION: everything that worked before must keep working ───

  it('still grandfathers a venue by its OWN flag when the organization is not exempt', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: true, org: false }))
    await expect(venueIsGrandfathered('v1')).resolves.toBe(true)
    await expect(venueIsExemptFromPlanGating('v1')).resolves.toBe(true)
  })

  it('still refuses to grandfather when NEITHER the venue nor its organization is exempt', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: false, org: false }))
    await expect(venueIsGrandfathered('v1')).resolves.toBe(false)
    await expect(venueIsExemptFromPlanGating('v1')).resolves.toBe(false)
    await expect(venueHasFeatureAccess('v1', PREMIUM_FEATURE)).resolves.toBe(false)
  })

  it('still exempts a DEMO venue by status even when neither flag is set', async () => {
    venueFindUnique.mockResolvedValue(venueRow({ own: false, org: false, status: 'LIVE_DEMO' }))
    await expect(venueIsExemptFromPlanGating('v1')).resolves.toBe(true)
    // Demo status is NOT grandfathering — the two reasons stay distinguishable.
    await expect(venueIsGrandfathered('v1')).resolves.toBe(false)
  })

  it('still returns false for a venue that does not exist', async () => {
    venueFindUnique.mockResolvedValue(null)
    await expect(venueIsGrandfathered('missing')).resolves.toBe(false)
    await expect(venueIsExemptFromPlanGating('missing')).resolves.toBe(false)

    const info = await getVenuePlanInfo('missing')
    expect(info).toEqual({ tier: 'FREE', grandfathered: false, exempt: false })
  })

  it('tolerates a venue row with no organization attached (defensive: never throws)', async () => {
    venueFindUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE', organization: null })
    await expect(venueIsGrandfathered('v1')).resolves.toBe(false)
    await expect(venueIsExemptFromPlanGating('v1')).resolves.toBe(false)
  })
})
