/**
 * Tier-aware base-plan access (PLAN_PRO vs PLAN_PREMIUM).
 *
 * PLAN_PREMIUM unlocks ALL non-tier features. PLAN_PRO unlocks all non-tier features EXCEPT the
 * Premium-only differentiators (PREMIUM_ONLY_CODES). A venue's OWN active VenueFeature for a code
 * always grants it (grandfather), regardless of tier.
 *
 * Self-contained prisma mock (mirrors basePlan.test.ts style): we route findFirst/findMany by the
 * `feature.code` filter in the `where` so a single test can describe a whole venue's plan state.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // venue.findUnique is consumed by venueIsGrandfathered (path-0 short-circuit in
    // venueHasFeatureAccess). These tier-logic tests describe NON-grandfathered venues, so it
    // defaults to seatCapExempt: false (see beforeEach) — the short-circuit stays dormant and
    // the tier path is exercised. Grandfathered behavior has its own suite (basePlan.grandfathered.test.ts).
    venue: { findUnique: jest.fn(), findMany: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))
import prisma from '../../../../src/utils/prismaClient'
import {
  getVenueBaseTier,
  venueHasFeatureAccess,
  venuesWithFeatureAccess,
  venueHasActiveBasePlan,
  PREMIUM_ONLY_CODES,
  PAID_PLAN_TIER_CODES,
} from '../../../../src/services/access/basePlan.service'

const findFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const findMany = (prisma as any).venueFeature.findMany as jest.Mock

const future = new Date(Date.now() + 86_400_000)
const past = new Date(Date.now() - 86_400_000)
const ACTIVE = { active: true, suspendedAt: null, endDate: null }

/** Extract the `feature.code` (string or `{ in: [...] }`) being queried from a prisma `where`. */
function codeFilter(where: any): { single?: string; list?: string[] } {
  const code = where?.feature?.code
  if (typeof code === 'string') return { single: code }
  if (code && Array.isArray(code.in)) return { list: code.in }
  return {}
}

const PREMIUM_FEATURE = PREMIUM_ONLY_CODES[0] // 'CFDI'
const PRO_FEATURE = 'LOYALTY_PROGRAM' // a normal (non-Premium-only) feature

beforeEach(() => jest.clearAllMocks())

/**
 * Configure the mock for a SINGLE venue whose tier feature rows are described by `tierRows`
 * (the PLAN_* rows the venue has) and whose own à-la-carte rows are described by `ownRows`
 * (keyed by feature code). Drives both findFirst (own feature lookup) and findMany (tier scan).
 */
function mockVenue(tierRows: Array<{ code: string; row: any }>, ownRows: Record<string, any> = {}) {
  findFirst.mockImplementation(async ({ where }: any) => {
    const { single } = codeFilter(where)
    if (single && ownRows[single]) return ownRows[single]
    // venueHasActiveBasePlan does findFirst over the tier `in` list:
    const { list } = codeFilter(where)
    if (list) {
      const match = tierRows.find(t => list.includes(t.code))
      return match ? match.row : null
    }
    return null
  })
  findMany.mockImplementation(async ({ where }: any) => {
    const { list, single } = codeFilter(where)
    if (list) return tierRows.filter(t => list.includes(t.code)).map(t => ({ ...t.row, feature: { code: t.code } }))
    if (single) {
      const t = tierRows.find(t => t.code === single)
      return t ? [{ ...t.row, feature: { code: single } }] : []
    }
    return []
  })
}

describe('PREMIUM_ONLY_CODES / PAID_PLAN_TIER_CODES catalog', () => {
  it('includes both paid tiers', () => {
    expect([...PAID_PLAN_TIER_CODES]).toEqual(['PLAN_PRO', 'PLAN_PREMIUM'])
  })
  it('CFDI is a Premium-only differentiator', () => {
    expect([...PREMIUM_ONLY_CODES]).toContain('CFDI')
  })
})

describe('getVenueBaseTier', () => {
  it('returns PREMIUM when active PLAN_PREMIUM', async () => {
    mockVenue([{ code: 'PLAN_PREMIUM', row: ACTIVE }])
    expect(await getVenueBaseTier('v')).toBe('PREMIUM')
  })
  it('returns PRO when active PLAN_PRO only', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }])
    expect(await getVenueBaseTier('v')).toBe('PRO')
  })
  it('PREMIUM wins when both active', async () => {
    mockVenue([
      { code: 'PLAN_PRO', row: ACTIVE },
      { code: 'PLAN_PREMIUM', row: ACTIVE },
    ])
    expect(await getVenueBaseTier('v')).toBe('PREMIUM')
  })
  it('returns null when no plan', async () => {
    mockVenue([])
    expect(await getVenueBaseTier('v')).toBeNull()
  })
  it('ignores a suspended PLAN_PREMIUM but honors active PLAN_PRO', async () => {
    mockVenue([
      { code: 'PLAN_PREMIUM', row: { active: false, suspendedAt: new Date(), endDate: null } },
      { code: 'PLAN_PRO', row: ACTIVE },
    ])
    expect(await getVenueBaseTier('v')).toBe('PRO')
  })
  it('returns null when the only plan trial is expired', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: { active: true, suspendedAt: null, endDate: past } }])
    expect(await getVenueBaseTier('v')).toBeNull()
  })
})

describe('venueHasActiveBasePlan covers either tier', () => {
  it('true for active PLAN_PREMIUM', async () => {
    mockVenue([{ code: 'PLAN_PREMIUM', row: ACTIVE }])
    expect(await venueHasActiveBasePlan('v')).toBe(true)
  })
  it('true for active PLAN_PRO', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }])
    expect(await venueHasActiveBasePlan('v')).toBe(true)
  })
  it('false with no plan', async () => {
    mockVenue([])
    expect(await venueHasActiveBasePlan('v')).toBe(false)
  })
})

describe('venueHasFeatureAccess', () => {
  it('Pro venue → normal Pro feature = true', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }])
    expect(await venueHasFeatureAccess('v', PRO_FEATURE)).toBe(true)
  })

  it('Pro venue → Premium-only feature (CFDI) = false', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }])
    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(false)
  })

  it('Premium venue → Premium-only feature (CFDI) = true', async () => {
    mockVenue([{ code: 'PLAN_PREMIUM', row: ACTIVE }])
    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(true)
  })

  it('Premium venue → normal feature = true', async () => {
    mockVenue([{ code: 'PLAN_PREMIUM', row: ACTIVE }])
    expect(await venueHasFeatureAccess('v', PRO_FEATURE)).toBe(true)
  })

  it('Grandfathered: explicit active CFDI grant on a PLAN_PRO venue → true (explicit wins)', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }], { [PREMIUM_FEATURE]: ACTIVE })
    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(true)
  })

  it('Grandfathered: explicit active CFDI grant with NO base plan → true', async () => {
    mockVenue([], { [PREMIUM_FEATURE]: { active: true, suspendedAt: null, endDate: future } })
    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(true)
  })

  it('No-plan venue → Premium-only feature = false', async () => {
    mockVenue([])
    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(false)
  })

  it('No-plan venue → normal feature = false', async () => {
    mockVenue([])
    expect(await venueHasFeatureAccess('v', PRO_FEATURE)).toBe(false)
  })

  it('tier code itself (PLAN_PRO) is not self-granted by the blanket', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }])
    expect(await venueHasFeatureAccess('v', 'PLAN_PRO')).toBe(false)
  })

  it('tier code IS granted when the venue owns it as an active VenueFeature', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }], { PLAN_PRO: ACTIVE })
    expect(await venueHasFeatureAccess('v', 'PLAN_PRO')).toBe(true)
  })

  it('expired own CFDI grant on a Pro venue does NOT leak Premium-only access', async () => {
    mockVenue([{ code: 'PLAN_PRO', row: ACTIVE }], { [PREMIUM_FEATURE]: { active: true, suspendedAt: null, endDate: past } })
    expect(await venueHasFeatureAccess('v', PREMIUM_FEATURE)).toBe(false)
  })
})

describe('venuesWithFeatureAccess (batch) mirrors single-venue results', () => {
  // A mixed cohort: pro, premium, none, grandfathered (own CFDI grant, no/low plan).
  const ALL = ['vPro', 'vPremium', 'vNone', 'vGrand']

  /**
   * Batch mock: findMany is called up to 3 times by venuesWithFeatureAccess —
   * (1) own feature rows for the code, (2) active PLAN_PREMIUM, (3) active PLAN_PRO.
   * We answer each by inspecting the `feature.code` filter.
   */
  function mockBatch(opts: { code: string; ownGrants: string[]; premium: string[]; pro: string[]; exempt?: string[] }) {
    const exempt = opts.exempt ?? []
    // venuesWithFeatureAccess now fetches seatCapExempt+status FIRST (the exemption short-circuit).
    ;(prisma as any).venue.findMany.mockResolvedValue(ALL.map(id => ({ id, seatCapExempt: exempt.includes(id), status: 'ACTIVE' })))
    findMany.mockImplementation(async ({ where }: any) => {
      const { single } = codeFilter(where)
      if (single === opts.code) return opts.ownGrants.map(venueId => ({ venueId }))
      if (single === 'PLAN_PREMIUM') return opts.premium.map(venueId => ({ venueId }))
      if (single === 'PLAN_PRO') return opts.pro.map(venueId => ({ venueId }))
      return []
    })
  }

  it('normal feature: Pro + Premium entitled, grandfathered entitled, none excluded', async () => {
    mockBatch({ code: PRO_FEATURE, ownGrants: ['vGrand'], premium: ['vPremium'], pro: ['vPro'] })
    const set = await venuesWithFeatureAccess(ALL, PRO_FEATURE)
    expect(set).toEqual(new Set(['vPro', 'vPremium', 'vGrand']))
  })

  it('Premium-only feature (CFDI): only Premium + grandfathered entitled; Pro excluded', async () => {
    // For CFDI the Pro query must NOT run / must NOT entitle. Even if a stray PLAN_PRO row exists,
    // the function skips the Pro query for premium-only codes.
    mockBatch({ code: PREMIUM_FEATURE, ownGrants: ['vGrand'], premium: ['vPremium'], pro: ['vPro'] })
    const set = await venuesWithFeatureAccess(ALL, PREMIUM_FEATURE)
    expect(set).toEqual(new Set(['vPremium', 'vGrand']))
    expect(set.has('vPro')).toBe(false)
    expect(set.has('vNone')).toBe(false)
  })

  it('tier code is only entitled by an own grant, never blanket', async () => {
    mockBatch({ code: 'PLAN_PRO', ownGrants: ['vPro'], premium: ['vPremium'], pro: ['vPro'] })
    const set = await venuesWithFeatureAccess(ALL, 'PLAN_PRO')
    expect(set).toEqual(new Set(['vPro']))
  })

  it('empty input → empty set, no queries', async () => {
    findMany.mockClear()
    const set = await venuesWithFeatureAccess([], PRO_FEATURE)
    expect(set.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('GRANDFATHERED (seatCapExempt) with NO own grant and NO base plan → entitled for ANY code', async () => {
    // Regression (prod MCP incident 2026-06-16): a grandfathered PlayTelecom venue (seatCapExempt
    // true, no PLAN_PRO/PLAN_PREMIUM row, no own grant) was told sales_comparison "requiere plan PRO"
    // — because the BATCH venuesWithFeatureAccess skipped the exemption the single venueHasFeatureAccess
    // applies. It must now entitle exempt venues for ANY feature, like the single version.
    mockBatch({ code: PRO_FEATURE, ownGrants: [], premium: [], pro: [], exempt: ['vGrand'] })
    expect((await venuesWithFeatureAccess(ALL, PRO_FEATURE)).has('vGrand')).toBe(true)
    // ...and even for a Premium-only differentiator (exempt = every feature, no paywall ever).
    mockBatch({ code: PREMIUM_FEATURE, ownGrants: [], premium: [], pro: [], exempt: ['vGrand'] })
    expect((await venuesWithFeatureAccess(ALL, PREMIUM_FEATURE)).has('vGrand')).toBe(true)
    // a NON-exempt venue with no plan/grant stays excluded (control — gate still works).
    mockBatch({ code: PRO_FEATURE, ownGrants: [], premium: [], pro: [], exempt: [] })
    expect((await venuesWithFeatureAccess(ALL, PRO_FEATURE)).has('vNone')).toBe(false)
  })
})
