import { registerReferralTools } from '../../../src/mcp/tools/referrals'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindUnique = jest.fn()
const mockSummary = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing referral:read')
    },
  }),
}))
jest.mock('@/services/referrals/referralProgram.service', () => ({
  activateReferralProgram: jest.fn(),
  updateReferralConfig: jest.fn(),
  deactivateReferralProgram: jest.fn(),
}))
jest.mock('@/services/referrals/referralReads.service', () => ({
  getReferralSummary: (...a: unknown[]) => mockSummary(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { referralProgramConfig: { findUnique: (...a: unknown[]) => mockFindUnique(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('referral_status')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const emptySummary = {
  referralsThisMonth: 0,
  referralsPrevMonth: 0,
  conversionRate: 0,
  qualifiedThisMonth: 0,
  pendingThisMonth: 0,
  couponsEmittedThisMonth: 0,
  topReferrer: null,
}

beforeAll(() => {
  registerReferralTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockSummary.mockResolvedValue(emptySummary)
})

describe('referral_status', () => {
  // ---- NEW FEATURE TESTS ----------------------------------------------------
  it('rejects a venue outside the caller scope', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('rejects when missing referral:read permission', async () => {
    await expect(call({ venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('blocked by the REFERRAL_PROGRAM plan gate returns planRequired:true and reads NOTHING', async () => {
    const { planGateMessage } = jest.requireMock('@/mcp/planGate') as { planGateMessage: jest.Mock }
    planGateMessage.mockResolvedValueOnce('El programa de referidos no está incluido en el plan actual (requiere REFERRAL_PROGRAM).')
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.error).toMatch(/REFERRAL_PROGRAM/)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('returns configured:false / program:null when no program exists (read never creates one)', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.configured).toBe(false)
    expect(out.program).toBeNull()
    expect(out.summaryThisMonth).toEqual(emptySummary)
  })

  it('returns program settings + tier rewards + this-month summary when configured', async () => {
    mockFindUnique.mockResolvedValueOnce({
      active: true,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'MINDF',
      tierRewards: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', recurrence: 'ONE_TIME', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
      ],
    })
    mockSummary.mockResolvedValueOnce({
      referralsThisMonth: 5,
      referralsPrevMonth: 3,
      conversionRate: 0.4,
      qualifiedThisMonth: 2,
      pendingThisMonth: 3,
      couponsEmittedThisMonth: 2,
      topReferrer: { id: 'c1', firstName: 'Ana', lastName: 'López', referralCount: 8, referralTier: 2 },
    })

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.configured).toBe(true)
    expect(out.program).toMatchObject({
      active: true,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'MINDF',
    })
    expect(out.program.tierRewards).toEqual([
      { tierLevel: 1, rewardType: 'PERCENT_COUPON', recurrence: 'ONE_TIME', rewardPercent: 15, rewardProductId: null, rewardQuantity: 1 },
    ])
    expect(out.summaryThisMonth).toMatchObject({ referralsThisMonth: 5, referralsPrevMonth: 3, conversionRate: 0.4 })
    expect(out.summaryThisMonth.topReferrer).toEqual({ name: 'Ana López', referralCount: 8, referralTier: 2 })
  })

  // ---- REGRESSION: doesn't affect sibling loyalty tools ----------------------
  it('does not register any loyalty tool under this module', () => {
    expect(handlers.has('loyalty_status')).toBe(false)
    expect(handlers.has('configure_loyalty')).toBe(false)
  })
})
