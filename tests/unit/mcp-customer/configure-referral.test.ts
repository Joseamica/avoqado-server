import { registerReferralTools } from '../../../src/mcp/tools/referrals'
import type { McpScope } from '../../../src/mcp/scope'
import { ReferralRewardType } from '@prisma/client'

const mockActivate = jest.fn()
const mockUpdate = jest.fn()
const mockDeactivate = jest.fn()
const mockAudit = jest.fn()
const mockFindUnique = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing referral:configure')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/referrals/referralProgram.service', () => ({
  activateReferralProgram: (...a: unknown[]) => mockActivate(...(a as [])),
  updateReferralConfig: (...a: unknown[]) => mockUpdate(...(a as [])),
  deactivateReferralProgram: (...a: unknown[]) => mockDeactivate(...(a as [])),
}))
jest.mock('@/services/referrals/referralReads.service', () => ({ getReferralSummary: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { referralProgramConfig: { findUnique: (...a: unknown[]) => mockFindUnique(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('configure_referral')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerReferralTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('configure_referral — permission + plan-gate enforcement', () => {
  it('rejects a venue outside the caller scope (ScopeError) before touching the DB', async () => {
    await expect(call({ venueId: 'foreign', active: false })).rejects.toThrow('out of scope')
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks referral:configure', async () => {
    await expect(call({ venueId: 'no-perm', active: false })).rejects.toThrow('Forbidden')
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('blocked by the REFERRAL_PROGRAM plan gate returns planRequired:true and writes NOTHING', async () => {
    const { planGateMessage } = jest.requireMock('@/mcp/planGate') as { planGateMessage: jest.Mock }
    planGateMessage.mockResolvedValueOnce('El programa de referidos no está incluido en el plan actual (requiere REFERRAL_PROGRAM).')
    const out = parse(await call({ venueId: 'v1', rewardCouponExpiryDays: 60 }))
    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.error).toMatch(/REFERRAL_PROGRAM/)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockActivate).not.toHaveBeenCalled()
    expect(mockDeactivate).not.toHaveBeenCalled()
  })
})

describe('configure_referral — happy paths', () => {
  it('editing settings on an already-active program calls updateReferralConfig and audits REFERRAL_CONFIG_UPDATED', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 'cfg1',
      active: true,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'ABC',
    })
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true }) // post-update refetch

    const out = parse(await call({ venueId: 'v1', rewardCouponExpiryDays: 60 }))

    expect(mockUpdate).toHaveBeenCalledWith({ venueId: 'v1', patch: { rewardCouponExpiryDays: 60 }, tiers: undefined })
    expect(mockActivate).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledTimes(1)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'REFERRAL_CONFIG_UPDATED',
      entity: 'ReferralProgramConfig',
      entityId: 'cfg1',
      venueId: 'v1',
    })
    expect(out).toMatchObject({ ok: true, program: { active: true } })
  })

  it('editing tiers only (no scalar patch) still calls updateReferralConfig with the tiers array', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })

    const tiers = [{ tierLevel: 1 as const, rewardType: ReferralRewardType.PERCENT_COUPON, rewardPercent: 15 }]
    await call({ venueId: 'v1', tiers })

    expect(mockUpdate).toHaveBeenCalledWith({ venueId: 'v1', patch: {}, tiers })
  })

  it('rejects an empty edit (no scalar fields, no tiers) without calling the service', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('first-time activation (no existing config) requires the core fields', async () => {
    mockFindUnique.mockResolvedValueOnce(null) // existing check
    const out = parse(await call({ venueId: 'v1', active: true }))
    expect(out.ok).toBe(false)
    expect(mockActivate).not.toHaveBeenCalled()
  })

  it('first-time activation with all core fields calls activateReferralProgram and audits REFERRAL_CONFIG_UPDATED', async () => {
    mockFindUnique.mockResolvedValueOnce(null) // existing check
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true }) // post-activation refetch

    const tiers = [{ tierLevel: 1 as const, rewardType: ReferralRewardType.PERCENT_COUPON, rewardPercent: 15 }]
    const out = parse(
      await call({
        venueId: 'v1',
        active: true,
        newCustomerDiscountPercent: 10,
        tier1ReferralsRequired: 7,
        tier2ReferralsRequired: 12,
        tier3ReferralsRequired: 20,
        rewardCouponExpiryDays: 90,
        tiers,
      }),
    )

    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        newCustomerDiscountPercent: 10,
        tier1ReferralsRequired: 7,
        tier2ReferralsRequired: 12,
        tier3ReferralsRequired: 20,
        rewardCouponExpiryDays: 90,
        tiers,
      }),
    )
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'REFERRAL_CONFIG_UPDATED', entity: 'ReferralProgramConfig', venueId: 'v1' })
    expect(out).toMatchObject({ ok: true, program: { active: true } })
  })

  it('re-activating a paused program defaults omitted core fields from the current row', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 'cfg1',
      active: false,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'ABC',
    })
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })

    await call({ venueId: 'v1', active: true }) // no scalar fields passed at all

    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        newCustomerDiscountPercent: 10,
        tier1ReferralsRequired: 7,
        tier2ReferralsRequired: 12,
        tier3ReferralsRequired: 20,
        rewardCouponExpiryDays: 90,
        codePrefix: 'ABC',
      }),
    )
  })

  it('active:false deactivates an existing program (default reason) and audits', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })

    const out = parse(await call({ venueId: 'v1', active: false }))

    expect(mockDeactivate).toHaveBeenCalledWith({ venueId: 'v1', reason: 'Desactivado vía MCP' })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'REFERRAL_CONFIG_UPDATED',
      entity: 'ReferralProgramConfig',
      entityId: 'cfg1',
      venueId: 'v1',
    })
    expect(out).toMatchObject({ ok: true, program: { active: false } })
  })

  it('active:false with an explicit reason forwards it', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })
    await call({ venueId: 'v1', active: false, reason: 'fraude detectado' })
    expect(mockDeactivate).toHaveBeenCalledWith({ venueId: 'v1', reason: 'fraude detectado' })
  })

  it('active:false with no existing config returns an error and does not call the service', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1', active: false }))
    expect(out.ok).toBe(false)
    expect(mockDeactivate).not.toHaveBeenCalled()
  })

  it('surfaces a service validation error as text({ ok:false }) instead of throwing', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'cfg1', active: true })
    mockUpdate.mockRejectedValueOnce(new Error('Tier requirements must be ascending: tier2 > tier1'))
    const out = parse(await call({ venueId: 'v1', tier2ReferralsRequired: 1 }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ascending/)
  })
})
