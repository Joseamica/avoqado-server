/**
 * Tier/plan gating for MCP tools (2026-06-09): paid capabilities resolve through
 * venueHasFeatureAccess (grandfathered → all · explicit grant → yes ·
 * PREMIUM → all · PRO → all but premium-only · FREE → grants only).
 * Here: the helper's both paths + a real tool denying with planRequired:true.
 */
import { planGateMessage } from '../../../src/mcp/planGate'
import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'

const mockHasAccess = jest.fn()

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockHasAccess(...(a as [])),
  venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ adjustPoints: jest.fn(), updateLoyaltyConfig: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { loyaltyConfig: { findFirst: jest.fn() }, customer: { findMany: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('planGateMessage (helper)', () => {
  it('returns null when the venue is entitled', async () => {
    mockHasAccess.mockResolvedValueOnce(true)
    expect(await planGateMessage('v1', 'LOYALTY_PROGRAM', 'El programa de lealtad')).toBeNull()
    expect(mockHasAccess).toHaveBeenCalledWith('v1', 'LOYALTY_PROGRAM')
  })

  it('returns a friendly upsell message (with the feature code) when not entitled', async () => {
    mockHasAccess.mockResolvedValueOnce(false)
    const msg = await planGateMessage('v1', 'LOYALTY_PROGRAM', 'El programa de lealtad')
    expect(msg).toMatch(/LOYALTY_PROGRAM/)
    expect(msg).toMatch(/plan/)
  })
})

describe('a gated tool on a FREE venue', () => {
  it('loyalty_status returns planRequired:true and reads NOTHING when not entitled', async () => {
    mockHasAccess.mockResolvedValue(false) // FREE venue, no grant
    const out = parse(await handlers.get('loyalty_status')!({ venueId: 'v1' }, {}))
    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.error).toMatch(/LOYALTY_PROGRAM/)
  })

  it('loyalty_status works normally when entitled', async () => {
    mockHasAccess.mockResolvedValue(true) // PRO+ (or explicit grant / grandfathered)
    const out = parse(await handlers.get('loyalty_status')!({ venueId: 'v1' }, {}))
    expect(out.planRequired).toBeUndefined()
    expect(out).toHaveProperty('configured')
  })
})
